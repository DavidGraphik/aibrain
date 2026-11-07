import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";

const USER_A = "0198b9f0-6631-7000-8000-000000000301";
const USER_B = "0198b9f0-6631-7000-8000-000000000302";
const auth = vi.hoisted(() => ({ session: null as AuthSession | null }));

vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({ getSession: vi.fn(async () => auth.session) }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: vi.fn(async () => true) }));

function session(userId: string): AuthSession {
  return {
    provider: "local",
    user: {
      id: userId,
      name: `User ${userId.slice(-3)}`,
      email: `${userId.slice(-3)}@example.test`,
    },
    tenant: { id: "route-lab", name: "Route Lab" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function request(url: string, method = "GET", body?: unknown) {
  return new Request(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("filesystem workbench lifecycle routes", () => {
  let root: string;
  let previousConfig: string | undefined;

  beforeAll(async () => {
    previousConfig = process.env.AIBRAIN_INSTALLATION_CONFIG;
    root = await mkdtemp(path.join(tmpdir(), "aibrain-workbench-routes-"));
    const dataRoot = path.join(root, "data");
    const usersRoot = path.join(dataRoot, "users");
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const configPath = path.join(root, "installation.json");
    await writeFile(configPath, `${JSON.stringify({
      schemaVersion: 1,
      installationId: "route-lab",
      companyName: "Route Lab",
      companySlug: "route-lab",
      publicUrl: "http://localhost:3000",
      branding: {
        productName: "Route Brain",
        logoPath: "/brand/logo.svg",
        faviconPath: "/brand/favicon.svg",
        accentColor: "#334455",
      },
      paths: {
        dataRoot,
        companyContextRoot: path.join(dataRoot, "company"),
        usersRoot,
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
    const provisioner = new UserProvisioner(await loadInstallationConfig());
    await provisioner.provision({
      userId: USER_A,
      email: `${USER_A.slice(-3)}@example.test`,
      displayName: "User 301",
    });
    await provisioner.provision({
      userId: USER_B,
      email: `${USER_B.slice(-3)}@example.test`,
      displayName: "User 302",
    });
  });

  afterAll(async () => {
    auth.session = null;
    if (previousConfig === undefined) delete process.env.AIBRAIN_INSTALLATION_CONFIG;
    else process.env.AIBRAIN_INSTALLATION_CONFIG = previousConfig;
    await rm(root, { recursive: true, force: true });
  });

  it("authenticates, paginates, searches, reads and mutates only the local user's resources", async () => {
    const projectsRoute = await import("@/app/api/projects/route");
    const projectRoute = await import("@/app/api/projects/[projectId]/route");
    const projectThreadsRoute = await import("@/app/api/projects/[projectId]/threads/route");
    const threadsRoute = await import("@/app/api/threads/route");
    const threadRoute = await import("@/app/api/threads/[threadId]/route");
    const workbenchRoute = await import("@/app/api/workbench/route");

    auth.session = null;
    expect((await projectsRoute.GET(request("http://localhost/api/projects"))).status).toBe(401);

    auth.session = session(USER_A);
    const createdProjectResponse = await projectsRoute.POST(request(
      "http://localhost/api/projects",
      "POST",
      { name: "Private Operations" },
    ));
    expect(createdProjectResponse.status).toBe(201);
    const createdProject = (await createdProjectResponse.json()).project as { id: string };

    const createdThreadResponse = await projectThreadsRoute.POST(
      request(
        `http://localhost/api/projects/${createdProject.id}/threads`,
        "POST",
        { title: "Confidential planning" },
      ),
      { params: Promise.resolve({ projectId: createdProject.id }) },
    );
    expect(createdThreadResponse.status).toBe(201);
    const createdThread = (await createdThreadResponse.json()).thread as { id: string };

    const projectPage = await projectsRoute.GET(request(
      "http://localhost/api/projects?status=active&limit=1&q=operations",
    ));
    expect(projectPage.status).toBe(200);
    expect(await projectPage.json()).toMatchObject({
      projects: [{ id: createdProject.id }],
      nextCursor: null,
    });
    expect(projectPage.headers.get("Cache-Control")).toBe("private, no-store");

    const readProject = await projectRoute.GET(
      request(`http://localhost/api/projects/${createdProject.id}`),
      { params: Promise.resolve({ projectId: createdProject.id }) },
    );
    expect(await readProject.json()).toMatchObject({ project: { id: createdProject.id } });

    const nestedThreads = await projectThreadsRoute.GET(
      request(`http://localhost/api/projects/${createdProject.id}/threads?q=planning`),
      { params: Promise.resolve({ projectId: createdProject.id }) },
    );
    expect(await nestedThreads.json()).toMatchObject({
      threads: [{ id: createdThread.id, messageCount: 0, lastMessageAt: null }],
      nextCursor: null,
    });
    const allThreads = await threadsRoute.GET(request("http://localhost/api/threads?status=all"));
    expect(await allThreads.json()).toMatchObject({ threads: [{ id: createdThread.id }] });

    const readThread = await threadRoute.GET(
      request(`http://localhost/api/threads/${createdThread.id}`),
      { params: Promise.resolve({ threadId: createdThread.id }) },
    );
    expect(await readThread.json()).toMatchObject({
      thread: { id: createdThread.id, messages: [] },
    });

    const renamedProject = await projectRoute.PATCH(
      request(`http://localhost/api/projects/${createdProject.id}`, "PATCH", {
        name: "Renamed Operations",
        pinned: true,
        status: "archived",
      }),
      { params: Promise.resolve({ projectId: createdProject.id }) },
    );
    expect(await renamedProject.json()).toMatchObject({
      project: { name: "Renamed Operations", pinned: true, status: "archived" },
    });
    await projectRoute.PATCH(
      request(`http://localhost/api/projects/${createdProject.id}`, "PATCH", { status: "active" }),
      { params: Promise.resolve({ projectId: createdProject.id }) },
    );
    const updatedThread = await threadRoute.PATCH(
      request(`http://localhost/api/threads/${createdThread.id}`, "PATCH", {
        title: "Renamed planning",
        pinned: true,
        status: "archived",
      }),
      { params: Promise.resolve({ threadId: createdThread.id }) },
    );
    expect(await updatedThread.json()).toMatchObject({
      thread: { title: "Renamed planning", pinned: true, status: "archived" },
    });
    expect((await threadRoute.PATCH(
      request(`http://localhost/api/threads/${createdThread.id}`, "PATCH", { status: "active" }),
      { params: Promise.resolve({ threadId: createdThread.id }) },
    )).status).toBe(200);
    expect(await (await workbenchRoute.GET()).json()).toMatchObject({
      workbench: { threads: [{ id: createdThread.id, pinned: true }] },
    });

    auth.session = session(USER_B);
    expect((await projectRoute.GET(
      request(`http://localhost/api/projects/${createdProject.id}`),
      { params: Promise.resolve({ projectId: createdProject.id }) },
    )).status).toBe(404);
    expect((await threadRoute.GET(
      request(`http://localhost/api/threads/${createdThread.id}`),
      { params: Promise.resolve({ threadId: createdThread.id }) },
    )).status).toBe(404);
    expect((await threadRoute.PATCH(
      request(`http://localhost/api/threads/${createdThread.id}`, "PATCH", { pinned: true }),
      { params: Promise.resolve({ threadId: createdThread.id }) },
    )).status).toBe(404);

    auth.session = { ...session(USER_A), provider: "unsupported" } as unknown as AuthSession;
    expect((await projectsRoute.GET(request("http://localhost/api/projects"))).status).toBe(503);
  });

  it("rejects malformed, duplicated and unknown list parameters before touching storage", async () => {
    auth.session = session(USER_A);
    const projectsRoute = await import("@/app/api/projects/route");
    for (const query of ["limit=51", "limit=01", "q=", "q=a&q=b", "unknown=1"]) {
      const response = await projectsRoute.GET(request(`http://localhost/api/projects?${query}`));
      expect(response.status, query).toBe(400);
    }
  });
});
