export const OUTLOOK_DESKTOP_OPERATIONS = ["stores.list", "folders.list", "items.search", "items.read", "attachments.read", "mail.draft", "mail.send", "mail.organize", "folders.mutate", "contacts.mutate", "calendar.mutate"] as const;
export type OutlookDesktopOperation = typeof OUTLOOK_DESKTOP_OPERATIONS[number];
export type OutlookDesktopArgs = Record<string, unknown>;
export const OUTLOOK_DESKTOP_MAX_RESULT_BYTES = 12 * 1024 * 1024;
export class OutlookDesktopError extends Error { constructor(public readonly code: string, public readonly status = 400) { super(code); } }
export function desktopRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function invalid(): never { throw new OutlookDesktopError("OUTLOOK_DESKTOP_ARGUMENTS_INVALID"); }
export function desktopString(value: unknown, max = 2048, empty = false): string { if (typeof value !== "string" || value.length > max || !empty && !value.trim() || /[\0]/.test(value)) invalid(); return value; }
function header(value: unknown, max = 2048, empty = false) { const s = desktopString(value, max, empty); if (/[\r\n]/.test(s)) invalid(); return s; }
function integer(value: unknown, min: number, max: number) { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid(); return value; }
function oneOf(value: unknown, allowed: string[]) { if (typeof value !== "string" || !allowed.includes(value)) invalid(); }
export function exactDesktopRecord(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> { if (!desktopRecord(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid(); }
export function validateDesktopStores(value: unknown) { if (!Array.isArray(value) || !value.length || value.length > 32) invalid(); const result = value.map(s => header(s, 2048)); if (new Set(result).size !== result.length) invalid(); return result; }
export function validateDesktopMachine(value: unknown) { exactDesktopRecord(value, ["sid", "computer", "email", "storeIds", "version"]); const sid = header(value.sid, 184), computer = header(value.computer, 63); if (!/^S-1-\d+(?:-\d+){1,15}$/.test(sid) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(computer)) invalid(); return { sid, computer: computer.toUpperCase(), email: header(value.email, 320).toLowerCase(), storeIds: validateDesktopStores(value.storeIds), version: header(value.version, 40) }; }
function date(value: unknown, dateOnly = false) { const s = header(value, 40); if (!(dateOnly ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/).test(s) || !Number.isFinite(Date.parse(s))) invalid(); return s; }
function addresses(value: unknown) { if (!Array.isArray(value) || value.length > 50) invalid(); return value.map(v => { const s = header(v, 320); if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s)) invalid(); return s; }); }
export function outlookDesktopIsMutation(operation: OutlookDesktopOperation) { return operation.startsWith("mail.") || operation.endsWith(".mutate"); }
export function normalizeOutlookDesktopOperationArgs(operation: OutlookDesktopOperation, input: unknown): OutlookDesktopArgs {
  const fields: Record<OutlookDesktopOperation, string[]> = {
    "stores.list": [], "folders.list": ["storeId", "parentId", "offset", "limit"],
    "items.search": ["storeId", "folderId", "kind", "query", "from", "to", "after", "before", "cursor", "limit"],
    "items.read": ["storeId", "entryId", "occurrenceStartUtc", "bodyOffset", "bodyLimit"],
    "attachments.read": ["storeId", "entryId", "index", "offset", "length"],
    "mail.draft": ["storeId", "entryId", "to", "cc", "bcc", "subject", "body", "attachments", "replyToEntryId", "replyAll"],
    "mail.send": ["storeId", "entryId", "expectedFingerprint"],
    "mail.organize": ["storeId", "entryId", "action", "targetStoreId", "targetFolderId"],
    "folders.mutate": ["action", "storeId", "folderId", "parentId", "name", "targetStoreId"],
    "contacts.mutate": ["action", "storeId", "folderId", "entryId", "fields"],
    "calendar.mutate": ["action", "storeId", "folderId", "entryId", "occurrenceStartUtc", "fields", "recurrence"],
  };
  if (!OUTLOOK_DESKTOP_OPERATIONS.includes(operation)) invalid();
  exactDesktopRecord(input, fields[operation]); const args = structuredClone(input);
  if (operation !== "stores.list") header(args.storeId);
  for (const key of ["entryId", "folderId", "parentId", "targetStoreId", "targetFolderId"]) if (args[key] !== undefined) header(args[key]);
  if (["items.read", "attachments.read", "mail.send", "mail.organize"].includes(operation)) header(args.entryId);
  for (const key of ["offset", "bodyOffset"]) if (args[key] !== undefined) integer(args[key], 0, 100_000_000);
  if (args.cursor !== undefined) { const cursor = desktopString(args.cursor, 32); if (!/^[a-f0-9]{32}$/.test(cursor)) invalid(); }
  if (args.limit !== undefined) integer(args.limit, 1, 50);
  if (args.bodyLimit !== undefined) integer(args.bodyLimit, 1, 100_000);
  if (args.occurrenceStartUtc !== undefined) date(args.occurrenceStartUtc);
  if (operation === "items.search") { if (args.kind !== undefined) oneOf(args.kind, ["mail", "contact", "calendar"]); for (const key of ["query", "from", "to"]) if (args[key] !== undefined) header(args[key], 1000, true); for (const key of ["after", "before"]) if (args[key] !== undefined) date(args[key]); if (args.after && args.before && String(args.after) >= String(args.before)) invalid(); }
  if (operation === "attachments.read") { integer(args.index, 1, 10000); if (args.length !== undefined) integer(args.length, 1, 8 * 1024 * 1024); }
  if (operation === "mail.draft") {
    if (args.replyToEntryId !== undefined) header(args.replyToEntryId);
    if (args.entryId !== undefined && args.replyToEntryId !== undefined || args.replyAll !== undefined && (typeof args.replyAll !== "boolean" || args.replyToEntryId === undefined)) invalid();
    const recipients = [addresses(args.to), addresses(args.cc ?? []), addresses(args.bcc ?? [])]; if (recipients.flat().length > 50) invalid();
    header(args.subject, 998, true); desktopString(args.body, 150_000, true);
    if (args.attachments !== undefined) { if (!Array.isArray(args.attachments) || args.attachments.length > 10) invalid(); let bytes = 0;
      for (const file of args.attachments) { exactDesktopRecord(file, ["filename", "contentType", "dataBase64"]); const filename = header(file.filename, 240); if (/[\\/:]/.test(filename) || filename === "." || filename === "..") invalid(); if (!/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(header(file.contentType, 100))) invalid(); const data = desktopString(file.dataBase64, 7 * 1024 * 1024, true); if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || Buffer.from(data, "base64").toString("base64") !== data) invalid(); bytes += Buffer.from(data, "base64").length; } if (bytes > 5 * 1024 * 1024) invalid(); }
  }
  if (operation === "mail.send" && !/^[a-fA-F0-9]{64}$/.test(header(args.expectedFingerprint, 64))) invalid();
  if (operation === "mail.organize") { oneOf(args.action, ["move", "copy", "mark-read", "mark-unread", "flag", "clear-flag", "delete"]); if (["move", "copy"].includes(String(args.action))) header(args.targetFolderId); }
  if (operation === "folders.mutate") { oneOf(args.action, ["create", "rename", "move", "delete"]); if (args.action !== "create") header(args.folderId); if (["create", "rename"].includes(String(args.action))) { const name = header(args.name, 200); if (/[\\/]/.test(name) || [".", ".."].includes(name)) invalid(); } if (["create", "move"].includes(String(args.action))) header(args.parentId); }
  if (["contacts.mutate", "calendar.mutate"].includes(operation)) {
    oneOf(args.action, ["create", "update", "delete"]); if (args.action !== "create") header(args.entryId);
    const contact = operation === "contacts.mutate";
    if (args.action !== "delete" && args.fields === undefined) invalid();
    if (args.fields !== undefined) {
      const allowed = contact ? ["firstName", "lastName", "fullName", "companyName", "email1Address", "email2Address", "businessTelephone", "mobileTelephone", "businessAddress", "notes"] : ["subject", "body", "location", "startUtc", "endUtc", "allDay", "isPrivate", "busyStatus", "reminderMinutes"];
      exactDesktopRecord(args.fields, allowed); if (!Object.keys(args.fields).length) invalid();
      for (const [key, value] of Object.entries(args.fields)) { if (["startUtc", "endUtc"].includes(key)) date(value); else if (["allDay", "isPrivate"].includes(key)) { if (typeof value !== "boolean") invalid(); } else if (key === "busyStatus") integer(value, 0, 4); else if (key === "reminderMinutes") integer(value, 0, 40320); else desktopString(value, ["body", "notes"].includes(key) ? 150_000 : 4000, true); }
      if (args.fields.startUtc && args.fields.endUtc && String(args.fields.startUtc) >= String(args.fields.endUtc)) invalid();
      if (!contact && args.action === "create" && (!args.fields.startUtc || !args.fields.endUtc)) invalid();
    }
    if (args.recurrence !== undefined) { exactDesktopRecord(args.recurrence, ["type", "interval", "startDate", "endDate", "occurrences", "daysMask", "dayOfMonth", "monthOfYear"]); const r = args.recurrence; oneOf(r.type, ["daily", "weekly", "monthly", "yearly"]); integer(r.interval, 1, 999); date(r.startDate, true); if (!r.endDate && !r.occurrences) invalid(); if (r.endDate !== undefined) { date(r.endDate, true); if (String(r.endDate) < String(r.startDate) || Date.parse(String(r.endDate)) - Date.parse(String(r.startDate)) > 10 * 366 * 86400000) invalid(); } for (const [key, max] of [["occurrences", 1000], ["daysMask", 127], ["dayOfMonth", 31], ["monthOfYear", 12]] as const) if (r[key] !== undefined) integer(r[key], 1, max); }
  }
  if (Buffer.byteLength(JSON.stringify(args)) > 8 * 1024 * 1024) invalid(); return args;
}
export const validateOutlookDesktopOperationArgs = normalizeOutlookDesktopOperationArgs;
