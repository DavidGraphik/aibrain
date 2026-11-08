import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { WorkerLaunchContext } from "./types";
import type { WorkerKernelLease } from "./kernel-ownership";
const EGRESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u;
const RUNTIME_INSTANCE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
export function workerTransportAuditRoot(
  transportAudit: string,
  runtimeInstanceId = process.env.AIBRAIN_RUNTIME_INSTANCE?.trim() || "app",
) {
  if (!RUNTIME_INSTANCE_ID.test(runtimeInstanceId)) {
    throw new Error("Worker runtime instance id is invalid.");
  }
  return path.join(transportAudit, "runtime-instances", runtimeInstanceId);
}

export function workerEgressEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const base = environment.AIBRAIN_EGRESS_PROXY_URL?.trim();
  const token = environment.AIBRAIN_EGRESS_WORKER_TOKEN?.trim();
  if (!base && !token && environment.NODE_ENV !== "production") return Object.freeze({});
  if (!base || !token || !EGRESS_TOKEN_PATTERN.test(token)) {
    throw new Error("Worker egress gateway URL and strong worker token are required.");
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch (error) {
    throw new Error("Worker egress gateway URL is invalid.", { cause: error });
  }
  const port = url.port ? Number(url.port) : 80;
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash || !url.hostname || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Worker egress gateway must be a credential-free HTTP origin.");
  }
  url.username = "aibrain";
  url.password = token;
  const authenticatedProxy = url.toString();
  const noProxy = "127.0.0.1,localhost,::1";
  return Object.freeze({
    HTTP_PROXY: authenticatedProxy,
    HTTPS_PROXY: authenticatedProxy,
    ALL_PROXY: authenticatedProxy,
    NO_PROXY: noProxy,
    // reqwest (used by Codex for ChatGPT token renewal) reads the lowercase
    // forms. Keep both spellings so browser/Node tools and the App Server use
    // the same authenticated, allowlisted worker channel.
    http_proxy: authenticatedProxy,
    https_proxy: authenticatedProxy,
    all_proxy: authenticatedProxy,
    no_proxy: noProxy,
  });
}

/** The same protected launcher/environment/lock handoff for both transports. */
export function spawnCodexWorker(context: WorkerLaunchContext, kernelOwner: WorkerKernelLease | null, configOverrides: readonly string[] = []) {
  return spawn(/* turbopackIgnore: true */ process.env.CODEX_BIN?.trim() || "codex",
    ["app-server", "--stdio", ...configOverrides.flatMap(value => ["-c", value])], {
      cwd: context.workspace,
      env: {
        NODE_ENV: process.env.NODE_ENV ?? "production", PATH: process.env.PATH,
        LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE,
        TZ: process.env.TZ, SSL_CERT_FILE: process.env.SSL_CERT_FILE, SSL_CERT_DIR: process.env.SSL_CERT_DIR,
        NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
        ...workerEgressEnvironment(), ...context.environment,
        ...(kernelOwner ? { AIBRAIN_WORKER_LOCK_FD: "3" } : {}),
      },
      stdio: kernelOwner ? ["pipe", "pipe", "pipe", kernelOwner.fd] : ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;
}
