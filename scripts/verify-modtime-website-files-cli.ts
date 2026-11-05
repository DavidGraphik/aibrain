/** Authorized operator acceptance, NOT merchant OAuth/chat acceptance.
 * Fixed draft, existing files, original backup, no publication, explicit restore.
 * Run apply, inspect the draft UI, then restore with the same evidence directory. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { ThemeEditStore, themeHash } from "../src/connectors/shopify-theme-edit";
import type { ThemeProvider } from "../src/connectors/shopify-themes-api";
const shop = "c7f82c-f0.myshopify.com", draft = "188630040825", live = "162192523513";
const files = ["templates/index.json", "assets/mariowatches-home.css", "templates/page.mt-edit-speed.json"];
const run = promisify(execFile), actor = "e5474187-2242-42e4-96a8-608212f5d027", thread = "operator-website-file-qa-20261010", policy = "explicit-draft-acceptance";
async function main() {
  if (process.argv.length !== 4 || !["--apply-authorized-draft-test", "--restore-authorized-draft-test"].includes(process.argv[2])) throw Error("Explicit phase and private evidence directory required");
  const root = path.resolve(process.argv[3]); await mkdir(root, { recursive: true, mode: 0o700 });
  const work = await realpath(await mkdtemp(path.join(root, "cli-"))), manifest = path.join(root, "acceptance.json");
  const cli = async (args: string[]) => {
    try { return (await run("/opt/homebrew/bin/shopify", ["theme", ...args, "--store", shop], { timeout: 120000, maxBuffer: 1000000, env: { ...process.env, SHOPIFY_CLI_NO_ANALYTICS: "1" } })).stdout; }
    catch { throw Error("SHOPIFY_CLI_FAILED_OUTPUT_REDACTED"); }
  };
  const guard = async () => {
    const list = JSON.parse(await cli(["list", "--json"])) as { id: number; role: string; name: string }[];
    if (list.find(t => String(t.id) === live)?.role !== "live" || list.find(t => String(t.id) === draft)?.role !== "unpublished") throw Error("THEME_ROLE_CHANGED");
    return list;
  };
  async function read(id: string, filename: string) {
    const destination = await mkdtemp(path.join(work, "pull-"));
    await cli(["pull", "--theme", id, "--path", destination, "--only", filename, "--no-color"]);
    return readFile(path.join(destination, filename), "utf8");
  }
  const provider: ThemeProvider = {
    drafts: async () => (await guard()).filter(t => String(t.id) === draft).map(t => ({ id: draft, name: t.name, role: "UNPUBLISHED" })),
    read: async (id, filename) => { if (id !== draft || !files.includes(filename)) throw Error("SCOPE_DENIED"); await guard(); return read(id, filename); },
    write: async (id, filename, content) => {
      if (id !== draft || !files.includes(filename)) throw Error("SCOPE_DENIED"); await guard();
      const destination = await mkdtemp(path.join(work, "push-")); await mkdir(path.dirname(path.join(destination, filename)), { recursive: true });
      await writeFile(path.join(destination, filename), content, { mode: 0o600 });
      await cli(["push", "--theme", draft, "--path", destination, "--only", filename, "--nodelete", "--json"]);
    },
  };
  type Result = { filename: string; planId: string; beforeHash: string; afterHash: string; status: string };
  type Evidence = { draft: string; liveHash: string; phase: string; merchantOAuthVerified: false; results: Result[]; capturedAt: string };
  const store = new ThemeEditStore(root);
  const save = (e: Evidence) => writeFile(manifest, JSON.stringify(e, null, 2), { mode: 0o600 });
  if (process.argv[2] === "--restore-authorized-draft-test") {
    const e = JSON.parse(await readFile(manifest, "utf8")) as Evidence;
    if (e.draft !== draft) throw Error("EVIDENCE_SCOPE_DENIED");
    for (const result of [...e.results].reverse()) {
      const current = await provider.read(draft, result.filename);
      if (themeHash(current) === result.beforeHash) { result.status = "original-unchanged"; await save(e); continue; }
      const restored = await store.execute(provider, actor, thread, 1, policy, result.planId, true);
      result.status = restored.status; await save(e);
    }
    if (themeHash(await read(live, "layout/theme.liquid")) !== e.liveHash) throw Error("PUBLISHED_LAYOUT_CHANGED");
    e.phase = "restored-and-live-unchanged"; await save(e); console.log(e); return;
  }
  try { await readFile(manifest); throw Error("EVIDENCE_ALREADY_EXISTS_RESTORE_FIRST"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const e: Evidence = { draft, liveHash: themeHash(await read(live, "layout/theme.liquid")), phase: "preparing", merchantOAuthVerified: false, results: [], capturedAt: new Date().toISOString() }; await save(e);
  for (const filename of files) {
    const original = await provider.read(draft, filename);
    let expected: string, replacement: string;
    if (filename === files[0]) {
      const data = JSON.parse(original.replace(/^\s*\/\*[\s\S]*?\*\//, ""));
      const video = data.sections.mariowatches_home.settings.hero_video;
      const other = data.sections.video_Ryew9t.settings.video;
      if (!video?.startsWith("shopify://files/videos/") || !other?.startsWith("shopify://files/videos/") || other === video) throw Error("EXISTING_VIDEO_REQUIRED");
      expected = `"hero_video": ${JSON.stringify(video)}`; replacement = `"hero_video": ${JSON.stringify(other)}`;
    } else if (filename === files[1]) {
      expected = original.slice(-100); replacement = expected + "\n/* Reversible MODTIME QA */\n.mw-home__display{letter-spacing:.03em}\n";
    } else {
      const data = JSON.parse(original.replace(/^\s*\/\*[\s\S]*?\*\//, ""));
      const options = data.sections["mt-opt-12-1-0"];
      const blue = Object.values(options.blocks).find((b) => (b as { settings: { title: string } }).settings.title === "Blue");
      if (!blue || !options.block_order.length) throw Error("EXISTING_COMPATIBLE_OPTION_REQUIRED");
      const next = structuredClone(options);
      next.blocks["qa_blue_preview"] = structuredClone(blue);
      next.blocks.qa_blue_preview.settings.title = "Blue — QA preview";
      next.blocks.qa_blue_preview.settings.is_default = false;
      next.block_order.push("qa_blue_preview");
      expected = JSON.stringify(options, null, 2).split("\n").map((line, i) => i ? "    " + line : line).join("\n");
      replacement = JSON.stringify(next, null, 2).split("\n").map((line, i) => i ? "    " + line : line).join("\n");
    }
    const plan = await store.prepare(provider, actor, thread, 1, policy, { themeId: draft, kind: "theme_file", filename, beforeHash: themeHash(original), summary: `Reversible operator QA: ${filename}`, changes: [{ expected, replacement }] });
    e.results.push({ filename, planId: plan.planId, beforeHash: plan.beforeHash, afterHash: plan.afterHash, status: plan.status }); await save(e);
    const applied = await store.execute(provider, actor, thread, 1, policy, plan.planId);
    e.results[e.results.length - 1].status = applied.status; await save(e); console.log({ filename, status: applied.status });
  }
  e.phase = "applied-awaiting-ui-and-restore"; await save(e);
}
main().catch(() => { console.error("MODTIME_WEBSITE_QA_FAILED_SEE_PRIVATE_BACKUPS_RESTORE_REQUIRED"); process.exitCode = 1; });
