import path from "node:path";
import type { RuntimeConfig } from "@/runtime/config";

const PASSTHROUGH_ENVIRONMENT = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

export function buildWorkerEnvironment(
  config: RuntimeConfig,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const home = config.codexHome ?? path.join(config.workspace, ".codex-home");
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: source.NODE_ENV ?? "production",
    HOME: home,
    CODEX_HOME: home,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };

  for (const name of PASSTHROUGH_ENVIRONMENT) {
    const value = source[name];
    if (value) environment[name] = value;
  }
  return environment;
}
