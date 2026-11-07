/** Operator acceptance harness, NOT the production OAuth connector.
 * Uses David's already authenticated Shopify CLI session and the exact product
 * edit/backup/audit/readback/rollback engine. Never transfers CLI credentials. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { ThemeEditStore, themeHash } from "../src/connectors/shopify-theme-edit";
import type { ThemeProvider, DraftTheme } from "../src/connectors/shopify-themes-api";
const preview = "https://i2cgih0x70vpeii4cc2jko7n3hv8g-71332856057.shopifypreview.com/";
const run = promisify(execFile), shop = "c7f82c-f0.myshopify.com", draft = "162490319097", live = "162192523513";
async function main() {
if (process.argv.length !== 4 || process.argv[2] !== "--authorized-draft-test") throw Error("Explicit --authorized-draft-test <private-evidence-directory> required");
const root = path.resolve(process.argv[3]); await mkdir(root, { recursive: true, mode: 0o700 });
const work = await realpath(await mkdtemp(path.join(root, "cli-theme-")));
const cli = async (args: string[]) => {
  try { return (await run("shopify", ["theme", ...args, "--store", shop], { timeout: 120000, maxBuffer: 1000000, env: { ...process.env, SHOPIFY_CLI_NO_ANALYTICS: "1" } })).stdout; }
  catch { throw Error("SHOPIFY_CLI_CHECK_FAILED_OUTPUT_REDACTED"); }
};
const inventory = async () => JSON.parse(await cli(["list", "--json"])) as { id: number; role: string; name: string }[];
async function guard() {
  const list = await inventory();
  if (list.find(t => String(t.id) === live)?.role !== "live" || list.find(t => String(t.id) === draft)?.role !== "unpublished") throw Error("LIVE_OR_DRAFT_ROLE_CHANGED");
  return list;
}
async function read(id: string, filename: string) {
  const destination = await mkdtemp(path.join(work, "pull-"));
  await cli(["pull", "--theme", id, "--path", destination, "--only", filename, "--no-color"]);
  return readFile(path.join(destination, filename), "utf8");
}
const provider: ThemeProvider = {
  drafts: async () => (await guard()).filter(t => [draft, "188630040825"].includes(String(t.id))).map(t => ({ id: String(t.id), role: "UNPUBLISHED", name: t.name }) as DraftTheme),
  read: async (id, filename) => { if (id !== draft) throw Error("FIXED_DRAFT_REQUIRED"); await guard(); return read(id, filename); },
  write: async (id, filename, content) => {
    if (id !== draft || !["layout/theme.liquid", "templates/index.json"].includes(filename)) throw Error("FIXED_DRAFT_AND_FILE_REQUIRED");
    await guard(); const destination = await mkdtemp(path.join(work, "push-")); await mkdir(path.dirname(path.join(destination, filename)), { recursive: true });
    await writeFile(path.join(destination, filename), content, { mode: 0o600 });
    await cli(["push", "--theme", draft, "--path", destination, "--only", filename, "--nodelete", "--json"]);
  },
};
const evidence: Record<string, unknown> = { capturedAt: new Date().toISOString(), store: shop, draft, publishedTheme: live, implementationPath: "ThemeEditStore through authenticated operator Shopify CLI", authenticatedAiBrainChatVerified: false, productionOAuthVerified: false, results: [] };
const store = new ThemeEditStore(root);
const liveBefore = await read(live, "layout/theme.liquid");
const actor = "e5474187-2242-42e4-96a8-608212f5d027", thread = "operator-authorized-20261006";
let failed = false;
for (const kind of ["homepage_seo_title", "visible_heading"] as const) {
  const filename = kind === "homepage_seo_title" ? "layout/theme.liquid" : "templates/index.json";
  const original = await provider.read(draft, filename);
  const json = kind === "visible_heading" ? JSON.parse(original.replace(/^\s*\/\*[\s\S]*?\*\//, "")) : null;
  const sectionId = "collection_list_qqK8zD";
  const expected = kind === "homepage_seo_title" ? original.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)![1] : json.sections[sectionId].settings.title;
  const title = `MODTIME reversible AI Brain ${kind === "homepage_seo_title" ? "SEO" : "visible"} test 20261006`;
  const plan = await store.prepare(provider, actor, thread, 1, "operator-explicit-draft-test", { themeId: draft, kind, filename, expected, title, ...(kind === "visible_heading" ? { sectionId, settingId: "title" } : {}) });
  const result: Record<string, unknown> = { kind, filename, planId: plan.planId, beforeHash: plan.beforeHash, title, applied: false, restored: false };
  try {
    const applied = await store.execute(provider, actor, thread, 1, "operator-explicit-draft-test", plan.planId);
    result.applied = applied.status === "applied"; result.afterHash = applied.afterHash;
    const inspected = JSON.parse((await run("python3", ["-c", "import urllib.request,json,sys; r=urllib.request.urlopen(sys.argv[1],timeout=30); print(json.dumps({'status':r.status,'html':r.read().decode()}))", preview + `?_aibrain_test=${Date.now()}`], { timeout: 40000, maxBuffer: 4000000 })).stdout);
    const html = inspected.html as string;
    const renderedTheme = html.match(/Shopify.theme\s*=\s*({[^;]+})/)?.[1];
    if (!renderedTheme || String(JSON.parse(renderedTheme).id) !== draft || JSON.parse(renderedTheme).role !== "unpublished") throw Error("DRAFT_PREVIEW_IDENTITY_MISMATCH");
    result.previewHttp = inspected.status; result.previewThemeVerified = true; result.renderedTitleVerified = kind === "homepage_seo_title" ? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1].trim() === title : html.includes(title);
    if (!result.renderedTitleVerified) { result.renderedVerification = "preview_did_not_confirm_requested_text"; failed = true; }
  } catch { result.error = "DRAFT_TEST_FAILED_OUTPUT_REDACTED"; failed = true; }
  finally {
    try {
      const restored = await store.execute(provider, actor, thread, 1, "operator-explicit-draft-test", plan.planId, true);
      result.restored = restored.status === "rolled_back" && themeHash(await provider.read(draft, filename)) === themeHash(original);
      if (!result.restored) failed = true;
    } catch { result.restoreError = "RESTORATION_REQUIRES_OPERATOR_REVIEW"; failed = true; }
    (evidence.results as unknown[]).push(result);
    await writeFile(path.join(root, "real-draft-title-test.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
  if (!result.restored) break;
}
const liveAfter = await read(live, "layout/theme.liquid");
evidence.publishedLayoutHashBefore = themeHash(liveBefore); evidence.publishedLayoutHashAfter = themeHash(liveAfter); evidence.publishedLayoutUnchanged = themeHash(liveBefore) === themeHash(liveAfter);
evidence.finalThemeRoles = (await guard()).filter(t => [draft, "188630040825", live].includes(String(t.id))).map(t => ({ id: t.id, role: t.role }));
evidence.passed = !failed && evidence.publishedLayoutUnchanged;
await writeFile(path.join(root, "real-draft-title-test.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
process.stdout.write(JSON.stringify(evidence) + "\n"); process.exitCode = evidence.passed ? 0 : 1;

}
void main().catch(() => { process.stderr.write("Draft acceptance could not finish; inspect private evidence before any retry.\n"); process.exitCode = 1; });
