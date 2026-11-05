import { loadInstallationConfig } from "../src/config/installation";
import { ComposioApi, ComposioError } from "../src/connectors/composio-api";
import { provisionComposioToolkit, resolveComposioToolkit } from "../src/connectors/composio-provisioning";

// Administrative repair only. Never creates connected accounts or grants user access.
// Bundle with server-only aliased to scripts/server-only-stub.mjs for container use.
const args = process.argv.slice(2);
const installationId = args.find(arg => arg.startsWith("--installation="))?.slice(15);
const config = await loadInstallationConfig();
if (!installationId || installationId !== config.installationId) throw new Error("Installation identity must match --installation.");
const apply = args.includes("--apply");
const api = new ComposioApi(process.env.AIBRAIN_COMPOSIO_API_KEY ?? "");
for (const toolkit of config.connectors?.composio?.toolkits ?? []) {
  try {
    const resolved = apply ? await provisionComposioToolkit(config, toolkit) : await resolveComposioToolkit(config, toolkit);
    if (resolved.authConfigId === "on-connect") {
      console.log(JSON.stringify({ toolkit: toolkit.slug, status: "needs_provisioning" }));
      continue;
    }
    await api.verifyConfig(resolved);
    const tools = await api.tools(resolved);
    console.log(JSON.stringify({ toolkit: toolkit.slug, status: "ready_for_personal_authorization", readTools: tools.length }));
  } catch (error) {
    console.log(JSON.stringify({ toolkit: toolkit.slug, status: "failed", code: error instanceof ComposioError ? error.code : "COMPOSIO_UNAVAILABLE" }));
    process.exitCode = 1;
  }
}
