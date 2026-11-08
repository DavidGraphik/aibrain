import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { WorkerAppServerClient } from "@/runtime/worker-runtime-service";
import {
  LocalGatewayWorkerRuntimeFactory,
} from "@/runtime/workers/local-gateway-runtime";
import type {
  WorkerLaunchContext,
  WorkerRuntimeHandle,
} from "@/runtime/workers/types";
import { persistGeneratedImageArtifact } from "@/runtime/generated-image-artifacts";

const REAL_PROCESS_ENABLED = process.env.AIBRAIN_REAL_CODEX_APP_SERVER === "1";
const CODEX_BIN = process.env.AIBRAIN_REAL_CODEX_BIN?.trim() || "";
const AUTH_SOURCE = process.env.AIBRAIN_REAL_CODEX_AUTH_SOURCE?.trim() || "";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "11111111-1111-4111-8111-111111111112";
const THREAD_ID = "11111111-1111-4111-8111-111111111113";
const MESSAGE_ID = "11111111-1111-4111-8111-111111111114";
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function context(): Promise<WorkerLaunchContext> {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-real-app-server-"));
  roots.push(root);
  const userRoot = path.join(root, "users", USER_ID);
  const runtimeRoot = path.join(userRoot, "runtime");
  const codexHome = path.join(runtimeRoot, "codex-home");
  const workspace = path.join(userRoot, "workspace");
  const staging = path.join(userRoot, "staging");
  const artifacts = path.join(userRoot, "artifacts");
  const transportAudit = path.join(userRoot, "audit", "transport");
  const xdgRoot = path.join(runtimeRoot, "xdg");
  await Promise.all([
    mkdir(codexHome, { recursive: true, mode: 0o700 }),
    mkdir(path.join(runtimeRoot, "home"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(xdgRoot, "cache"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(xdgRoot, "config"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(xdgRoot, "data"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(xdgRoot, "state"), { recursive: true, mode: 0o700 }),
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(path.join(staging, "tmp"), { recursive: true, mode: 0o700 }),
    mkdir(artifacts, { recursive: true, mode: 0o700 }),
    mkdir(transportAudit, { recursive: true, mode: 0o700 }),
  ]);
  if (AUTH_SOURCE) await copyFile(AUTH_SOURCE, path.join(codexHome, "auth.json"));
  return {
    installationId: "real-process-qa",
    userId: USER_ID,
    workerId: `worker-${USER_ID}`,
    environment: {
      HOME: path.join(runtimeRoot, "home"),
      CODEX_HOME: codexHome,
      XDG_CACHE_HOME: path.join(xdgRoot, "cache"),
      XDG_CONFIG_HOME: path.join(xdgRoot, "config"),
      XDG_DATA_HOME: path.join(xdgRoot, "data"),
      XDG_STATE_HOME: path.join(xdgRoot, "state"),
      TMPDIR: path.join(staging, "tmp"),
    },
    mounts: {
      runtimeReadOnly: [],
      runtimeReadWrite: [runtimeRoot, workspace, staging, artifacts, transportAudit],
      browserReadWrite: [],
    },
    workspace,
    staging,
    artifacts,
    transportAudit,
    browser: {
      profile: path.join(userRoot, "browser", "profile"),
      downloads: path.join(userRoot, "browser", "downloads"),
    },
  };
}

async function startClient(workerContext: WorkerLaunchContext) {
  const factory = new LocalGatewayWorkerRuntimeFactory({
    runtimeInstanceId: "real-process-acceptance",
    processFactory: (launch) => spawn(CODEX_BIN, ["app-server", "--stdio"], {
      cwd: launch.workspace,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        LANG: process.env.LANG,
        ...launch.environment,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }),
  });
  const runtime = factory.create(workerContext);
  await runtime.start();
  const handle: WorkerRuntimeHandle = Object.freeze({
    installationId: workerContext.installationId,
    userId: workerContext.userId,
    workerId: workerContext.workerId,
    roots: Object.freeze({
      userRoot: path.dirname(workerContext.workspace),
      runtimeRoot: path.join(path.dirname(workerContext.workspace), "runtime"),
      codexHome: workerContext.environment.CODEX_HOME,
      home: workerContext.environment.HOME,
      xdgRoot: path.dirname(workerContext.environment.XDG_CACHE_HOME),
      xdgCache: workerContext.environment.XDG_CACHE_HOME,
      xdgConfig: workerContext.environment.XDG_CONFIG_HOME,
      xdgData: workerContext.environment.XDG_DATA_HOME,
      xdgState: workerContext.environment.XDG_STATE_HOME,
      workspace: workerContext.workspace,
      staging: workerContext.staging,
      stagingTemp: workerContext.environment.TMPDIR,
      artifacts: workerContext.artifacts,
      browserRoot: path.dirname(workerContext.browser.profile),
      browserProfile: workerContext.browser.profile,
      browserDownloads: workerContext.browser.downloads,
      auditRoot: path.dirname(workerContext.transportAudit),
      transportAudit: workerContext.transportAudit,
      manifest: path.join(path.dirname(workerContext.workspace), "worker.json"),
    }),
    transport: runtime.transport,
  });
  return { runtime, client: new WorkerAppServerClient(handle) };
}

describe.skipIf(!REAL_PROCESS_ENABLED)("real Codex App Server process acceptance", () => {
  it("initializes, reads account state, shuts down, and restarts on the durable gateway journals", async () => {
    expect(CODEX_BIN).not.toBe("");
    const workerContext = await context();

    const first = await startClient(workerContext);
    await expect(first.client.initialize()).resolves.toBeUndefined();
    await expect(first.client.connectionSummary()).resolves.toMatchObject({ processWarm: true });
    await first.client.close();
    await first.runtime.stop();

    const restarted = await startClient(workerContext);
    await expect(restarted.client.initialize()).resolves.toBeUndefined();
    await expect(restarted.client.connectionSummary()).resolves.toMatchObject({ processWarm: true });
    await restarted.client.close();
    await restarted.runtime.stop();
  }, 30_000);

  it("generates and persists real PNG bytes through the App Server image item", async () => {
    expect(CODEX_BIN).not.toBe("");
    const workerContext = await context();
    const started = await startClient(workerContext);
    try {
      await expect(started.client.capabilities()).resolves.toMatchObject({ imageGeneration: true });
      const threadResult = await started.client.request("thread/start", {
        cwd: workerContext.workspace,
        approvalPolicy: "never",
        dynamicTools: [],
        ephemeral: true,
        serviceName: "aibrain_image_delivery_acceptance",
      }, `real-image-thread:${THREAD_ID}`, 60_000);
      const runtimeThreadId = threadResult && typeof threadResult === "object" &&
        "thread" in threadResult && threadResult.thread && typeof threadResult.thread === "object" &&
        "id" in threadResult.thread && typeof threadResult.thread.id === "string"
        ? threadResult.thread.id
        : null;
      expect(runtimeThreadId).toBeTruthy();

      let imageItem: Record<string, unknown> | null = null;
      let resolveCompleted!: () => void;
      let rejectCompleted!: (error: Error) => void;
      const completed = new Promise<void>((resolve, reject) => {
        resolveCompleted = resolve;
        rejectCompleted = reject;
      });
      const registration = started.client.router.registerTurn(runtimeThreadId!, MESSAGE_ID, {
        onNotification(notification) {
          if (notification.method === "item/completed" && notification.params.item.type === "imageGeneration") {
            imageItem = notification.params.item as unknown as Record<string, unknown>;
          }
          if (notification.method === "turn/completed") resolveCompleted();
        },
        onServerRequest() {
          return {};
        },
        onFailure(error) {
          rejectCompleted(error);
        },
      });
      try {
        await started.client.request("turn/start", {
          threadId: runtimeThreadId,
          clientUserMessageId: MESSAGE_ID,
          input: [{
            type: "text",
            text: "Genera una imagen PNG sencilla: un círculo azul centrado sobre fondo blanco. Usa la herramienta de generación de imágenes.",
            text_elements: [],
          }],
          cwd: workerContext.workspace,
          approvalPolicy: "never",
          summary: "concise",
        }, `real-image-turn:${MESSAGE_ID}`, 60_000, (result) => {
          if (!result || typeof result !== "object" || !("turn" in result) || !result.turn ||
              typeof result.turn !== "object" || !("id" in result.turn) || typeof result.turn.id !== "string") {
            throw new Error("Real image turn did not return an id.");
          }
          registration.bindRuntimeTurn(result.turn.id);
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            completed,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => reject(new Error("Real image generation timed out.")), 240_000);
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      } finally {
        registration.dispose();
      }

      expect(imageItem).not.toBeNull();
      const isolatedRoot = path.resolve(workerContext.workspace, "../../..");
      const projectWorkspace = path.join(workerContext.workspace, "projects", PROJECT_ID);
      const dataRoot = path.join(isolatedRoot, "data");
      await Promise.all([
        mkdir(projectWorkspace, { recursive: true, mode: 0o700 }),
        mkdir(dataRoot, { recursive: true, mode: 0o700 }),
      ]);
      const installation = {
        installationId: "real-image-qa",
        paths: {
          dataRoot,
          usersRoot: path.join(isolatedRoot, "users"),
          companyContextRoot: path.join(dataRoot, "company"),
          sourceReadRoot: path.join(isolatedRoot, "source-ro"),
          publishWriteRoot: path.join(isolatedRoot, "publish-rw"),
          backupsRoot: path.join(dataRoot, "backups"),
        },
      };
      const artifact = await persistGeneratedImageArtifact(imageItem!, {
        installation,
        projectWorkspace,
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        messageId: MESSAGE_ID,
        storageOwnerId: USER_ID,
      });
      expect(artifact?.name).toMatch(/^[^.]+[.]png$/u);
      expect(artifact?.name).not.toContain(".png.json");
      const bytes = await readFile(path.join(dataRoot, `generated-image-artifacts/${artifact?.id}.png`));
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(bytes.byteLength).toBeGreaterThan(1_000);
    } finally {
      await started.client.close();
      await started.runtime.stop();
    }
  }, 300_000);
});
