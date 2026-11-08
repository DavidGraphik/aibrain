import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const contextMocks = vi.hoisted(() => ({ getProject: vi.fn(), getThread: vi.fn() }));
vi.mock("@/workbench/store", () => contextMocks);

const USER_ID = "00000000-0000-4000-8000-000000000001";
let root = "";

vi.mock("server-only", () => ({}));
vi.mock("@/config/installation", () => ({
  loadInstallationConfig: async () => ({
    installationId: "company-qa",
    paths: { usersRoot: root },
  }),
}));
vi.mock("@/operations/server-logger", () => ({ operationalLogger: { warn: vi.fn() } }));

import { createSupportRequest } from "@/support/server-service";

afterEach(() => vi.unstubAllEnvs());

describe("createSupportRequest", () => {
  it("returns the persisted request when optional notification fails", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "aibrain-support-service-"));
    await mkdir(path.join(root, USER_ID), { mode: 0o700 });
    vi.stubEnv("AIBRAIN_SUPPORT_WEBHOOK_URL", "https://support.example.test/hook");
    const result = await createSupportRequest({
      provider: "local",
      user: { id: USER_ID, name: "David", email: "david@example.com" },
      tenant: { id: "company-qa", name: "Arnall" },
      expiresAt: "2026-09-06T00:00:00.000Z",
    }, { kind: "bug", description: "No carga", context: { pathname: "/", projectId: null, threadId: null, viewport: "desktop" } }, vi.fn(async () => new Response("failed", { status: 503 })) as typeof fetch);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    const stored = JSON.parse(await readFile(path.join(root, USER_ID, "support", "requests.json"), "utf8")) as { requests: Array<{ notification: string }> };
    expect(stored.requests[0].notification).toBe("failed");
  });
});

it("does not accept a foreign project/chat reference as support authorization", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aibrain-support-context-"));
  contextMocks.getProject.mockRejectedValueOnce(new Error("foreign"));
  const session = { provider: "local" as const, user: { id: USER_ID, name: "Test", email: "test@example.invalid" }, tenant: { id: "company-qa", name: "Test" }, expiresAt: "2099-01-01T00:00:00Z" };
  await expect(createSupportRequest(session, { kind: "bug", description: "Report", context: { pathname: "/", projectId: USER_ID, threadId: null, viewport: "desktop" } })).rejects.toMatchObject({ code: "SUPPORT_INPUT_INVALID" });
  await expect(readFile(path.join(root, USER_ID, "support", "requests.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
