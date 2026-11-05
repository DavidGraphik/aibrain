import path from "node:path";

export type RuntimeConfig = {
  tenantId: string;
  mode: "demo" | "codex";
  codexBinary: string;
  codexHome: string | null;
  workspace: string;
  model: string | null;
  approvalPolicy: "never" | "on-request";
  sandbox: "read-only" | "workspace-write";
};

function configuredValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function absoluteRoot(value: string | null, variable: string) {
  if (value && !path.isAbsolute(value)) {
    throw new Error(`${variable} ha de ser una ruta absoluta.`);
  }
  return value;
}

function runtimeMode(): RuntimeConfig["mode"] {
  const configured = configuredValue(process.env.CHAT_RUNTIME);
  if (configured !== null && configured !== "demo") {
    if (configured !== "codex") {
      throw new Error("CHAT_RUNTIME ha de ser codex o demo.");
    }
  }
  const explicitPreviewDemo = process.env.VERCEL_ENV === "preview"
    && process.env.AIBRAIN_AUTH_MODE === "demo"
    && process.env.AIBRAIN_ENABLE_PREVIEW_DEMO === "1";
  if (explicitPreviewDemo) return "demo";
  if (configured === "codex") return "codex";
  if (process.env.NODE_ENV === "production" && !explicitPreviewDemo) {
    throw new Error("CHAT_RUNTIME=codex és obligatori en producció.");
  }
  return "demo";
}

export function readRuntimeConfig(tenantId: string, workspaceKey = "workspace"): RuntimeConfig {
  if (!/^[a-z0-9-]+$/.test(tenantId)) {
    throw new Error("Identificador de tenant no vàlid.");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(workspaceKey)) {
    throw new Error("Identificador de workspace no vàlid.");
  }
  const workspaceRoot = absoluteRoot(
    configuredValue(process.env.CODEX_WORKSPACE_ROOT),
    "CODEX_WORKSPACE_ROOT",
  ) ?? path.join(process.cwd(), "runtime", "tenants");
  const codexHomeRoot = absoluteRoot(
    configuredValue(process.env.CODEX_HOME_ROOT),
    "CODEX_HOME_ROOT",
  );

  return {
    tenantId,
    mode: runtimeMode(),
    codexBinary: configuredValue(process.env.CODEX_BIN) ?? "codex",
    codexHome: codexHomeRoot ? path.join(codexHomeRoot, tenantId) : null,
    workspace: workspaceKey === "workspace"
      ? path.join(workspaceRoot, tenantId, "workspace")
      : path.join(workspaceRoot, tenantId, "projects", workspaceKey),
    model: configuredValue(process.env.CODEX_MODEL),
    approvalPolicy:
      process.env.CODEX_APPROVAL_POLICY === "on-request" ? "on-request" : "never",
    sandbox:
      process.env.CODEX_SANDBOX === "read-only" ? "read-only" : "workspace-write",
  };
}
