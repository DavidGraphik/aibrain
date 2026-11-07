import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { loadInstallationConfig } from "../src/config/installation";
import { readModtimeMeta, modtimeReportingCapabilities } from "../src/connectors/modtime-reporting";
import { automationWorkspaceContext, visibleAutomationTasks } from "../src/automations/server-service";
import { FileAutomationStore } from "../src/automations/store";

async function main() {
  // docker exec does not inherit the entrypoint's exported authenticated proxy.
  if (process.env.MODTIME_OPERATOR_PROXY_READY !== "1") {
    const proxy = new URL(process.env.AIBRAIN_EGRESS_PROXY_URL ?? "");
    if (proxy.hostname !== "egress-gateway" || !process.env.AIBRAIN_EGRESS_SERVER_TOKEN) throw new Error("MODTIME_PROXY_REQUIRED");
    proxy.username = "aibrain"; proxy.password = process.env.AIBRAIN_EGRESS_SERVER_TOKEN;
    const child = spawn(process.execPath, process.argv.slice(1), { env: { ...process.env,
      MODTIME_OPERATOR_PROXY_READY: "1", NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxy.href, HTTPS_PROXY: proxy.href }, stdio: ["ignore", "inherit", "ignore"] });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("exit", code => { clearTimeout(timer); process.exitCode = code ?? 1; });
    return;
  }
  const config = await loadInstallationConfig();
  if (config.installationId !== "modtime" || process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.AIBRAIN_CODEX_AUTH_SCOPE !== "per-user" || process.env.AIBRAIN_SHARED_CODEX_AUTH_SOURCE) throw new Error("MODTIME_OWNER_CONFIGURATION_REQUIRED");
  const workspace = await automationWorkspaceContext(config);
  const ids = process.env.MODTIME_REPORTING_USER_IDS?.split(",") ?? [];
  if (ids.length !== 2 || ids.some(id => !workspace.users.some(u => u.userId === id && u.enabled))) throw new Error("MODTIME_ACTORS_REQUIRED");
  const tasks = (await Promise.all(workspace.users.map(u => new FileAutomationStore({ installationId: config.installationId, userId: u.userId, usersRoot: config.paths.usersRoot }).list()))).flat();
  const actors = [];
  for (const id of ids) {
    const capabilities = await modtimeReportingCapabilities(config.installationId, id);
    const modelAuthPresent = await lstat(path.join(config.paths.usersRoot, id, "runtime/codex-home/auth.json")).then(s => s.isFile() && !s.isSymbolicLink()).catch(() => false);
    const visible = visibleAutomationTasks(tasks, id, workspace, false);
    actors.push({ userId: id, modelAuthPresent, capabilities,
      tasks: visible.map(t => ({ id: t.id, name: t.name, state: t.state, access: t.access, audience: t.audience, schedule: t.schedule, timeZone: t.timeZone })) });
  }
  const meta = await readModtimeMeta(config.installationId, ids[0], { since: "2026-09-01", until: "2026-09-07" });
  process.stdout.write(JSON.stringify({ installationId: config.installationId, revision: process.env.AIBRAIN_REVISION,
    operatorReadback: true, authenticatedBrowserAcceptance: false, model: process.env.AIBRAIN_SERVER_MODEL,
    effort: process.env.AIBRAIN_SERVER_REASONING_EFFORT, authScope: "per-user", actors, meta }) + "\n");
}
void main().catch(() => { process.stdout.write('{"operatorReadback":false,"error":"MODTIME_READBACK_FAILED"}\n'); process.exitCode = 1; });
