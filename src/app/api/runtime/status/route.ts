import path from "node:path";
import { mkdir } from "node:fs/promises";
import { NextResponse } from "next/server";
import { readRuntimeConfig } from "@/runtime/config";
import type { RuntimeStatus } from "@/lib/runtime-status";
import { getSession } from "@/auth/session";
import { workerAppServerForUser } from "@/runtime/worker-runtime-service";
import { resolveWorkerOwnedPath } from "@/runtime/workers/provisioner";
import { WorkbenchNotFoundError } from "@/workbench/errors";
import {
  getProjectRuntimeContext,
  isBrowserPreviewWorkbench,
} from "@/workbench/store";

export const runtime = "nodejs";

const RUNTIME_STATUS_TIMEOUT_MS = 35_000;

function waitForRuntimeStatus<T>(operation: Promise<T>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Runtime status timed out.")), RUNTIME_STATUS_TIMEOUT_MS);
    timeout.unref?.();
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  }
  const requestedProjectId = new URL(request.url).searchParams.get("projectId");
  let projectContext = {
    projectId: null as string | null,
    projectName: session.tenant.name,
    workspaceKey: "workspace",
  };
  if (requestedProjectId) {
    if (isBrowserPreviewWorkbench()) {
      projectContext = {
        projectId: requestedProjectId,
        projectName: "Preview local",
        workspaceKey: "workspace",
      };
    } else {
      try {
        const stored = await getProjectRuntimeContext(session, requestedProjectId);
        projectContext = {
          projectId: stored.projectId,
          projectName: stored.projectName,
          workspaceKey: stored.workspaceKey,
        };
      } catch (error) {
        if (!(error instanceof WorkbenchNotFoundError)) throw error;
        return NextResponse.json({ error: "Projecte no trobat." }, { status: 404 });
      }
    }
  }
  const config = readRuntimeConfig(session.tenant.id, projectContext.workspaceKey);
  let codex: RuntimeStatus["codex"] = config.mode === "codex" ? "unavailable" : "disabled";
  let processWarm = false;
  let authenticationRequired = false;
  let imageInput = false;
  let skills: RuntimeStatus["skills"] = [];
  let webSearch = false;
  let imageGeneration = false;
  let workerWorkspace = config.workspace;

  if (config.mode === "codex") {
    try {
      const runtimeConnection = await waitForRuntimeStatus((async () => {
        const worker = await workerAppServerForUser(session.user.id);
        const workspace = await resolveWorkerOwnedPath(
          worker.handle.roots.workspace,
          path.posix.join("projects", projectContext.projectId ?? "default"),
        );
        await mkdir(workspace, { recursive: true, mode: 0o700 });
        const connection = await worker.client.connectionSummary();
        if (connection.connected) worker.client.prewarmConnection(workspace);
        return { connection, workspace };
      })());
      workerWorkspace = runtimeConnection.workspace;
      const connection = runtimeConnection.connection;
      codex = connection.connected ? "connected" : "unavailable";
      authenticationRequired = connection.authenticationRequired === true;
      processWarm = connection.processWarm;
      imageInput = connection.models.some((model) => model.inputModalities.includes("image"));
      skills = connection.skills;
      // Web is a server-side invariant for every connected Codex runtime.
      // Capability discovery is optional picker metadata and must never hold
      // readiness hostage or disable the live web tool.
      webSearch = connection.connected;
      imageGeneration = connection.imageGeneration;
    } catch {
      codex = "unavailable";
    }
  }

  const status: RuntimeStatus = {
    mode: config.mode,
    codex,
    isolated: config.mode === "codex",
    ready: config.mode === "codex" && codex === "connected",
    authenticationRequired,
    authMode: null,
    planType: null,
    processWarm,
    rateLimit: null,
    usage: null,
    workspaceName: `${projectContext.projectName} / ${path.basename(workerWorkspace)}`,
    model: null,
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    models: [],
    skills,
    capabilities: {
      webSearch,
      imageInput,
      imageGeneration,
    },
    tenantId: session.tenant.id,
    projectId: projectContext.projectId,
    projectName: projectContext.projectName,
  };

  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}
