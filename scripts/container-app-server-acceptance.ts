import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppServerRpcRouter } from "@/runtime/transport";
import { connectedAppConfig, SERVER_APPROVALS_REVIEWER } from "@/runtime/connected-app-config";
import { LocalGatewayWorkerRuntimeFactory } from "@/runtime/workers/local-gateway-runtime";
import { createQuotaToolPermissions, privateCodexToolPermissionsRequired, quotaToolPermissionConfigOverrides } from "@/runtime/quota-tool-permissions";
import type { ManagedWorkerRuntime, WorkerLaunchContext } from "@/runtime/workers/types";

const ACCEPTANCE_TIMEOUT_MS = 20_000;
const EXPECTED_CODEX_VERSION = "0.162.1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function withDeadline<T>(operation: Promise<T>, label: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} exceeded ${ACCEPTANCE_TIMEOUT_MS}ms.`)),
      ACCEPTANCE_TIMEOUT_MS,
    );
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function installationAcceptanceConfig() {
  const configPath = process.env.AIBRAIN_INSTALLATION_CONFIG?.trim()
    || "/etc/aibrain/installation.json";
  const config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  if (!isRecord(config) || !isRecord(config.paths) || typeof config.paths.usersRoot !== "string") {
    throw new Error("Installation usersRoot is unavailable for App Server acceptance.");
  }
  const usersRoot = path.resolve(config.paths.usersRoot);
  if (process.env.NODE_ENV === "production" && usersRoot !== "/var/lib/aibrain/data/users") {
    throw new Error("Production App Server acceptance requires the immutable users root.");
  }
  return { usersRoot, quotaToolPrivacy: privateCodexToolPermissionsRequired(config) };
}

