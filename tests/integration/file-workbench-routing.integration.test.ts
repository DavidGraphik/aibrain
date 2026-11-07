import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import { STANDALONE_PROJECT_SLUG } from "@/workbench/types";

const USER_ID = "0198b9f0-6631-7000-8000-000000000201";
const roots: string[] = [];
const previousConfig = process.env.AIBRAIN_INSTALLATION_CONFIG;

const forbidden = vi.hoisted(() => vi.fn(() => {
  throw new Error("non-filesystem workbench adapter was called");
}));

vi.mock("server-only", () => ({}));
vi.mock("@/workbench/demo-store", () => ({
  assertWorkbenchId: forbidden,
  beginDemoThreadTurn: forbidden,
  createDemoProject: forbidden,
  createDemoThread: forbidden,
  finishDemoThreadTurn: forbidden,
  getDemoProjectRuntimeContext: forbidden,
  getDemoThreadRuntimeContext: forbidden,
  loadDemoWorkbench: forbidden,
  updateDemoProject: forbidden,
  updateDemoThread: forbidden,
  updateDemoMessageActivity: forbidden,
}));
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-workbench-routing-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  const usersRoot = path.join(dataRoot, "users");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const configPath = path.join(root, "installation.json");
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 1,
    installationId: "synthetic-lab",
    companyName: "Synthetic Lab",
    companySlug: "synthetic-lab",
    publicUrl: "http://localhost:3000",
    branding: {
      productName: "Synthetic Brain",
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
  await new UserProvisioner(await loadInstallationConfig()).provision({
    userId: USER_ID,
    email: "synthetic@example.test",
    displayName: "Synthetic User",
  });
  const session: AuthSession = {
    provider: "local",
    user: {
      id: USER_ID,
      name: "Synthetic User",
      email: "synthetic@example.test",
    },
    tenant: { id: "synthetic-lab", name: "Synthetic Lab" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return { session };
}

afterEach(async () => {
  forbidden.mockClear();
  if (previousConfig === undefined) delete process.env.AIBRAIN_INSTALLATION_CONFIG;
  else process.env.AIBRAIN_INSTALLATION_CONFIG = previousConfig;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local workbench routing", () => {
  it("routes a local authenticated session only to the per-user filesystem store", async () => {
    const { session } = await fixture();
    const { createProject, createThread, getThreadRuntimeContext, loadWorkbench } = await import("@/workbench/store");
    const initial = await loadWorkbench(session);
    expect(initial).toMatchObject({ persistence: "filesystem", threads: [] });
    expect(initial.projects).toEqual([
      expect.objectContaining({ slug: STANDALONE_PROJECT_SLUG }),
    ]);
    const project = await createProject(session, "Local only");
    expect(project.name).toBe("Local only");
    expect((await loadWorkbench(session)).projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: STANDALONE_PROJECT_SLUG }),
      expect.objectContaining({ id: project.id }),
    ]));
    const thread = await createThread(session, project.id, "Hi");
    await expect(getThreadRuntimeContext(session, thread.id)).resolves.toMatchObject({
      projectId: project.id,
      projectName: "Local only",
      visibleProjects: [{ id: project.id, name: "Local only" }],
    });
    expect(forbidden).not.toHaveBeenCalled();
  });
});
