import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  browseDirectory,
  exportDirectoryCSV,
  validateDirectory,
  validateRelationships,
} from "@/insijets/directory";
import { DirectoryStore } from "@/insijets/directory-store";
import {
  directoryResponse,
  type DirectoryConfiguration,
} from "@/insijets/directory-api";
import type { AuthSession } from "@/auth/types";
const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL("../fixtures/insijets-directory.synthetic.json", import.meta.url),
      "utf8",
    ),
  );
const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(path.join(tmpdir(), "insijets-directory-"));
  roots.push(value);
  return value;
};
afterEach(() =>
  roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })),
);
const session: AuthSession = {
  provider: "local",
  user: {
    id: "fixture-david",
    name: "Fixture David",
    email: "operator@example.invalid",
  },
  tenant: { id: "insijets-demo", name: "InsiJets" },
  expiresAt: new Date(Date.now() + 60000).toISOString(),
};
const config = (): DirectoryConfiguration => ({
  installationId: "insijets-demo",
  origin: "https://brain.example.test",
  dataRoot: root(),
  enabled: true,
  importsEnabled: true,
  exportsEnabled: true,
  allowSynthetic: true,
});
const request = (operation = "", body?: unknown) =>
  new Request("https://brain.example.test/api/insijets/directory" + operation, {
    ...(body
      ? {
          method: "POST",
          headers: {
            origin: "https://brain.example.test",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }
      : {}),
  });
describe("public InsiJets directory", () => {
  it("keeps global framing denial and scopes the framework exception to the authenticated CMS prefix", async () => {
    const configuration = (await import("../../next.config")).default;
    const rules = await configuration.headers!();
    expect(
      rules[0].headers.find((h) => h.key === "X-Frame-Options")?.value,
    ).toBe("DENY");
    const cms = rules.at(-1)!;
    expect(cms.source).toBe("/api/insijets/cms/:path*");
    expect(cms.headers.find((h) => h.key === "X-Frame-Options")?.value).toBe(
      "SAMEORIGIN",
    );
    expect(
      cms.headers.find((h) => h.key === "Content-Security-Policy")?.value,
    ).toContain("frame-ancestors 'self'");
  });
  it("rejects synthetic production data, missing provenance, duplicate IDs, non-public contacts and invalid relationships", () => {
    expect(() => validateDirectory(fixture())).toThrow("synthetic");
    for (const change of [
      (d: any) => delete d.aircraft[0].sourceURL,
      (d: any) => d.aircraft.push({ ...d.aircraft[0] }),
      (d: any) => (d.contacts[0].published = false),
      (d: any) =>
        (d.contacts[0].email = "a@example.com\nBcc:other@example.com"),
      (d: any) => (d.operators[0].sourceURL = "https://evil.test/"),
    ]) {
      const d = fixture();
      change(d);
      expect(() => validateDirectory(d, true)).toThrow();
    }
    const d = fixture();
    d.contacts[0].baseId = "demo-base-3";
    expect(() => validateRelationships(d)).toThrow("association");
  });
  it("retains distinct aircraft, duplicate email occurrences, missing values and base/aircraft contact scope", () => {
    const d = validateDirectory(fixture(), true);
    validateRelationships(d);
    const all = browseDirectory(d);
    expect(all.counts).toMatchObject({
      aircraft: 4,
      operators: 3,
      uniqueEmails: 2,
      repeatedEmails: 1,
      aircraftWithoutEmails: 1,
    });
    expect(
      all.rows.find((r) => r.id === "demo-aircraft-1")!.contacts,
    ).toHaveLength(2);
    expect(
      all.rows.find((r) => r.id === "demo-aircraft-2")!.contacts,
    ).toHaveLength(1);
    expect(
      all.rows.find((r) => r.id === "demo-aircraft-3")!.contacts[0].email,
    ).toContain("milan@");
    expect(browseDirectory(d, { country: "Spain", minSeats: 8 }).total).toBe(2);
    expect(browseDirectory(d, { minSeats: 1 }).total).toBe(3);
    expect(browseDirectory(d, { view: "operators" }).recordTotal).toBe(3);
    expect(
      browseDirectory(d, { view: "bases", country: "Italy" }).recordTotal,
    ).toBe(1);
    expect(
      browseDirectory(d, { view: "contacts", country: "Spain" }).recordTotal,
    ).toBe(2);
  });
  it("keeps an explicitly unknown contact scope out of every aircraft while preserving it for the operator", () => {
    const d = fixture();
    d.contacts.push({
      id: "unknown-scope",
      operatorId: "demo-op-1",
      scope: "unknown",
      email: "unknown@example.invalid",
      published: true,
      professional: true,
      sourceURL: "https://example.invalid/unknown",
      checkedAt: "2026-10-13T09:00:00Z",
    });
    validateDirectory(d, true);
    validateRelationships(d);
    expect(
      browseDirectory(d)
        .rows.flatMap((r) => r.contacts)
        .some((c) => c.id === "unknown-scope"),
    ).toBe(false);
    expect(
      browseDirectory(d, { view: "operators" })
        .records.find((r) => r.id === "demo-op-1")!
        .contacts.some((c) => c.id === "unknown-scope"),
    ).toBe(true);
    delete d.contacts.at(-1).scope;
    expect(() => validateDirectory(d, true)).toThrow("scope");
  });
  it("imports atomically and idempotently, preserves omitted records/raw fields/versions and survives reopen", () => {
    const dataRoot = root(),
      d = fixture();
    let store = new DirectoryStore(dataRoot, true);
    expect(store.import(d, "fixture", 0)).toMatchObject({
      revision: 1,
      inserted: 16,
    });
    expect(store.import(d, "fixture", 0)).toMatchObject({
      repeated: true,
      revision: 1,
    });
    const changed = fixture();
    changed.aircraft = changed.aircraft.slice(0, 1);
    changed.aircraft[0].seats = 9;
    expect(store.import(changed, "fixture", 1)).toMatchObject({
      revision: 2,
      updated: 1,
    });
    expect(store.snapshot().dataset.aircraft).toHaveLength(4);
    expect(
      store.db.prepare("SELECT COUNT(*) AS n FROM versions").get()!.n,
    ).toBe(1);
    expect(
      store.db
        .prepare("SELECT original_dataset FROM imports WHERE revision=1")
        .get()!.original_dataset,
    ).toBe(JSON.stringify(d));
    const bad = fixture();
    bad.aircraft[0].baseId = "missing";
    expect(() => store.import(bad, "fixture", 2)).toThrow();
    expect(store.snapshot().revision).toBe(2);
    expect(() =>
      store.import({ ...changed, coverage: [] }, "fixture", 1),
    ).toThrow("changed");
    store.close();
    store = new DirectoryStore(dataRoot, true);
    expect(store.snapshot().dataset.aircraft[0].listingOperatorName).toBe(
      "Demo Meridian Charter",
    );
    store.close();
  });
  it("performs no store read for unauthenticated, foreign, expired, demo or unapproved actors", async () => {
    const c = config();
    let opens = 0;
    const open = () => {
      opens++;
      return new DirectoryStore(c.dataRoot, true);
    };
    for (const denied of [
      null,
      { ...session, provider: "demo" },
      { ...session, tenant: { id: "g03", name: "Other" } },
      { ...session, user: { ...session.user, email: "member@example.invalid" } },
      { ...session, expiresAt: "2020-01-01" },
    ] as (AuthSession | null)[])
      expect([401, 403]).toContain(
        (await directoryResponse(request(), "browse", c, denied, open)).status,
      );
    expect(
      (
        await directoryResponse(
          request(),
          "browse",
          { ...c, installationId: "arnall" },
          session,
          open,
        )
      ).status,
    ).toBe(403);
    expect(opens).toBe(0);
  });
  it("requires same-origin, operator flags, actor and concrete per-action confirmations", async () => {
    const c = config(),
      body = {
        dataset: fixture(),
        confirmation: "IMPORT PUBLIC DIRECTORY",
        expectedRevision: 0,
      };
    expect(
      (
        await directoryResponse(
          request("/import", body),
          "import",
          { ...c, importsEnabled: false },
          session,
        )
      ).status,
    ).toBe(403);
    const luca = {
      ...session,
      user: { ...session.user, email: "cms-owner@example.invalid" },
    };
    expect(
      (await directoryResponse(request("/import", body), "import", c, luca))
        .status,
    ).toBe(403);
    expect(
      (
        await directoryResponse(
          new Request(
            "https://brain.example.test/api/insijets/directory/import",
            {
              method: "POST",
              headers: {
                origin: "https://evil.test",
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            },
          ),
          "import",
          c,
          session,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await directoryResponse(
          request("/import", { ...body, confirmation: "approved" }),
          "import",
          c,
          session,
        )
      ).status,
    ).toBe(400);
    expect(
      (await directoryResponse(request("/import", body), "import", c, session))
        .status,
    ).toBe(200);
    expect((await directoryResponse(request(), "browse", c, luca)).status).toBe(
      200,
    );
    const exp = {
      kind: "aircraft",
      ids: ["demo-aircraft-1"],
      expectedRevision: 1,
      confirmation: "EXPORT SELECTED PUBLIC DATA",
    };
    expect(
      (
        await directoryResponse(
          request("/export", exp),
          "export",
          { ...c, exportsEnabled: false },
          session,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await directoryResponse(
          request("/export", { ...exp, expectedRevision: 0 }),
          "export",
          c,
          session,
        )
      ).status,
    ).toBe(409);
    const response = await directoryResponse(
      request("/export", exp),
      "export",
      c,
      luca,
    );
    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(csv).toContain("demo-aircraft-1");
    expect(csv).not.toContain("demo-aircraft-2");
    expect(csv).toContain("originalRecordJSON");
  });
  it("rejects unknown/duplicate/oversized filters and guards Excel formulas without losing originals", async () => {
    const c = config();
    for (const query of [
      "token=private",
      "page=-1",
      "limit=101",
      "country=Spain&country=Italy",
      "view=users",
    ])
      expect(
        (
          await directoryResponse(
            new Request(
              "https://brain.example.test/api/insijets/directory?" + query,
            ),
            "browse",
            c,
            session,
          )
        ).status,
      ).toBe(400);
    const d = fixture();
    d.operators[0].name = "=malicious()";
    const csv = exportDirectoryCSV(d, "operators");
    expect(csv).toContain("'=malicious()");
    expect(csv).toContain("originalRecordJSON");
  });
});
