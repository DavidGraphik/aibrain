import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const hostModule = (name: string) => import(pathToFileURL(path.join(process.cwd(), "deployments/trinalum/host/outlook/lib", name)).href);
const { MailApi, compileImapQuery } = await hostModule("mail-api.mjs");
const owned = await hostModule("mail-owned-search.mjs");
const { encryptToken } = await hostModule("token-crypto.mjs");
const mailbox = "owner@example.test";
const key = "ab".repeat(32); // Synthetic test key, never a provider credential.
const folders = ["INBOX", "AAA", "Archive/ACME-WORKS", "Archive/AcmeWorksPlus"];
const humanContext = { humanMessage: "Find AcmeWorks original", sourceMessageId: "synthetic_request" };
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function fixture() {
  const locks: string[] = [];
  const queries: object[] = [];
  const imap = {
    mailbox: { uidValidity: "1", uidNext: 3 },
    async list() { return folders.map(path => ({ path })); },
    async getMailboxLock(folder: string, options: object) {
      expect(options).toEqual({ readOnly: true });
      locks.push(folder);
      return { release() {} };
    },
    async search(criteria: { uid?: string }) {
      queries.push(criteria);
      const upper = criteria.uid ? Number(criteria.uid.split(":")[1]) : 2;
      return [1, 2].filter(uid => uid <= upper);
    },
    async fetchOne(uid: number) {
      return { uid, envelope: { subject: "Synthetic result", messageId: `<${locks.at(-1)}-${uid}@example.test>` }, flags: new Set() };
    },
  };
  const api = new MailApi({
    config: { dataDirectory: null, tokenEncryptionKey: key, mailboxes: [{ address: mailbox, name: "Owner" }] },
    actionDirectory: "/unused-synthetic-mail-actions",
    now: () => Date.UTC(2026, 0, 1),
    store: {},
    client: {
      requiredCredential() { return { password_encrypted: encryptToken("synthetic-password", key), folders_json: JSON.stringify({ inbox: "INBOX" }) }; },
      async withImapPassword(address: string, password: string, callback: (client: typeof imap) => Promise<unknown>) {
        expect(address).toBe(mailbox);
        expect(password).toBe("synthetic-password");
        return callback(imap);
      },
    },
  });
  return { api, locks, queries };
}

