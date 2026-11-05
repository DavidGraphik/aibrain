import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import type { ChatMessage } from "@/lib/chat-contract";

const USER_A = "0198b9f0-6631-7000-8000-000000000601";
const USER_B = "0198b9f0-6631-7000-8000-000000000602";
const USER_MESSAGE = "0198b9f0-6631-7000-8000-000000000611";
const TURN_ID = "0198b9f0-6631-7000-8000-000000000612";
const UPLOAD_ID = "0198b9f0-6631-7000-8000-000000000613";
const DECLINE_OPERATION = "0198b9f0-6631-7000-8000-000000000614";
const PUBLISH_OPERATION = "0198b9f0-6631-7000-8000-000000000615";
const EXPIRED_OPERATION = "0198b9f0-6631-7000-8000-000000000616";
const auth = vi.hoisted(() => ({ session: null as AuthSession | null }));

vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({
  getSession: vi.fn(async () => auth.session),
  isVercelPreviewDemoEnabled: () => false,
}));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: vi.fn(async () => true) }));

function session(userId: string): AuthSession {
  return {
    provider: "local",
    user: {
      id: userId,
      name: `User ${userId.slice(-3)}`,
      email: `${userId.slice(-3)}@example.test`,
    },
    tenant: { id: "publication-lab", name: "Publication Lab" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function message(id: string, role: ChatMessage["role"], status: ChatMessage["status"]): ChatMessage {
  return {
    id,
    role,
    content: role === "user" ? "Prepara el candidat" : "Candidat preparat",
    createdAt: new Date().toISOString(),
    status,
    activity: [],
    plan: [],
    approvals: [],
    diff: "",
    attachments: [],
    artifacts: [],
  };
}

function mutation(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

function allowPublishPolicy(userId: string) {
  return [
    "---",
    "schemaVersion: 1",
    "policyVersion: 2",
    "scope: user",
    "installationId: publication-lab",
    `userId: ${userId}`,
    "---",
    "",
    "# Permissions",
    "",
    "## Rules",
    "",
    "- `documents.publish` | publish | allow | Publish only through the explicit server confirmation flow.",
    "",
  ].join("\n");
}

describe("server-side publication routes", () => {
  let root: string;
  let previousConfig: string | undefined;
  let previousSecret: string | undefined;
  let previousAdmins: string | undefined;
  let previousMinimumFreeBytes: string | undefined;
  let previousMinimumFreeRatio: string | undefined;
  let threadId: string;
  let targetPath: string;

  beforeAll(async () => {
    previousConfig = process.env.AIBRAIN_INSTALLATION_CONFIG;
    previousSecret = process.env.AIBRAIN_PUBLICATION_SECRET;
    previousAdmins = process.env.AIBRAIN_ADMIN_USER_IDS;
    previousMinimumFreeBytes = process.env.AIBRAIN_MINIMUM_FREE_BYTES;
    previousMinimumFreeRatio = process.env.AIBRAIN_MINIMUM_FREE_RATIO;
    root = await mkdtemp(path.join(tmpdir(), "aibrain-publication-routes-"));
    const dataRoot = path.join(root, "data");
    const publishWriteRoot = path.join(root, "publish-rw");
    targetPath = path.join(publishWriteRoot, "knowledge", "approved.txt");
    await Promise.all([
      mkdir(dataRoot, { recursive: true, mode: 0o700 }),
      mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(targetPath, "official original", { mode: 0o600 });
    const configPath = path.join(root, "installation.json");
    await writeFile(configPath, `${JSON.stringify({
      schemaVersion: 1,
      installationId: "publication-lab",
      companyName: "Publication Lab",
      companySlug: "publication-lab",
      publicUrl: "http://localhost:3000",
      branding: {
        productName: "Publication Brain",
        logoPath: "/brand/logo.svg",
        faviconPath: "/brand/favicon.svg",
        accentColor: "#334455",
      },
      paths: {
        dataRoot,
        companyContextRoot: path.join(dataRoot, "company"),
        usersRoot: path.join(dataRoot, "users"),
        sourceReadRoot: path.join(root, "source-ro"),
        publishWriteRoot,
        backupsRoot: path.join(dataRoot, "backups"),
      },
    }, null, 2)}\n`, "utf8");
    process.env.AIBRAIN_INSTALLATION_CONFIG = configPath;
    process.env.AIBRAIN_PUBLICATION_SECRET = "publication-route-secret-with-more-than-thirty-two-bytes";
    process.env.AIBRAIN_ADMIN_USER_IDS = USER_A;
    process.env.AIBRAIN_MINIMUM_FREE_BYTES = "0";
    process.env.AIBRAIN_MINIMUM_FREE_RATIO = "0";

    const [
      { loadInstallationConfig },
      { UserProvisioner },
      { FileWorkbenchStore },
      { documentServicesForUser },
      { validateUploadedDocument },
    ] = await Promise.all([
      import("@/config/installation"),
      import("@/users/provisioner"),
      import("@/workbench/filesystem-store"),
      import("@/documents/server-service"),
      import("@/documents/upload-validation"),
    ]);
    const installation = await loadInstallationConfig();
    const provisioner = new UserProvisioner(installation);
    await provisioner.provision({ userId: USER_A, email: `${USER_A.slice(-3)}@example.test`, displayName: "User A" });
    await provisioner.provision({ userId: USER_B, email: `${USER_B.slice(-3)}@example.test`, displayName: "User B" });
    const policyPath = path.join(installation.paths.usersRoot, USER_A, "PERMISSIONS.md");
    await chmod(policyPath, 0o600);
    await writeFile(policyPath, allowPublishPolicy(USER_A), { mode: 0o600 });
    await chmod(policyPath, 0o400);

    const workbench = FileWorkbenchStore.fromInstallation(installation);
    const project = await workbench.createProject(USER_A, "Publication Operations");
    threadId = (await workbench.createThread(USER_A, project.id, "Publish candidate")).id;
    const assistant = message(TURN_ID, "assistant", "streaming");
    await workbench.beginThreadTurn(
      USER_A,
      threadId,
      message(USER_MESSAGE, "user", "complete"),
      assistant,
    );
    await workbench.finishThreadTurn(USER_A, threadId, { ...assistant, status: "complete" }, null);

    const data = Buffer.from("approved candidate");
    const services = await documentServicesForUser(installation, USER_A);
    const staged = await services.staging.stage({
      threadId,
      uploadId: UPLOAD_ID,
      data,
      validated: validateUploadedDocument({
        fileName: "approved.txt",
        declaredMimeType: "text/plain",
        data,
      }),
    });
    await services.previews.create(staged);
  });

  afterAll(async () => {
    auth.session = null;
    if (previousConfig === undefined) delete process.env.AIBRAIN_INSTALLATION_CONFIG;
    else process.env.AIBRAIN_INSTALLATION_CONFIG = previousConfig;
    if (previousSecret === undefined) delete process.env.AIBRAIN_PUBLICATION_SECRET;
    else process.env.AIBRAIN_PUBLICATION_SECRET = previousSecret;
    if (previousAdmins === undefined) delete process.env.AIBRAIN_ADMIN_USER_IDS;
    else process.env.AIBRAIN_ADMIN_USER_IDS = previousAdmins;
    if (previousMinimumFreeBytes === undefined) delete process.env.AIBRAIN_MINIMUM_FREE_BYTES;
    else process.env.AIBRAIN_MINIMUM_FREE_BYTES = previousMinimumFreeBytes;
    if (previousMinimumFreeRatio === undefined) delete process.env.AIBRAIN_MINIMUM_FREE_RATIO;
    else process.env.AIBRAIN_MINIMUM_FREE_RATIO = previousMinimumFreeRatio;
    await rm(root, { recursive: true, force: true });
  });

  async function freeze(operationId: string, clientRequestId: string) {
    const route = await import("@/app/api/threads/[threadId]/publications/route");
    return route.POST(mutation("http://localhost/publications", {
      operationId,
      clientRequestId,
      turnId: TURN_ID,
      uploadId: UPLOAD_ID,
      targetRelativePath: "knowledge/approved.txt",
    }), { params: Promise.resolve({ threadId }) });
  }

  it("declines without publishing and rejects cross-user scope", async () => {
    auth.session = session(USER_B);
    expect((await freeze(DECLINE_OPERATION, "freeze-decline")).status).toBe(404);

    auth.session = session(USER_A);
    const frozen = await freeze(DECLINE_OPERATION, "freeze-decline");
    expect(frozen.status).toBe(201);
    const receipt = await frozen.json() as { confirmationToken: string };
    const decision = await import("@/app/api/threads/[threadId]/publications/[operationId]/route");
    const declined = await decision.POST(mutation("http://localhost/decision", {
      action: "decline",
      clientRequestId: "decline-request",
      turnId: TURN_ID,
      confirmationToken: receipt.confirmationToken,
    }), { params: Promise.resolve({ threadId, operationId: DECLINE_OPERATION }) });
    expect(await declined.json()).toMatchObject({ operation: { status: "declined" } });
    expect(await readFile(targetPath, "utf8")).toBe("official original");
  });

  it("does not disclose recovered confirmations to unauthenticated or other users", async () => {
    const { GET } = await import("@/app/api/threads/[threadId]/publications/route");
    const request = new Request("http://localhost/publications");
    auth.session = null;
    expect((await GET(request, { params: Promise.resolve({ threadId }) })).status).toBe(401);
    auth.session = session(USER_B);
    expect((await GET(request, { params: Promise.resolve({ threadId }) })).status).toBe(404);
    auth.session = session(USER_A);
    expect((await GET(request, { params: Promise.resolve({ threadId: "invalid" }) })).status).toBe(400);
    const result = await GET(request, { params: Promise.resolve({ threadId }) });
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(await result.json()).toEqual({ publications: [] }); // Other installations keep local publication unchanged.
  });

  it("publishes exactly once and retains the original version", async () => {
    auth.session = session(USER_A);
    const frozen = await freeze(PUBLISH_OPERATION, "freeze-publish");
    const receipt = await frozen.json() as { confirmationToken: string };
    const decision = await import("@/app/api/threads/[threadId]/publications/[operationId]/route");
    const body = {
      action: "confirm",
      clientRequestId: "confirm-request",
      turnId: TURN_ID,
      confirmationToken: receipt.confirmationToken,
    };
    const first = await decision.POST(mutation("http://localhost/decision", body), {
      params: Promise.resolve({ threadId, operationId: PUBLISH_OPERATION }),
    });
    expect(await first.json()).toMatchObject({
      operation: {
        status: "published",
        version: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        result: { recoveredAfterInterruption: false },
      },
      permissionFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const replay = await decision.POST(mutation("http://localhost/decision", body), {
      params: Promise.resolve({ threadId, operationId: PUBLISH_OPERATION }),
    });
    expect(await replay.json()).toMatchObject({ operation: { status: "published" } });
    expect(await readFile(targetPath, "utf8")).toBe("approved candidate");
  });

  it("rejects an expired confirmation and closes it idempotently as expired", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
      auth.session = session(USER_A);
      const targetBefore = await readFile(targetPath, "utf8");
      const frozen = await freeze(EXPIRED_OPERATION, "freeze-expired");
      const receipt = await frozen.json() as { confirmationToken: string };
      vi.advanceTimersByTime(24 * 60 * 60 * 1_000);

      const decision = await import("@/app/api/threads/[threadId]/publications/[operationId]/route");
      const confirmation = await decision.POST(mutation("http://localhost/decision", {
        action: "confirm",
        clientRequestId: "confirm-expired",
        turnId: TURN_ID,
        confirmationToken: receipt.confirmationToken,
      }), { params: Promise.resolve({ threadId, operationId: EXPIRED_OPERATION }) });
      expect(confirmation.status).toBe(403);

      const declineBody = {
        action: "decline",
        clientRequestId: "close-expired",
        turnId: TURN_ID,
        confirmationToken: receipt.confirmationToken,
      };
      const closed = await decision.POST(mutation("http://localhost/decision", declineBody), {
        params: Promise.resolve({ threadId, operationId: EXPIRED_OPERATION }),
      });
      expect(await closed.json()).toMatchObject({
        operation: { status: "expired" },
        permissionFingerprint: null,
      });
      const replay = await decision.POST(mutation("http://localhost/decision", declineBody), {
        params: Promise.resolve({ threadId, operationId: EXPIRED_OPERATION }),
      });
      expect(await replay.json()).toMatchObject({ operation: { status: "expired" } });
      expect(await readFile(targetPath, "utf8")).toEqual(targetBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});
