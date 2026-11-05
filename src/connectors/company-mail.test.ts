import { mkdtemp, readFile, mkdir, symlink, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImapFlow, MessageStructureObject } from "imapflow";
import type { InstallationConfig } from "@/config/installation-schema";
import { companyMailAttachmentParts, companyMailClientOptions, downloadCompanyMailAttachment, MAX_MAIL_ATTACHMENT_BYTES } from "./company-mail-client";
import { parseCompanyMailCredential, validMailDate } from "./company-mail-contracts";
import { FileCompanyMailStore, companyMailEncryptionKey } from "./company-mail-store";
import { importCompanyMailInvoices, invoiceLedgerForMailbox, mailboxIdentity, mailHash, mailInvoiceChangesForDay, mailInvoiceWorkbook, parseMailInvoiceReview, recordMailInvoiceReview, refreshMailInvoiceWorkbook } from "./company-mail-invoices";
import { validateUploadedDocument } from "@/documents/upload-validation";
import JSZip from "jszip";

const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const PROJECT = "10000000-0000-4000-8000-000000000001";
const credential = { email: "billing@example.invalid", password: "private-test-password", folder: "INBOX", since: "2026-10-01" };
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aibrain-company-mail-")); roots.push(root);
  const config = { installationId: "company-qa", paths: { dataRoot: root, usersRoot: path.join(root, "users") }, connectors: { companyMail: { enabled: true, host: "hc65.infoselfcloud.com", emailDomain: "example-company.invalid" } } } as InstallationConfig;
  const store = new FileCompanyMailStore(config, randomBytes(32));
  const ledger = await invoiceLedgerForMailbox(await store.root(USER), { installationId: config.installationId, userId: USER, projectId: PROJECT, mailboxKey: mailboxIdentity(config.connectors!.companyMail!.host, credential) });
  return { config, store, ledger, root };
}
async function pdf(number: number) {
  const doc = await PDFDocument.create(); doc.addPage().drawText(`Invoice ${number}`);
  return Buffer.from(await doc.save());
}
function client(messages: Array<{ uid: number; parts: Array<{ name: string; data: Buffer; mediaType?: string }> }>, epoch = 10n) {
  return { mailbox: { readOnly: true, uidValidity: epoch }, search: vi.fn(async () => messages.map(m => m.uid)),
    fetchOne: vi.fn(async (uid: string) => {
      const message = messages.find(m => m.uid === Number(uid)); if (!message) return false;
      return { uid: message.uid, internalDate: new Date("2026-10-06T10:00:00Z"), envelope: { subject: "=DANGEROUS()", from: [{ address: "supplier@example.com" }] },
        bodyStructure: { type: "multipart/mixed", childNodes: message.parts.map((p, index) => ({ type: p.mediaType ?? "application/pdf", disposition: "attachment", dispositionParameters: { filename: p.name }, part: String(index + 1), size: p.data.length })) } };
    }),
    download: vi.fn(async (uid: string, part: string) => ({ content: Readable.from([messages.find(m => m.uid === Number(uid))!.parts[Number(part) - 1].data]), meta: {} })) } as unknown as ImapFlow;
}

