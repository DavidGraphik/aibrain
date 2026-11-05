import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
vi.mock("server-only", () => ({}));
import { ThemeEditStore, patchTitle, titleEdit } from "./shopify-theme-edit";
import type { ThemeProvider } from "./shopify-themes-api";
const id = "162490319097", actor = "actor", thread = "thread";
const edit = { themeId: id, kind: "homepage_seo_title" as const, filename: "layout/theme.liquid", expected: "{{ page_title }}", title: "My watch & yours" };
let root: string, store: ThemeEditStore, content: string, clock: number, provider: ThemeProvider;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "theme-edit-test-"))); clock = Date.now(); store = new ThemeEditStore(root, () => clock);
  content = '<head><title>{{ page_title }}</title></head><h1>Unchanged</h1>';
  provider = { drafts: vi.fn(), read: vi.fn(async () => content), write: vi.fn(async (_id, _file, text) => { content = text; }) };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it("edits homepage SEO separately from the visible heading, escapes text and preserves other page behavior", () => {
  const next = patchTitle(content, edit);
  expect(next).toContain("if request.page_type == 'index'"); expect(next).toContain("My watch &amp; yours"); expect(next).toContain("{% else %}{{ page_title }}{% endif %}"); expect(next).toContain("<h1>Unchanged</h1>");
  const repeated = patchTitle(next, { ...edit, expected: next.match(/<title>([\s\S]*?)<\/title>/)![1], title: "Second" });
  expect(repeated.match(/request.page_type/g)).toHaveLength(1); expect(repeated).toContain("{% else %}{{ page_title }}");
});
it("rejects a published/unknown theme, raw code, arbitrary files, ambiguous headings and dynamic targets", () => {
  for (const patch of [{ themeId: "162192523513" }, { themeId: "foreign" }, { filename: "../secrets" }, { title: "{{ dangerous }}" }, { kind: "store_name" }, { extra: true }]) expect(() => titleEdit({ ...edit, ...patch })).toThrow();
  expect(() => patchTitle('<title>{{ page_title }}</title><title>another</title>', edit)).toThrow("AMBIGUOUS");
  const visible = { ...edit, kind: "visible_heading" as const, filename: "sections/banner.liquid", expected: "Hi" };
  expect(() => patchTitle('<h1>Hi</h1><h2>Hi</h2>', visible)).toThrow("AMBIGUOUS");
  expect(patchTitle('<h1>Hi</h1><title>SEO</title>', visible)).toContain('<title>SEO</title>');
});
it("changes exactly one active homepage title setting while preserving JSON bytes elsewhere", () => {
  const json = '/* header */\n{"sections":{"hero":{"settings":{"title":"Old","price":100}}},"order":["hero"]}';
  const setting = titleEdit({ ...edit, kind: "visible_heading", filename: "templates/index.json", sectionId: "hero", settingId: "title", expected: "Old" });
  expect(patchTitle(json, setting)).toBe(json.replace('"Old"', '"My watch &amp; yours"'));
  expect(() => patchTitle(json, { ...setting, sectionId: "missing" })).toThrow();
  expect(() => patchTitle(json.replace('"settings":', '"disabled":true,"settings":'), setting)).toThrow();
});
it("backs up before any write, binds actor/thread/version/policy, reads back and restores the exact original", async () => {
  const original = content, plan = await store.prepare(provider, actor, thread, 1, "policy", edit);
  expect(provider.write).not.toHaveBeenCalled();
  const backup = JSON.parse(await readFile(path.join(root, 'connectors/shopify-theme-edits', `${plan.planId}.json`), 'utf8'));
  expect(backup.before).toBe(original);
  await expect(store.execute(provider, "other", thread, 1, "policy", plan.planId)).rejects.toThrow("PLAN_DENIED");
  await expect(store.execute(provider, actor, "foreign", 1, "policy", plan.planId)).rejects.toThrow("PLAN_DENIED");
  await expect(store.execute(provider, actor, thread, 2, "policy", plan.planId)).rejects.toThrow("STALE");
  await expect(store.execute(provider, actor, thread, 1, "changed", plan.planId)).rejects.toThrow("STALE");
  expect((await store.execute(provider, actor, thread, 1, "policy", plan.planId)).status).toBe("applied");
  expect((await store.execute(provider, actor, thread, 1, "policy", plan.planId)).status).toBe("applied"); expect(provider.write).toHaveBeenCalledTimes(1);
  clock += 600_000; // Restoring an applied plan remains possible after preparation expires.
  expect((await store.execute(provider, actor, thread, 2, "policy", plan.planId, true)).status).toBe("rolled_back");
  expect(content).toBe(original); expect(provider.write).toHaveBeenCalledTimes(2);
});
it("refuses a stale plan or concurrent asset edits without overwriting them", async () => {
  const plan = await store.prepare(provider, actor, thread, 1, "policy", edit);
  clock += 400_000; await expect(store.execute(provider, actor, thread, 1, "policy", plan.planId)).rejects.toThrow("STALE");
  clock -= 400_000; content += "Concurrent edit"; await expect(store.execute(provider, actor, thread, 1, "policy", plan.planId)).rejects.toThrow("CONFLICT"); expect(provider.write).not.toHaveBeenCalled();
});
it("serializes concurrent calls and reconciles lost acknowledgements without resending a mutation", async () => {
  const plan = await store.prepare(provider, actor, thread, 1, "policy", edit);
  provider.write = vi.fn(async (_id, _file, text) => { content = text; throw Error("lost provider ack"); });
  await Promise.all([store.execute(provider, actor, thread, 1, "policy", plan.planId), store.execute(provider, actor, thread, 1, "policy", plan.planId)]);
  expect(provider.write).toHaveBeenCalledTimes(1);
});
it("keeps an uncertain mutation blocked instead of blindly retrying", async () => {
  const plan = await store.prepare(provider, actor, thread, 1, "policy", edit);
  provider.write = vi.fn(async () => { throw Error("timeout"); });
  await expect(store.execute(provider, actor, thread, 1, "policy", plan.planId)).rejects.toThrow("INDETERMINATE");
  await expect(store.execute(provider, actor, thread, 1, "policy", plan.planId)).rejects.toThrow("NOT_RETRYABLE"); expect(provider.write).toHaveBeenCalledTimes(1);
});
it("persists and reverses general draft edits, retaining the complete original and rejecting concurrent rollback", async () => {
  const { themeHash } = await import("./shopify-theme-edit");
  const original = content;
  const plan = await store.prepare(provider, actor, thread, 1, "policy", { themeId: "188630040825", kind: "theme_file", filename: "sections/hero.liquid", beforeHash: themeHash(content), summary: "Adjust homepage design", changes: [{ expected: "Unchanged", replacement: "MODTIME" }] });
  expect(plan).toMatchObject({ kind: "theme_file", summary: "Adjust homepage design", published: false });
  const applied = await store.execute(provider, actor, thread, 1, "policy", plan.planId);
  expect(applied.status).toBe("applied"); expect(content).toContain("MODTIME");
  content += "owner concurrent edit";
  await expect(store.execute(provider, actor, thread, 1, "policy", plan.planId, true)).rejects.toThrow("CONFLICT");
  content = content.replace("owner concurrent edit", "");
  expect((await store.execute(provider, actor, thread, 1, "policy", plan.planId, true)).status).toBe("rolled_back");
  expect(content).toBe(original);
});
it("revalidates chat authority after the fresh source read and before any dispatch", async () => {
  const plan = await store.prepare(provider, actor, thread, 1, "policy", edit);
  const revalidate = vi.fn(async () => { throw Error("MODTIME_SHOPIFY_THEME_INTERACTIVE_CHAT_REQUIRED"); });
  await expect(store.execute(provider, actor, thread, 1, "policy", plan.planId, false, revalidate)).rejects.toThrow("INTERACTIVE_CHAT_REQUIRED");
  expect(provider.read).toHaveBeenCalledTimes(2); expect(provider.write).not.toHaveBeenCalled();
  expect((await store.inspect(plan.planId, actor, thread)).status).toBe("prepared");
});
