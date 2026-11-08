import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, lstat, realpath, chmod } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, ResourceLockManager } from "@/storage";
import type { ApprovalLocator } from "@/runtime/approval-store";
import { readRegularFileWithin } from "@/security/safe-file";
import { shopifyFail } from "./shopify-contracts";
import { draftId, themeFilename, THEME_FILE_LIMIT, type ThemeProvider } from "./shopify-themes-api";
import { themeFileEdit, patchThemeFile, type ThemeFileEdit } from "./shopify-theme-file-edit";
export const themeHash = (text: string) => createHash("sha256").update(text).digest("hex");
export type TitleEdit = { themeId: string; kind: "visible_heading" | "homepage_seo_title"; filename: string; expected: string; title: string; sectionId?: string; settingId?: "heading" | "title" };
type Plan = (TitleEdit | ThemeFileEdit) & { id: string; actor: string; threadId: string; version: number; policyHash: string; expiresAt: number; before: string; after: string; beforeHash: string; afterHash: string; status: "prepared" | "executing" | "applied" | "indeterminate" | "rolling_back" | "rolled_back"; events: { status: string; at: string }[] };
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
export function titleEdit(input: unknown): TitleEdit {
  const p = input as TitleEdit;
  if (!p || typeof p !== "object" || Array.isArray(p) || !["expected,filename,kind,themeId,title", "expected,filename,kind,sectionId,settingId,themeId,title"].includes(Object.keys(p).sort().join())) shopifyFail("TITLE_EDIT_INVALID");
  draftId(p.themeId); themeFilename(p.filename);
  if (!["visible_heading", "homepage_seo_title"].includes(p.kind) || typeof p.expected !== "string" || p.expected.length < 1 || p.expected.length > 6000 || typeof p.title !== "string" || !p.title.trim() || p.title !== p.title.trim() || p.title.length > 160 || /[\x00-\x1f\x7f{}]/.test(p.title)) shopifyFail("TITLE_EDIT_INVALID");
  if (p.kind === "homepage_seo_title" && p.filename !== "layout/theme.liquid" || p.kind === "visible_heading" && !p.filename.startsWith("sections/") && p.filename !== "templates/index.json") shopifyFail("TITLE_TARGET_INVALID");
  if (p.filename === "templates/index.json") {
    if (p.kind !== "visible_heading" || typeof p.sectionId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(p.sectionId) || !["heading", "title"].includes(p.settingId ?? "")) shopifyFail("TITLE_TARGET_INVALID");
  } else if (p.sectionId !== undefined || p.settingId !== undefined) shopifyFail("TITLE_TARGET_INVALID");
  return p;
}
/** One literal heading text node, or the one title element with a homepage-only branch.
 * No arbitrary Liquid/code, regex, file path, store name or global SEO setting from the model. */