async function createContext(usersRoot: string) {
  const userId = randomUUID();
  const userRoot = path.join(usersRoot, userId);
  const runtimeRoot = path.join(userRoot, "runtime");
  const xdgRoot = path.join(runtimeRoot, "xdg");
  const staging = path.join(userRoot, "staging");
  const context: WorkerLaunchContext = Object.freeze({
    installationId: "container-app-server-acceptance",
    userId,
    workerId: `worker-${userId}`,
    environment: Object.freeze({
      HOME: path.join(runtimeRoot, "home"),
      CODEX_HOME: path.join(runtimeRoot, "codex-home"),
      XDG_CACHE_HOME: path.join(xdgRoot, "cache"),
      XDG_CONFIG_HOME: path.join(xdgRoot, "config"),
      XDG_DATA_HOME: path.join(xdgRoot, "data"),
      XDG_STATE_HOME: path.join(xdgRoot, "state"),
      TMPDIR: path.join(staging, "tmp"),
    }),
    mounts: Object.freeze({
      runtimeReadOnly: Object.freeze([]),
      runtimeReadWrite: Object.freeze([
        runtimeRoot,
        path.join(userRoot, "workspace"),
        staging,
        path.join(userRoot, "artifacts"),
        path.join(userRoot, "audit", "transport"),
      ]),
      browserReadWrite: Object.freeze([]),
    }),
    workspace: path.join(userRoot, "workspace"),
    staging,
    artifacts: path.join(userRoot, "artifacts"),
    transportAudit: path.join(userRoot, "audit", "transport"),
    browser: Object.freeze({
      profile: path.join(userRoot, "browser", "profile"),
      downloads: path.join(userRoot, "browser", "downloads"),
    }),
  });
  await Promise.all([
    ...Object.values(context.environment).map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
    mkdir(context.workspace, { recursive: true, mode: 0o700 }),
    mkdir(path.join(context.staging, "threads"), { recursive: true, mode: 0o700 }),
    mkdir(context.artifacts, { recursive: true, mode: 0o700 }),
    mkdir(context.transportAudit, { recursive: true, mode: 0o700 }),
    mkdir(context.browser.profile, { recursive: true, mode: 0o700 }),
    mkdir(context.browser.downloads, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    writeFile(path.join(userRoot, "PROFILE.md"), "# Acceptance employee\n", { mode: 0o600 }),
    writeFile(path.join(userRoot, "PREFERENCES.md"), "# Acceptance preferences\n", { mode: 0o600 }),
    writeFile(path.join(userRoot, "PERMISSIONS.md"), "# Acceptance permissions\n", { mode: 0o600 }),
  ]);
  return { context, userRoot };
}

async function acceptOneGeneration(context: WorkerLaunchContext, generation: number, quotaToolPrivacy: boolean) {
  const runtime = new LocalGatewayWorkerRuntimeFactory({
    runtimeInstanceId: "container-acceptance",
    quotaToolPrivacy,
  }).create(context);
  const router = new AppServerRpcRouter(runtime.transport);
  try {
    await runtime.start();
    const initialize = await router.request({
      method: "initialize",
      id: `acceptance-initialize-${generation}-${randomUUID()}`,
      params: {
        clientInfo: {
          name: "aibrain_container_acceptance",
          title: "AiBrain Container Acceptance",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    }, 10_000);
    if (!isRecord(initialize)) throw new Error("Codex initialize returned an invalid result.");
    await router.notify({ method: "initialized" }, `acceptance-initialized-${generation}-${randomUUID()}`);
    const account = await router.request({
      method: "account/read",
      id: `acceptance-account-read-${generation}-${randomUUID()}`,
      params: { refreshToken: false },
    }, 10_000);
    if (!isRecord(account) || !("account" in account)) {
      throw new Error("Codex account/read returned an invalid result.");
    }
    // Exercise the production app-config reader before readiness. No model
    // turn is submitted, and the synthetic thread has no durable history.
    const opened = await router.request({
      method: "thread/start",
      id: `acceptance-thread-start-${generation}-${randomUUID()}`,
      params: {
        cwd: context.workspace,
        ephemeral: true,
        approvalPolicy: "never",
        approvalsReviewer: SERVER_APPROVALS_REVIEWER,
        sandbox: "read-only",
        config: connectedAppConfig([]),
      },
    }, 10_000);
    if (!isRecord(opened) || !isRecord(opened.thread) ||
        typeof opened.thread.id !== "string" || opened.thread.id.trim().length === 0) {
      throw new Error("Codex thread/start returned no synthetic thread identity.");
    }
    const health = await runtime.health();
    if (!health.healthy || health.state !== "running") {
      throw new Error("Private worker gateway was not healthy after App Server RPC acceptance.");
    }
  } finally {
    await Promise.allSettled([
      router.close(),
      runtime.transport.close(),
      stopRuntime(runtime),
    ]);
  }
}

async function stopRuntime(runtime: ManagedWorkerRuntime) {
  await runtime.stop();
}

/** Real kernel-backed denial probes; fixtures contain no credentials or tenant data. */
async function acceptPrivateToolFilesystem(context: WorkerLaunchContext) {
  const codexHome = context.environment.CODEX_HOME;
  const roots = { codexHome, workspace: context.workspace, transportAudit: context.transportAudit };
  const policy = createQuotaToolPermissions(roots);
  const denied = ["auth.json", "auth.json.backup", "config.toml", "sessions/probe.jsonl", "history.jsonl", "state_1.sqlite"]
    .map((name) => path.join(codexHome, name));
  denied.push(path.join(context.transportAudit, "probe.jsonl"));
  const allowed = ["skills/probe.txt", "plugins/probe.txt", "tmp/arg0/probe.txt"].map((name) => path.join(codexHome, name));
  for (const file of [...denied, ...allowed]) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, file.endsWith("config.toml") ? "# Synthetic privacy probe\n" : "{}", { mode: 0o600 });
  }
  const alias = path.join(context.workspace, "private-alias");
  await symlink(path.join(codexHome, "auth.json"), alias);
  const checks = { denied: [...denied, alias, path.join(codexHome, "skills", "..", "auth.json"),
    process.env.AIBRAIN_INSTALLATION_CONFIG || "/etc/aibrain/installation.json"], allowed, workspace: context.workspace };
  for (const [profile, writable] of [[policy.readOnlyId, false], [policy.workspaceWriteId, true]] as const) {
    const code = `const fs=require('node:fs');const c=${JSON.stringify(checks)};let ok=true;
      for(const p of c.denied){try{fs.readFileSync(p);ok=false;}catch(e){if(!['EACCES','EPERM','ENOENT'].includes(e.code))ok=false;}}
      for(const p of c.allowed){try{if(fs.readFileSync(p,'utf8')!=='{}')ok=false;}catch{ok=false;}}
      let wrote=false;try{fs.writeFileSync(c.workspace+'/document-probe.txt','synthetic document');wrote=true;}catch{}
      if(wrote!==${writable})ok=false;fs.writeSync(1,ok?'PRIVATE_FS_OK':'PRIVATE_FS_FAILED');process.exitCode=ok?0:1;`;
    const args = quotaToolPermissionConfigOverrides(roots).flatMap((override) => ["-c", override]);
    const result = spawnSync("/usr/local/bin/codex-real", [...args, "sandbox", "-P", profile, "-C", context.workspace,
      "--", "node", "-e", code], { cwd: context.workspace, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: "", CODEX_API_KEY: "", CODEX_ACCESS_TOKEN: "" } });
    // Never include process diagnostics: a future CLI could echo sensitive config.
    if (result.status !== 0 || result.stdout.trim() !== "PRIVATE_FS_OK") {
      const control = spawnSync("/usr/local/bin/codex-real", [...args, "sandbox", "-P", profile, "-C", context.workspace, "--", "/usr/bin/printf", "CONTROL_OK"],
        { cwd: context.workspace, encoding: "utf8", timeout: 20_000, env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: "", CODEX_API_KEY: "", CODEX_ACCESS_TOKEN: "" } });
      const diagnostic = result.stderr || "";
      const category = [/permission.*profile/i, /bwrap|bubblewrap/i, /unknown|unexpected|invalid/i, /config/i, /operation not permitted/i]
        .map((pattern, index) => pattern.test(diagnostic) ? index : -1).filter((index) => index >= 0);
      throw new Error(`Private filesystem acceptance failed (${writable ? "write" : "read"}; exit=${result.status}; checks=${result.stdout.trim() === "PRIVATE_FS_FAILED" ? "failed" : "not-run"}; stdoutBytes=${result.stdout.length}; control=${control.status}/${control.stdout === "CONTROL_OK"}; diagnostics=${category.join(",")}; spawn=${result.error?.name ?? "none"}).`);
    }
  }
  await rm(path.join(codexHome, "auth.json"));
  console.log(JSON.stringify({ privateFilesystemAcceptance: true, syntheticFixturesOnly: true,
    privateReadsDenied: true, symlinkAliasDenied: true, helperReadsAllowed: true, exactWorkspaceWriteAllowed: true }));
}

export async function runContainerAppServerAcceptance() {
  if (process.env.AIBRAIN_CODEX_EXPECTED_VERSION?.trim() !== EXPECTED_CODEX_VERSION) {
    throw new Error(`App Server acceptance requires Codex ${EXPECTED_CODEX_VERSION}.`);
  }
  const { usersRoot, quotaToolPrivacy } = await installationAcceptanceConfig();
  const { context, userRoot } = await createContext(usersRoot);
  try {
    await acceptPrivateToolFilesystem(context);
    await acceptOneGeneration(context, 1, quotaToolPrivacy);
    await acceptOneGeneration(context, 2, quotaToolPrivacy);
  } finally {
    await rm(userRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  withDeadline(runContainerAppServerAcceptance(), "Codex App Server container acceptance").then(
    () => process.stdout.write("Codex App Server container acceptance passed.\n"),
    (error: unknown) => {
      process.stderr.write(`Codex App Server container acceptance failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
      process.exitCode = 78;
    },
  );
}