describe("company mailbox boundary", () => {
  it("pins exact admin-owned host, TLS validation and server-only proxy; never accepts missing proxy", async () => {
    const { config } = await setup();
    const env = { AIBRAIN_EGRESS_MAIL_HOSTS: "hc65.infoselfcloud.com", AIBRAIN_EGRESS_PROXY_URL: "http://egress-gateway:8080", AIBRAIN_EGRESS_SERVER_TOKEN: "x".repeat(48) };
    const options = companyMailClientOptions(config, credential, env);
    expect(options).toMatchObject({ host: "hc65.infoselfcloud.com", port: 993, secure: true, logger: false, tls: { rejectUnauthorized: true }, auth: { user: credential.email, pass: credential.password } });
    expect(new URL(options.proxy!).username).toBe("aibrain");
    expect(() => companyMailClientOptions(config, credential, {})).toThrow();
    expect(() => companyMailClientOptions(config, credential, { ...env, AIBRAIN_EGRESS_PROXY_URL: "http://attacker.example:8080" })).toThrow();
    expect(() => parseCompanyMailCredential({ ...credential, email: "other@example.com" }, "example-company.invalid")).toThrow();
    expect(() => parseCompanyMailCredential({ ...credential, host: "localhost" }, "example-company.invalid")).toThrow();
    expect(validMailDate("2026-02-30")).toBe(false);
  });
  it("encrypts server-only credentials, isolates users/installations and refuses symlink ancestors", async () => {
    const { store, config, root } = await setup();
    const ref = await store.put(USER, credential);
    const userRoot = await store.root(USER);
    const file = `${ref.slice(13)}.json`;
    expect(await readFile(path.join(userRoot, "credentials", file), "utf8")).not.toContain(credential.password);
    expect((await store.read(USER, ref)).email).toBe(credential.email);
    const otherRoot = await store.root(OTHER);
    await mkdir(path.join(otherRoot, "credentials"));
    await copyFile(path.join(userRoot, "credentials", file), path.join(otherRoot, "credentials", file));
    await expect(store.read(OTHER, ref)).rejects.toMatchObject({ code: "MAIL_CREDENTIAL_UNAVAILABLE" });
    expect(userRoot.startsWith(config.paths.usersRoot)).toBe(false);
    const otherInstall = { ...config, installationId: "other" };
    const otherStore = new FileCompanyMailStore(otherInstall, randomBytes(32));
    await expect(otherStore.read(USER, ref)).rejects.toMatchObject({ code: "MAIL_CREDENTIAL_UNAVAILABLE" });
    await store.clear(USER, ref);
    await expect(store.read(USER, ref)).rejects.toMatchObject({ code: "MAIL_CREDENTIAL_UNAVAILABLE" });
    const badRoot = path.join(root, "bad"); await mkdir(badRoot); await symlink(userRoot, path.join(badRoot, "server"));
    await expect(new FileCompanyMailStore({ ...config, paths: { ...config.paths, dataRoot: badRoot } }, randomBytes(32)).root(USER)).rejects.toMatchObject({ code: "MAIL_PATH_UNSAFE" });
    expect(() => companyMailEncryptionKey("invalid")).toThrow();
  });
  it("does not treat inline images or embedded emails as invoice attachments", () => {
    const tree: MessageStructureObject = { type: "multipart/mixed", childNodes: [
      { type: "image/png", part: "1", disposition: "inline", parameters: { name: "logo.png" } },
      { type: "message/rfc822", childNodes: [{ type: "application/pdf", part: "2.1", parameters: { name: "nested.pdf" } }] },
      { type: "application/pdf", part: "3", disposition: "attachment", parameters: { name: "invoice.pdf" } },
    ] };
    expect(companyMailAttachmentParts(tree).map(p => p.name)).toEqual(["invoice.pdf"]);
  });
  it("rejects an oversized decoded stream rather than storing a truncated invoice", async () => {
    const imap = { download: async () => ({ content: Readable.from([Buffer.alloc(MAX_MAIL_ATTACHMENT_BYTES + 1)]), meta: {} }) } as unknown as ImapFlow;
    await expect(downloadCompanyMailAttachment(imap, 1, { part: "1", name: "large.pdf", size: 1, type: "application/pdf" })).rejects.toMatchObject({ code: "MAIL_ATTACHMENT_TOO_LARGE" });
  });
});