export function patchTitle(content: string, edit: TitleEdit) {
  if (Buffer.byteLength(content) > THEME_FILE_LIMIT) shopifyFail("THEME_FILE_TOO_LARGE");
  if (edit.filename === "templates/index.json") {
    let data;
    try { data = JSON.parse(content.replace(/^\s*\/\*[\s\S]*?\*\//, "")); } catch { shopifyFail("TITLE_JSON_INVALID"); }
    const section = data.sections?.[edit.sectionId!];
    if (!section || section.disabled || !Array.isArray(data.order) || !data.order.includes(edit.sectionId) || section.settings?.[edit.settingId!] !== edit.expected) shopifyFail("TITLE_TARGET_INVALID");
    const token = JSON.stringify(edit.expected);
    if (content.split(token).length !== 2) shopifyFail("TITLE_TARGET_AMBIGUOUS");
    const after = content.replace(token, () => JSON.stringify(escape(edit.title)));
    if (after === content) shopifyFail("TITLE_NO_CHANGE");
    return after;
  }
  if (edit.kind === "homepage_seo_title" && [...content.matchAll(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi)].length !== 1) shopifyFail("TITLE_TARGET_AMBIGUOUS");
  const matches = edit.kind === "visible_heading" ? [...content.matchAll(/<h([1-6])\b[^>]*>([^<>]*?)<\/h\1\s*>/gi)].filter(m => m[2] === edit.expected)
    : [...content.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi)].filter(m => m[1] === edit.expected);
  if (matches.length !== 1) shopifyFail("TITLE_TARGET_AMBIGUOUS");
  const m = matches[0], old = m[0];
  if (edit.kind === "visible_heading") {
    const schemaIndex = content.search(/{%-?\s*schema\s*-?%}/i);
    if (schemaIndex >= 0 && m.index! >= schemaIndex || [...content.matchAll(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi)].some(block => m.index! >= block.index! && m.index! < block.index! + block[0].length)) shopifyFail("TITLE_TARGET_DYNAMIC");
  }
  if (edit.kind === "visible_heading" && /[{%}]/.test(edit.expected)) shopifyFail("TITLE_TARGET_DYNAMIC");
  const managed = edit.expected.match(/^{% if request.page_type == 'index' %}[^{}]*{% else %}([\s\S]+){% endif %}{% comment %}aibrain-home-title{% endcomment %}$/);
  if (edit.kind === "homepage_seo_title" && /aibrain-home-title/.test(edit.expected) && !managed) shopifyFail("TITLE_TARGET_AMBIGUOUS");
  const originalTitleBody = managed ? managed[1] : edit.expected;
  const body = edit.kind === "visible_heading" ? escape(edit.title) : `{% if request.page_type == 'index' %}${escape(edit.title)}{% else %}${originalTitleBody}{% endif %}{% comment %}aibrain-home-title{% endcomment %}`;
  const next = old.replace(edit.kind === "visible_heading" ? edit.expected : m[1], () => body);
  if (next === old) shopifyFail("TITLE_NO_CHANGE");
  const after = content.slice(0, m.index) + next + content.slice(m.index! + old.length);
  if (Buffer.byteLength(after) > THEME_FILE_LIMIT) shopifyFail("THEME_FILE_TOO_LARGE");
  return after;
}
export class ThemeEditStore {
  private root: string;
  private locks: ResourceLockManager;
  constructor(dataRoot: string, private now = Date.now) {
    this.root = path.join(path.resolve(dataRoot), "connectors", "shopify-theme-edits");
    this.locks = new ResourceLockManager({ rootDirectory: path.join(this.root, "locks"), defaultTimeoutMs: 120_000 });
  }
  private async ready() {
    for (const dir of [path.dirname(path.dirname(this.root)), path.dirname(this.root), this.root, path.join(this.root, "locks")]) {
      await mkdir(dir, { recursive: true, mode: 0o700 }); const s = await lstat(dir);
      if (!s.isDirectory() || s.isSymbolicLink() || await realpath(dir) !== dir) shopifyFail("STORAGE_UNSAFE");
      if (dir === this.root || dir.endsWith("/locks")) await chmod(dir, 0o700);
    }
  }
  private async save(p: Plan, status: Plan["status"]) {
    p.status = status; p.events.push({ status, at: new Date(this.now()).toISOString() });
    await atomicWriteFile(path.join(this.root, `${p.id}.json`), JSON.stringify(p), { mode: 0o600 });
  }
  private async load(id: string, actor: string, threadId: string): Promise<Plan> {
    if (!/^[a-f0-9]{64}$/.test(id)) shopifyFail("PLAN_INVALID");
    const p = JSON.parse((await readRegularFileWithin(this.root, `${id}.json`, 2_000_000)).toString("utf8")) as Plan;
    if (p.id !== id || p.actor !== actor || p.threadId !== threadId || p.beforeHash !== themeHash(p.before) || p.afterHash !== themeHash(p.after)) shopifyFail("PLAN_DENIED");
    if (p.kind === "theme_file") themeFileEdit({ themeId: p.themeId, kind: p.kind, filename: p.filename, beforeHash: p.beforeHash, summary: p.summary, changes: p.changes });
    else titleEdit({ themeId: p.themeId, kind: p.kind, filename: p.filename, title: p.title, expected: p.expected, ...(p.sectionId ? { sectionId: p.sectionId, settingId: p.settingId } : {}) });
    return p;
  }
  private summary(p: Plan) {
    const common = { planId: p.id, themeId: p.themeId, filename: p.filename, beforeHash: p.beforeHash, afterHash: p.afterHash, expiresAt: new Date(p.expiresAt).toISOString(), status: p.status, editorUrl: `https://admin.shopify.com/store/c7f82c-f0/themes/${p.themeId}/editor`, previewRequiresShopifySession: true, published: false };
    return p.kind === "theme_file" ? { ...common, kind: p.kind, summary: p.summary, changes: p.changes }
      : { ...common, kind: p.kind, expected: p.expected, title: p.title, ...(p.sectionId ? { sectionId: p.sectionId, settingId: p.settingId } : {}) };
  }
  async prepare(provider: ThemeProvider, actor: string, threadId: string, version: number, policyHash: string, input: unknown) {
    const edit = (input as { kind?: unknown } | null)?.kind === "theme_file" ? themeFileEdit(input) : titleEdit(input); await this.ready();
    const before = await provider.read(edit.themeId, edit.filename), after = edit.kind === "theme_file" ? patchThemeFile(before, edit) : patchTitle(before, edit);
    const p: Plan = { ...edit, id: randomBytes(32).toString("hex"), actor, threadId, version, policyHash, expiresAt: this.now() + 300_000, before, after, beforeHash: themeHash(before), afterHash: themeHash(after), status: "prepared", events: [] };
    // Durable complete original exists before any provider mutation.
    await this.save(p, "prepared"); return this.summary(p);
  }
  private approvalActionKey(locator: ApprovalLocator) { return themeHash(JSON.stringify([locator.installationId, locator.userId, locator.threadId, locator.turnId, locator.itemId, locator.approvalId])); }
  async bindApprovalAction(locator: ApprovalLocator, planId: string, rollback: boolean, fingerprint: string) {
    await this.ready(); await this.load(planId, locator.userId, locator.threadId);
    const action = { locator, planId, rollback, fingerprint }, key = this.approvalActionKey(locator);
    await this.locks.withLock(`approval:${key}`, async () => {
      const existing = await this.approvalAction(locator);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(action)) shopifyFail("THEME_APPROVAL_STALE");
        return;
      }
      await atomicWriteFile(path.join(this.root, `approval-${key}.json`), JSON.stringify(action), { mode: 0o600 });
    });
  }
  async approvalAction(locator: ApprovalLocator) {
    await this.ready();
    let text: string;
    try { text = (await readRegularFileWithin(this.root, `approval-${this.approvalActionKey(locator)}.json`, 8192)).toString("utf8"); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null; throw error; }
    const action = JSON.parse(text) as { locator: ApprovalLocator; planId: string; rollback: boolean; fingerprint: string };
    if (JSON.stringify(action.locator) !== JSON.stringify(locator) || !/^[a-f0-9]{64}$/.test(action.planId) || !/^[a-f0-9]{64}$/.test(action.fingerprint) || typeof action.rollback !== "boolean") shopifyFail("THEME_APPROVAL_STALE");
    await this.load(action.planId, locator.userId, locator.threadId);
    return action;
  }
  /** Bind the call to its direct user message before dispatch. Completed calls
   * cannot target another plan or reapply an already undone change. */
  async executeChatAction(binding: { installationId: string; userId: string; threadId: string; turnId: string; itemId: string; userMessageId: string; requestHash: string; permissionFingerprint: string }, planId: string, rollback: boolean, policyHash: string, execute: () => Promise<ReturnType<ThemeEditStore["summary"]>>) {
    await this.ready();
    const key = themeHash(JSON.stringify([binding.installationId, binding.userId, binding.threadId, binding.turnId, binding.itemId]));
    const filename = path.join(this.root, `chat-${key}.json`);
    return this.locks.withLock(`chat:${key}`, async () => {
      const identity = { ...binding, planId, rollback, policyHash };
      let previous: { identity: typeof identity; completed: boolean } | null = null;
      try { previous = JSON.parse((await readRegularFileWithin(this.root, `chat-${key}.json`, 8192)).toString("utf8")); }
      catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
      if (previous && JSON.stringify(previous.identity) !== JSON.stringify(identity)) shopifyFail("THEME_CHAT_STALE");
      // Even completed requests go through fresh provider readback. The engine
      // returns an applied/restored plan without dispatching again; if it was
      // undone or changed externally, an old request cannot claim fresh success.
      await atomicWriteFile(filename, JSON.stringify({ identity, completed: false }), { mode: 0o600 });
      // The engine marks dispatch before writing and reconciles unknown effects
      // from exact provider hashes without repeating the mutation.
      const result = await execute();
      await atomicWriteFile(filename, JSON.stringify({ identity, completed: true }), { mode: 0o600 });
      return result;
    });
  }
  async inspect(id: string, actor: string, threadId: string) { await this.ready(); return this.summary(await this.load(id, actor, threadId)); }
  async execute(provider: ThemeProvider, actor: string, threadId: string, version: number, policyHash: string, id: string, rollback = false, beforeDispatch?: () => Promise<void>) {
    await this.ready();
    const initial = await this.load(id, actor, threadId);
    return this.locks.withLock(`theme:${initial.themeId}`, async () => {
      const p = await this.load(id, actor, threadId);
      if (p.policyHash !== policyHash) shopifyFail("PLAN_STALE");
      if (!rollback && (p.version !== version || p.expiresAt <= this.now()) && p.status === "prepared") shopifyFail("PLAN_STALE");
      const current = await provider.read(p.themeId, p.filename), hash = themeHash(current);
      const lastAttempt = [...p.events].reverse().find(e => ["executing", "rolling_back"].includes(e.status))?.status;
      if (rollback && p.status === "prepared") shopifyFail("ROLLBACK_NOT_APPLIED");
      if (rollback && hash === p.beforeHash && (["rolled_back", "rolling_back"].includes(p.status) || p.status === "indeterminate" && lastAttempt === "rolling_back")) { if (p.status !== "rolled_back") await this.save(p, "rolled_back"); return this.summary(p); }
      if (!rollback && hash === p.afterHash && ["applied", "executing", "indeterminate"].includes(p.status)) { if (p.status !== "applied") await this.save(p, "applied"); return this.summary(p); }
      if (hash !== (rollback ? p.afterHash : p.beforeHash)) shopifyFail("THEME_CHANGED_CONFLICT");
      if (!rollback && p.status !== "prepared" || rollback && (! ["applied", "indeterminate", "executing"].includes(p.status) || lastAttempt === "rolling_back")) shopifyFail("WRITE_NOT_RETRYABLE");
      await beforeDispatch?.();
      await this.save(p, rollback ? "rolling_back" : "executing");
      await beforeDispatch?.();
      try { await provider.write(p.themeId, p.filename, rollback ? p.before : p.after, beforeDispatch); }
      catch { /* A timeout/job may have applied the effect. The readback below is authoritative. */ }
      let actual;
      try { actual = themeHash(await provider.read(p.themeId, p.filename)); }
      catch { await this.save(p, "indeterminate"); shopifyFail("THEME_WRITE_INDETERMINATE"); }
      if (actual !== (rollback ? p.beforeHash : p.afterHash)) { await this.save(p, "indeterminate"); shopifyFail("THEME_WRITE_INDETERMINATE"); }
      await this.save(p, rollback ? "rolled_back" : "applied"); return this.summary(p);
    });
  }
}
