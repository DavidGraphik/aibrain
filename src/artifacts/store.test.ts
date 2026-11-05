import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderArtifactHtml } from "@/artifacts/rendering";
import { AdvancedArtifactNotFoundError, AdvancedArtifactPersistenceError, FileAdvancedArtifactStore } from "@/artifacts/store";

vi.mock("server-only", () => ({}));

const roots: string[] = [];
const userA = "0198b9f0-6631-7000-8000-000000000201";
const userB = "0198b9f0-6631-7000-8000-000000000202";
const source = {
  projectId: "0198b9f0-6631-7000-8000-000000000203",
  threadId: "0198b9f0-6631-7000-8000-000000000204",
  messageId: "0198b9f0-6631-7000-8000-000000000205",
  messageSha256: "c".repeat(64),
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-advanced-artifacts-"));
  roots.push(root);
  await Promise.all([mkdir(path.join(root, userA), { mode: 0o700 }), mkdir(path.join(root, userB), { mode: 0o700 })]);
  return { root, store: new FileAdvancedArtifactStore({ rootDirectory: root, installationId: "artifact-test" }) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileAdvancedArtifactStore", () => {
  it("keeps users isolated and versions as immutable snapshots", async () => {
    const { root, store } = await fixture();
    const created = await store.create(userA, {
      title: "Informe interno",
      source,
      content: { kind: "internal-site", html: "<article><p>Versión uno</p></article>" },
    });
    const firstPath = path.join(root, userA, "state", "advanced-artifacts", created.summary.id, "versions", "1.json");
    const firstBytes = await readFile(firstPath, "utf8");
    await expect(store.get(userB, created.summary.id)).rejects.toBeInstanceOf(AdvancedArtifactNotFoundError);
    const otherTenant = new FileAdvancedArtifactStore({ rootDirectory: root, installationId: "other-tenant" });
    await expect(otherTenant.get(userA, created.summary.id)).rejects.toBeInstanceOf(AdvancedArtifactPersistenceError);

    const updated = await store.createVersion(userA, created.summary.id, {
      source: { ...source, messageId: "0198b9f0-6631-7000-8000-000000000206", messageSha256: "d".repeat(64) },
      content: { kind: "internal-site", html: "<article><p>Versión dos</p></article>" },
    });
    expect(updated.snapshot.version).toBe(2);
    expect(await readFile(firstPath, "utf8")).toBe(firstBytes);
    expect((await store.get(userA, created.summary.id, 1)).snapshot.content).toMatchObject({ html: expect.stringContaining("Versión uno") });
  });

  it("publishes one authenticated immutable snapshot per version and verifies its hash", async () => {
    const { store } = await fixture();
    const created = await store.create(userA, {
      title: "Gráfico regional",
      source,
      content: {
        kind: "visualization",
        spec: {
          chartType: "bar", title: "Margen", xLabel: "Región", yLabel: "%",
          series: [{ name: "Margen", color: null }], rows: [{ label: "Norte", values: [24.5] }],
        },
      },
    });
    const first = await store.publish(userA, created.summary.id, renderArtifactHtml);
    const repeated = await store.publish(userA, created.summary.id, renderArtifactHtml);
    expect(repeated.publication).toEqual(first.publication);
    const published = await store.readPublished(userA, created.summary.id, 1);
    expect(published.html).toContain("<svg");
    expect(published.summary.internalSiteUrl).toContain("/published/1");
  });
});