describe("durable local invoice import", () => {
  it("imports 18 attachments and resumes after restart without duplicates, including a UIDVALIDITY reset", async () => {
    const { ledger } = await setup();
    const parts = await Promise.all(Array.from({ length: 18 }, async (_, i) => ({ name: `${i}.pdf`, data: await pdf(i) })));
    const imap = client([{ uid: 5, parts }]);
    const first = await importCompanyMailInvoices({ client: imap, credential, store: ledger });
    expect(first.imported).toHaveLength(18); expect(first.remainingMessages).toBe(0);
    const second = await importCompanyMailInvoices({ client: imap, credential, store: ledger });
    expect(second.imported).toHaveLength(0); expect((await ledger.read()).entries).toHaveLength(18);
    const reset = await importCompanyMailInvoices({ client: client([{ uid: 5, parts }], 11n), credential, store: ledger });
    expect(reset.imported).toHaveLength(0); expect(reset.ledger.entries.filter(e => e.duplicateOf)).toHaveLength(18);
    expect(imap.search).toHaveBeenCalledWith({ since: new Date("2026-10-01T00:00:00Z") }, { uid: true });
    const entry = first.imported[0]; expect((await ledger.original(entry)).equals(parts[0].data)).toBe(true);
    expect(entry.status).toBe("pending");
    const review = parseMailInvoiceReview({ id: entry.id, status: "reviewed", note: "Compared invoice 0 against project purchase order 123.", invoiceNumber: "0", supplier: "Example", amount: "123.45", currency: "EUR" });
    await recordMailInvoiceReview(ledger, review);
    const { contents, ledger: updated } = await refreshMailInvoiceWorkbook(ledger);
    expect(updated.entries[0].status).toBe("reviewed");
    expect(validateUploadedDocument({ fileName: "facturas.xlsx", declaredMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: contents }).kind).toBe("xlsx");
    const zip = await JSZip.loadAsync(contents);
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).toContain("=DANGEROUS()"); expect(sheet).not.toContain("<f>"); expect(sheet).toContain("123.45");
  });
  it("imports a supplier x-pdf alias without changing original bytes and retries without duplicates", async () => {
    const { ledger } = await setup();
    const body = await pdf(53625);
    const imap = client([{ uid: 1, parts: [{ name: "053625.pdf", data: body, mediaType: "application/x-pdf" }] }]);
    const first = await importCompanyMailInvoices({ client: imap, credential, store: ledger });
    expect(first.errors).toEqual([]);
    expect(first.imported).toHaveLength(1);
    expect(first.imported[0]).toMatchObject({ mediaType: "application/pdf", sha256: mailHash(body), size: body.length });
    expect(await ledger.original(first.imported[0])).toEqual(body);
    const again = await importCompanyMailInvoices({ client: imap, credential, store: ledger });
    expect(again.imported).toHaveLength(0);
    expect(again.ledger.entries).toHaveLength(1);
  });

  it("rejects malformed bytes and mismatched names even with the known PDF alias", async () => {
    const { ledger } = await setup();
    const imap = client([{ uid: 1, parts: [
      { name: "bad.pdf", data: Buffer.from("invalid PDF"), mediaType: "application/x-pdf" },
      { name: "wrong.xlsx", data: await pdf(1), mediaType: "application/x-pdf" },
      { name: "unknown.pdf", data: await pdf(2), mediaType: "application/not-a-pdf" },
    ] }]);
    const result = await importCompanyMailInvoices({ client: imap, credential, store: ledger });
    expect(result.imported).toHaveLength(0);
    expect(result.errors).toHaveLength(3);
    expect(result.ledger.entries.every(e => e.sha256 === null && e.status === "needs_attention")).toBe(true);
  });

  it("continues a message in bounded batches rather than dropping attachments beyond 20", async () => {
    const { ledger } = await setup();
    const parts = await Promise.all(Array.from({ length: 23 }, async (_, i) => ({ name: `${i}.pdf`, data: await pdf(i) })));
    const imap = client([{ uid: 1, parts }]);
    expect((await importCompanyMailInvoices({ client: imap, credential, store: ledger })).imported).toHaveLength(20);
    expect((await ledger.read()).processedMessages).toHaveLength(0);
    expect((await importCompanyMailInvoices({ client: imap, credential, store: ledger })).imported).toHaveLength(3);
    expect((await ledger.read()).processedMessages).toHaveLength(1);
  });
  it("imports supplier HTTP-prefixed PDFs without altering originals or duplicating them", async () => {
    const { ledger } = await setup();
    const body = await pdf(209452);
    const original = Buffer.concat([Buffer.from(`content-type: application/pdf\\ncontent-length: ${body.length}\\n`), body]);
    const imap = client([{ uid: 1, parts: [{ name: "209452.pdf", data: original }] }]);
    const first = await importCompanyMailInvoices({ client: imap, credential, store: ledger });
    expect(first.errors).toEqual([]);
    expect(first.imported).toHaveLength(1);
    expect(first.imported[0].sha256).toBe(mailHash(original));
    expect(await ledger.original(first.imported[0])).toEqual(original);
    expect((await importCompanyMailInvoices({ client: imap, credential, store: ledger })).imported).toHaveLength(0);
    expect((await ledger.read()).entries).toHaveLength(1);
  });
  it("retains partial success on a download failure, backs off, and retries without duplicating the original", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-06T10:00:00Z"));
    const { ledger } = await setup();
    const imap = client([{ uid: 1, parts: [{ name: "one.pdf", data: await pdf(1) }, { name: "two.pdf", data: await pdf(2) }] }]);
    const download = vi.mocked(imap.download);
    const original = download.getMockImplementation()!;
    download.mockImplementation(async (...args) => { if (args[1] === "2") throw new Error("temporary remote failure"); return original(...args); });
    const first = await importCompanyMailInvoices({ client: imap, credential, store: ledger });
    expect(first.imported).toHaveLength(1); expect(first.errors).toHaveLength(1);
    expect(first.remainingMessages).toBe(0); expect(first.deferredMessages).toBe(1);
    download.mockImplementation(original);
    expect((await importCompanyMailInvoices({ client: imap, credential, store: ledger })).imported).toHaveLength(0);
    vi.setSystemTime(new Date("2026-10-07T12:00:01Z"));
    expect((await importCompanyMailInvoices({ client: imap, credential, store: ledger })).imported).toHaveLength(1);
    const final = await ledger.read(); expect(final.entries).toHaveLength(2); expect(final.entries.every(e => !e.errorCode)).toBe(true);
    expect(final.entries[0].importedAt).toBe("2026-10-06T10:00:00.000Z");
    expect(final.entries[1].importedAt).toBe("2026-10-07T12:00:01.000Z");
    expect(final.entries[1].updatedAt).toBe("2026-10-07T12:00:01.000Z");
    expect(mailInvoiceChangesForDay(final.entries, "2026-10-07").map(e => e.id)).toEqual([final.entries[1].id]);
    const changedAtMidnight = { ...final.entries[0], updatedAt: "2026-10-07T22:01:00.000Z" };
    expect(mailInvoiceChangesForDay([changedAtMidnight], "2026-10-08")).toHaveLength(1);
    expect(mailInvoiceChangesForDay([changedAtMidnight], "2026-10-07")).toHaveLength(0);
  });
  it("does not starve new invoices behind more than 100 messages waiting for retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-06T10:00:00Z"));
    const { ledger } = await setup();
    const imap = client([
      ...Array.from({ length: 101 }, (_, i) => ({ uid: i + 1, parts: [{ name: "bad.pdf", data: Buffer.from("invalid PDF") }] })),
      { uid: 102, parts: [{ name: "new.pdf", data: await pdf(102) }] },
    ]);
    for (let i = 0; i < 5; i += 1) await importCompanyMailInvoices({ client: imap, credential, store: ledger });
    const result = await importCompanyMailInvoices({ client: imap, credential, store: ledger });
    expect(result.imported.map(e => e.fileName)).toEqual(["new.pdf"]);
    expect(result.deferredMessages).toBe(101); expect(result.remainingMessages).toBe(0);
    const calls = vi.mocked(imap.fetchOne).mock.calls.length;
    await importCompanyMailInvoices({ client: imap, credential, store: ledger });
    expect(vi.mocked(imap.fetchOne).mock.calls.length).toBe(calls);
  });
  it("continues untouched parts after a failed attachment exhausts a batch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-06T10:00:00Z"));
    const { ledger } = await setup();
    const parts = [{ name: "bad.pdf", data: Buffer.from("invalid PDF") }, ...await Promise.all(Array.from({ length: 22 }, async (_, i) => ({ name: `${i}.pdf`, data: await pdf(i) })))];
    const imap = client([{ uid: 1, parts }]);
    const first = await importCompanyMailInvoices({ client: imap, credential, store: ledger });
    expect(first.imported).toHaveLength(19); expect(first.remainingMessages).toBe(1); expect(first.deferredMessages).toBe(0);
    const second = await importCompanyMailInvoices({ client: imap, credential, store: ledger });
    expect(second.imported).toHaveLength(3); expect(second.remainingMessages).toBe(0); expect(second.deferredMessages).toBe(1);
  });
  it("does not follow filename traversal, expose another project, or silently reset a corrupted ledger", async () => {
    const { ledger } = await setup();
    const imap = client([{ uid: 1, parts: [{ name: "../../outside.pdf", data: await pdf(1) }] }]);
    expect((await importCompanyMailInvoices({ client: imap, credential, store: ledger })).errors).toHaveLength(1);
    const workbook = await mailInvoiceWorkbook(await ledger.read()); expect(workbook.length).toBeGreaterThan(0);
    const foreign = new (ledger.constructor as typeof import("./company-mail-invoices").FileMailInvoiceLedger)(ledger.root, { ...ledger.identity, projectId: "10000000-0000-4000-8000-000000000002" });
    await expect(foreign.read()).rejects.toMatchObject({ code: "MAIL_LEDGER_CORRUPT" });
    await import("node:fs/promises").then(fs => fs.writeFile(path.join(ledger.root, "ledger.json"), "broken"));
    await expect(ledger.read()).rejects.toMatchObject({ code: "MAIL_LEDGER_CORRUPT" });
  });
});
