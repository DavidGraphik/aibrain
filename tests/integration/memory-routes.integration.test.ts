import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";

const USER_A = "0198b9f0-6631-7000-8000-000000000701";
const USER_B = "0198b9f0-6631-7000-8000-000000000702";
const CREATE_REQUEST = "0198b9f0-6631-7000-8000-000000000711";
const REVOKE_REQUEST = "0198b9f0-6631-7000-8000-000000000712";
const auth = vi.hoisted(() => ({ session: null as AuthSession | null }));

vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({ getSession: vi.fn(async () => auth.session) }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: vi.fn(async () => true) }));

function session(userId: string): AuthSession {
  return {
    provider: "local",
    user: {
      id: userId,
      name: `Memory User ${userId.slice(-3)}`,
      email: `${userId.slice(-3)}@example.test`,
    },
    tenant: { id: "memory-routes-lab", name: "Memory Routes Lab" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function mutation(pathname: string, body: unknown) {
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

describe("explicit memory routes", () => {
  let root: string;
  let previousConfig: string | undefined;

  beforeAll(async () => {
    previousConfig = process.env.AIBRAIN_INSTALLATION_CONFIG;
    root = await mkdtemp(path.join(tmpdir(), "aibrain-memory-routes-"));
    const dataRoot = path.join(root, "data");
    const configPath = path.join(root, "installation.json");
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    await writeFile(configPath, `${JSON.stringify({
      schemaVersion: 1,
      installationId: "memory-routes-lab",
      companyName: "Memory Routes Lab",
      companySlug: "memory-routes-lab",
      publicUrl: "http://localhost:3000",
      branding: {
        productName: "Memory Brain",
        logoPath: "/brand/logo.svg",
        faviconPath: "/brand/favicon.svg",
        accentColor: "#334455",
      },
      paths: {
        dataRoot,
        companyContextRoot: path.join(dataRoot, "company"),
        usersRoot: path.join(dataRoot, "users"),
        sourceReadRoot: path.join(root, "source-ro"),
        publishWriteRoot: path.join(root, "publish-rw"),
        backupsRoot: path.join(dataRoot, "backups"),
      },
    }, null, 2)}\n`, "utf8");
    process.env.AIBRAIN_INSTALLATION_CONFIG = configPath;

    const [{ loadInstallationConfig }, { UserProvisioner }] = await Promise.all([
      import("@/config/installation"),
      import("@/users/provisioner"),
    ]);
    const installation = await loadInstallationConfig();
    const provisioner = new UserProvisioner(installation);
    await provisioner.provision({ userId: USER_A, email: "a@example.test", displayName: "User A" });
    await provisioner.provision({ userId: USER_B, email: "b@example.test", displayName: "User B" });
  });

  afterAll(async () => {
    auth.session = null;
    if (previousConfig === undefined) delete process.env.AIBRAIN_INSTALLATION_CONFIG;
    else process.env.AIBRAIN_INSTALLATION_CONFIG = previousConfig;
    await rm(root, { recursive: true, force: true });
  });

  it("requires authentication and rejects implicit or over-posted memories", async () => {
    const route = await import("@/app/api/memory/route");
    auth.session = null;
    expect((await route.GET(new Request("http://localhost/api/memory"))).status).toBe(401);

    auth.session = session(USER_A);
    expect((await route.POST(mutation("/api/memory", {
      explicit: false,
      kind: "decision",
      content: "Never store this implicitly.",
      sourceExcerpt: "Implicit request",
      clientRequestId: CREATE_REQUEST,
    }))).status).toBe(400);
    expect((await route.POST(mutation("/api/memory", {
      explicit: true,
      kind: "decision",
      content: "Never trust actor-controlled identity.",
      sourceExcerpt: "Manual decision",
      clientRequestId: CREATE_REQUEST,
      userId: USER_B,
    }))).status).toBe(400);
  });

  it("creates, replays, lists and revokes only the authenticated user's memory", async () => {
    const route = await import("@/app/api/memory/route");
    const body = {
      explicit: true as const,
      kind: "decision" as const,
      content: "Publish only after explicit confirmation.",
      sourceExcerpt: "User explicitly asked AiBrain to remember this rule.",
      clientRequestId: CREATE_REQUEST,
    };

    auth.session = session(USER_A);
    const created = await route.POST(mutation("/api/memory", body));
    expect(created.status).toBe(201);
    const createdPayload = await created.json() as {
      created: boolean;
      memory: { memoryId: string; status: string; content: string };
    };
    expect(createdPayload).toMatchObject({
      created: true,
      memory: { status: "active", content: body.content },
    });

    const replayed = await route.POST(mutation("/api/memory", body));
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ created: false });

    const listed = await route.GET(new Request("http://localhost/api/memory?status=active&kind=decision"));
    expect(listed.status).toBe(200);
    expect(listed.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await listed.json()).toMatchObject({
      memories: [{ memoryId: createdPayload.memory.memoryId, content: body.content }],
    });

    auth.session = session(USER_B);
    const foreignList = await route.GET(new Request("http://localhost/api/memory?status=all"));
    expect(await foreignList.json()).toEqual({ memories: [] });

    const revoke = await import("@/app/api/memory/[memoryId]/revoke/route");
    expect((await revoke.POST(mutation("/api/memory/revoke", {
      explicit: true,
      reason: "No longer applies.",
      clientRequestId: REVOKE_REQUEST,
    }), { params: Promise.resolve({ memoryId: createdPayload.memory.memoryId }) })).status).toBe(404);

    auth.session = session(USER_A);
    const revoked = await revoke.POST(mutation("/api/memory/revoke", {
      explicit: true,
      reason: "No longer applies.",
      clientRequestId: REVOKE_REQUEST,
    }), { params: Promise.resolve({ memoryId: createdPayload.memory.memoryId }) });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ memory: { status: "revoked" } });
    expect((await route.GET(new Request("http://localhost/api/memory?status=active"))).status).toBe(200);
    expect(await (await route.GET(new Request("http://localhost/api/memory?status=active"))).json())
      .toEqual({ memories: [] });
  });
});