describe("authenticated mail folder ordering", () => {
  it("prioritizes the normalized company without changing literal SEARCH or folder coverage", async () => {
    const { api, locks, queries } = fixture();
    const first = await api.search(mailbox, { query: 'subject:"AcmeWorks"', limit: 1 });
    expect(locks[0]).toBe("Archive/ACME-WORKS");
    expect(queries).toEqual([{ subject: "AcmeWorks" }]);
    expect(first.coverage.totalFolders).toBe(folders.length);
    expect(first.complete).toBe(false);
    expect(first.warning).toMatch(/historical coverage (?:is|remains) partial/);
    expect(first.candidates).toBeUndefined();
    const state = api.uncursor(first.cursor);
    expect(state.folderOrderVersion).toBe("v2");
    const second = await api.search(mailbox, { query: 'subject:"AcmeWorks"', limit: 1, cursor: first.cursor }, { searchContext: { ...humanContext, humanMessage: "Find another company" } });
    expect(second.messages[0].folder).toBe("Archive/ACME-WORKS");
    expect(second.messages[0].id).not.toBe(first.messages[0].id);
    const messages = [...first.messages, ...second.messages];
    let page = second;
    while (page.cursor) {
      page = await api.search(mailbox, { query: 'subject:"AcmeWorks"', limit: 1, cursor: page.cursor });
      messages.push(...page.messages);
    }
    expect(page.complete).toBe(true);
    expect(new Set(messages.map(message => message.id)).size).toBe(8);
    expect(new Set(messages.map(message => message.folder))).toEqual(new Set(folders));
  });

  it("folds company punctuation only for specific folder ordering", () => {
    const catalog = ["Archive/ÁCME-WORKS", "Archive/AcmeWorksPlus", "Archive/Invoice", "Archive/Acme.Works", "Archive/Acme_Works"];
    expect(owned.orderingMailSearchFoldersV2({ text: "AcmeWorks" }, catalog)).toEqual([catalog[0], catalog[3], catalog[4]]);
    expect(owned.orderingMailSearchFoldersV2({ text: "invoice" }, catalog)).toEqual([]);
    expect(owned.orderingMailSearchFoldersV2({ not: { text: "AcmeWorks" } }, catalog)).toEqual([]);
    expect(owned.orderingMailSearchFoldersV2({ or: [{ text: "AcmeWorks" }, { text: "Different" }] }, catalog)).toEqual([]);
    expect(owned.strongMailSearchFolders({ text: "AcmeWorks" }, catalog)).toEqual([]);
    expect(owned.matchesOwnedMailCriteria({ subject: "ACME-WORKS" }, { subject: "AcmeWorks" })).toBe(false);
  });

  it("uses normalized human context as an ordering hint without rewriting the reference query", async () => {
    const { api, locks, queries } = fixture();
    const result = await api.search(mailbox, { query: 'subject:"REF-12345"', limit: 1 }, { searchContext: humanContext });
    expect(locks[0]).toBe("Archive/ACME-WORKS");
    expect(queries).toEqual([{ subject: "REF-12345" }]);
    const plan = api.uncursor(result.cursor).searchPlan;
    expect(plan.folderOrdering).toBe("specific-token-v2");
    expect(plan.hintTerms).toEqual(["acmeworks"]);
    expect(owned.validHumanMailSearchPlan(plan)).toBe(true);
    expect(owned.validHumanMailSearchPlan({ ...plan, folderOrdering: "unknown" })).toBe(false);
  });

  it.each([null, "v1", "unversioned", "absent"])("continues a signed old %s plan with its original catalog", async version => {
    const { api, locks } = fixture();
    const query = 'subject:"AcmeWorks"';
    const ranked = owned.rankMailSearchFolders(compileImapQuery(query), folders);
    const searchPlan = version === null || version === "absent" ? null : { ...(version === "v1" ? { folderOrdering: "specific-token-v1" } : {}), contextHash: "a".repeat(64), hintTerms: ["acmeworks"], referenceOmitted: false };
    // The old hint helpers yield no matching exact word/two-term folder here.
    expect(owned.orderingMailSearchFolders({ text: "acmeworks" }, ranked)).toEqual([]);
    expect(owned.strongMailSearchFolders({ text: "acmeworks" }, ranked)).toEqual([]);
    const old = { binding: digest({ folder: null, mailbox, query }), catalog: digest(ranked), index: 1, beforeUid: null, uidValidity: null, startedAt: "2026-01-01T00:00:00.000Z", ...(version !== "absent" ? { searchPlan } : {}), locatorPlan: { version: 1, baseCatalog: digest(ranked), indices: [] } };
    const result = await api.search(mailbox, { query, cursor: api.cursor(old), limit: 1 }, { searchContext: humanContext });
    expect(locks[0]).toBe(ranked[1]);
    const continued = api.uncursor(result.cursor);
    expect(continued.searchPlan ?? null).toEqual(searchPlan);
    expect(continued.folderOrderVersion).toBeUndefined();
    expect(continued.locatorPlan).toEqual(old.locatorPlan);
  });

  it("retains cursor signatures, mailbox binding and authenticated catalog checks", async () => {
    const { api } = fixture();
    const query = 'subject:"AcmeWorks"';
    const first = await api.search(mailbox, { query, limit: 1 });
    const [payload, mac] = first.cursor.split(".");
    const changedMac = `${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
    await expect(api.search(mailbox, { query, cursor: `${payload}.${changedMac}` })).rejects.toMatchObject({ code: "MAIL_API_INVALID" });
    await expect(api.search("other@example.test", { query, cursor: first.cursor })).rejects.toMatchObject({ code: "MAIL_API_INVALID" });
    const state = api.uncursor(first.cursor);
    await expect(api.search(mailbox, { query, cursor: api.cursor({ ...state, catalog: "0".repeat(64) }) })).rejects.toMatchObject({ code: "MAIL_SEARCH_CURSOR_EXPIRED" });
    await expect(api.search(mailbox, { query, cursor: api.cursor({ ...state, folderOrderVersion: "v3" }) })).rejects.toMatchObject({ code: "MAIL_SEARCH_CURSOR_EXPIRED" });
  });
});
