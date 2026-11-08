import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
// This suite verifies source ownership; storage-pressure policy has its own negative tests.
vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  statfs: async () => ({ bsize: 4096n, bavail: 10_000_000n, blocks: 20_000_000n }),
}));
const mocks = vi.hoisted(() => ({ session: vi.fn(), origin: vi.fn(), access: vi.fn(), store: vi.fn(), config: vi.fn() }));
vi.mock("@/auth/session", () => ({ getSession: mocks.session }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: mocks.origin }));
vi.mock("@/workbench/shared-access", () => ({ resolveProjectAccess: mocks.access }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: mocks.config }));
vi.mock("@/documents/project-sources", () => ({ projectSourceStore: mocks.store }));
import { POST } from "./route";
const context = { params: Promise.resolve({ projectId: "00000000-0000-4000-8000-000000000001" }) };
beforeEach(() => { vi.clearAllMocks(); mocks.origin.mockResolvedValue(true); mocks.session.mockResolvedValue({ user: { id: "user" } }); });
it("rejects anonymous and cross-origin uploads before reading bytes", async () => {
  mocks.origin.mockResolvedValue(false);
  expect((await POST(new Request("https://app.test"), context)).status).toBe(403);
  mocks.origin.mockResolvedValue(true); mocks.session.mockResolvedValue(null);
  expect((await POST(new Request("https://app.test"), context)).status).toBe(401);
  expect(mocks.access).not.toHaveBeenCalled(); expect(mocks.store).not.toHaveBeenCalled();
});
it("rejects a shared viewer before storing originals", async () => {
  mocks.access.mockResolvedValue({ role: "viewer" });
  expect((await POST(new Request("https://app.test"), context)).status).toBe(403);
  expect(mocks.store).not.toHaveBeenCalled();
});

it("stores original content beyond the former excerpt limit under the authorized project owner", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "source-route-"));
  try {
    const owner = "00000000-0000-4000-8000-000000000002";
    const sourceId = "00000000-0000-4000-8000-000000000003";
    const config = { paths: { dataRoot: root } };
    const actual = await vi.importActual<typeof import("@/documents/project-sources")>("@/documents/project-sources");
    const store = actual.projectSourceStore(config as never, owner);
    mocks.config.mockResolvedValue(config); mocks.access.mockResolvedValue({ role: "editor", ownerUserId: owner }); mocks.store.mockReturnValue(store);
    const bytes = "reference rows\n".repeat(5000) + "LAST_PRICE=79.42";
    const form = new FormData(); form.append("uploadId", sourceId); form.append("file", new File([bytes], "prices.txt", { type: "text/plain" }));
    const response = await POST(new Request("https://app.test", { method: "POST", body: form }), context);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ source: { id: sourceId, status: "ready", excerpt: null, size: bytes.length } });
    expect(mocks.store).toHaveBeenCalledWith(config, owner);
    const document = await store.staging.readById((await context.params).projectId, sourceId);
    expect(await readFile(path.join(store.staging.rootDirectory, document.relativePath), "utf8")).toBe(bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
