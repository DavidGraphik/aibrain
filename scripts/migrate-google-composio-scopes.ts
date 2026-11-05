import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import scopes from "../config/connector-profiles/composio-google-standard-scopes-20260928.json";
import { loadInstallationConfig } from "../src/config/installation";
import { parseInstallationConfig } from "../src/config/installation-schema";
import { object } from "../src/connectors/composio-api";
import { resolveComposioToolkit, verifiedComposioScopes } from "../src/connectors/composio-provisioning";

// Operator-only, explicit scope migration. Does not authorize or revoke accounts.
// Bundle with server-only stub; run as app user through normal server egress.
const args = process.argv.slice(2);
const config = await loadInstallationConfig();
if (!args.includes(`--installation=${config.installationId}`) || !args.includes(`--public-url=${config.publicUrl}`)) {
  throw new Error("Both installation identity and public URL must match.");
}
const apply = args.includes("--apply");
const same = (a: unknown, b: unknown) => JSON.stringify(verifiedComposioScopes(a)) === JSON.stringify(verifiedComposioScopes(b));
async function request(route: string, body?: unknown) {
  const r = await fetch(`https://backend.composio.dev/api/v3${route}`, {
    method: body ? "PATCH" : "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "x-api-key": process.env.AIBRAIN_COMPOSIO_CATALOG_API_KEY ?? "", "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`Composio HTTP ${r.status}`);
  return await r.json();
}
const plan = [];
for (const [slug, desired] of Object.entries(scopes)) {
  const original = config.connectors?.composio?.toolkits.find(t => t.slug === slug);
  if (!original) continue;
  const toolkit = await resolveComposioToolkit(config, original);
  if (toolkit.authConfigId === "on-connect") throw new Error(`Provision ${slug} before migrating.`);
  const remote = await request(`/auth_configs/${toolkit.authConfigId}`);
  if (remote.id !== toolkit.authConfigId || remote.toolkit?.slug !== slug || remote.status !== "ENABLED" ||
      remote.auth_scheme !== "OAUTH2" || remote.is_composio_managed !== true || !object(remote.credentials)) {
    throw new Error(`Unexpected managed config identity for ${slug}`);
  }
  const before = verifiedComposioScopes(remote.credentials.scopes);
  if (!same(before, original.scopes) && !same(before, desired)) throw new Error(`Unexpected scope drift for ${slug}`);
  // Never silently adopt future provider-default expansions.
  const metadata = await request(`/toolkits/${slug}`);
  const defaults = metadata.auth_config_details?.find((a: { mode: string }) => a.mode === "OAUTH2")
    ?.fields?.auth_config_creation?.optional?.find((f: { name: string }) => f.name === "scopes")?.default;
  if (!same(defaults, desired)) throw new Error(`Provider defaults changed for ${slug}; review required.`);
  plan.push({ slug, authConfigId: toolkit.authConfigId, before, desired });
}
if (!plan.length) throw new Error("No Google toolkits in installation.");
const candidate = structuredClone(config);
for (const item of plan) {
  const toolkit = candidate.connectors!.composio!.toolkits.find(t => t.slug === item.slug)!;
  toolkit.scopes = item.desired;
  // Keep the same IDs so existing user bindings remain valid, including on-connect receipts.
  toolkit.authConfigId = item.authConfigId;
}
parseInstallationConfig(candidate);
if (apply) {
  const root = path.join(config.paths.dataRoot, "connectors", "composio", `google-scopes-${Date.now()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, "before.json"), JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
  await writeFile(path.join(root, "plan.json"), JSON.stringify(plan, null, 2), { mode: 0o600, flag: "wx" });
  const attempted: typeof plan = [];
  try {
    for (const item of plan) {
      if (!same(item.before, item.desired)) {
        attempted.push(item);
        await request(`/auth_configs/${item.authConfigId}`, { type: "default", scopes: item.desired.join(",") });
      }
      const verified = await request(`/auth_configs/${item.authConfigId}`);
      if (!same(verified.credentials?.scopes, item.desired)) throw new Error(`Readback failed for ${item.slug}`);
    }
    await writeFile(path.join(root, "installation.json"), JSON.stringify(candidate, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ candidate: path.join(root, "installation.json"), beforeSha256: createHash("sha256").update(JSON.stringify(config)).digest("hex") }));
  } catch (error) {
    let rollbackFailed = false;
    for (const item of attempted.reverse()) {
      try {
        await request(`/auth_configs/${item.authConfigId}`, { type: "default", scopes: item.before.join(",") });
        const verified = await request(`/auth_configs/${item.authConfigId}`);
        if (!same(verified.credentials?.scopes, item.before)) throw new Error("rollback readback");
      } catch { rollbackFailed = true; }
    }
    throw new Error(`Migration failed; rollback ${rollbackFailed ? "needs operator repair" : "verified"}`, { cause: error });
  }
}
console.log(JSON.stringify({ mode: apply ? "applied_remote_candidate_ready" : "read_only_plan", toolkits: plan.map(p => p.slug), readToolsUnchanged: true, existingAuthConfigIdsPreserved: true }));
