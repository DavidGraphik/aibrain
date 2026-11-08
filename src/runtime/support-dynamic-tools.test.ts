import { beforeEach, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import { handleSupportTool, type SupportToolContext } from "./support-dynamic-tools";
import type { DynamicToolCallParams } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallParams";
const mocks = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), reply: vi.fn(), config: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: mocks.config }));
vi.mock("@/support/server-service", () => ({ createSupportRequest: mocks.create }));
vi.mock("@/support/store", () => ({ FileSupportRequestStore: class { list = mocks.list; reply = mocks.reply; } }));
const id = "0a8f467e-79f0-4bdf-85a8-54e4fafb7940";
const session: AuthSession = { provider: "local", user: { id, name: "Test", email: "test@example.invalid" }, tenant: { id: "modtime", name: "Test" }, expiresAt: "2099-01-01T00:00:00Z" };
const context: SupportToolContext = { session, installationId: "modtime", userId: id, runtimeThreadId: "runtime", runtimeTurnId: "turn", projectId: id, threadId: id, humanMessage: "La importación falla. Repórtalo.", screenshots: [], backgroundExecution: false };
const call = (tool: string, args: unknown, ctx = context) => handleSupportTool({ namespace: "aibrain_support", tool, arguments: args, threadId: "runtime", turnId: "turn", callId: "call" } as DynamicToolCallParams, ctx);
beforeEach(() => { vi.clearAllMocks(); mocks.config.mockResolvedValue({ installationId: "modtime", paths: { usersRoot: "/tmp/synthetic" } }); mocks.create.mockImplementation(async (_s, input) => ({ id, ...input, status: "queued" })); mocks.list.mockResolvedValue([]); });
it("rejects cross-tenant, expired, background and foreign-turn calls before touching storage", async () => {
  for (const ctx of [{ ...context, userId: "foreign" }, { ...context, runtimeTurnId: "other" }, { ...context, runtimeThreadId: "other" }, { ...context, installationId: "company-qa" }, { ...context, session: undefined }, { ...context, backgroundExecution: true }, { ...context, session: { ...session, expiresAt: "2000-01-01T00:00:00Z" } }]) expect((await call("create", { kind: "bug", description: "Falla" }, ctx)).success).toBe(false);
  expect(mocks.config).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
});
it("creates a durable receipt without a resolution claim and reuses identity after tool retries", async () => {
  const first = await call("create", { kind: "bug", description: "Falla" });
  await call("create", { kind: "bug", description: "Falla" });
  expect(first.success).toBe(true);
  expect(mocks.create.mock.calls[0][1].clientRequestId).toBe(mocks.create.mock.calls[1][1].clientRequestId);
  expect(mocks.create.mock.calls[0][1].context.threadId).toBe(id);
  expect(JSON.stringify(first)).toContain('received'); expect(JSON.stringify(first)).not.toContain('"resolved"');
});
it("rejects privileged properties, unknown screenshots and model-supplied user identity", async () => {
  for (const args of [{ kind: "bug", description: "Falla", status: "resolved" }, { kind: "bug", description: "Falla", userId: id }, { kind: "bug", description: "Falla", screenshotIndices: [0] }]) expect((await call("create", args)).success).toBe(false);
  expect(mocks.create).not.toHaveBeenCalled();
});
it("threads a follow-up into the same case and never exposes a worker action", async () => {
  mocks.reply.mockResolvedValue({ id, status: "queued" });
  expect((await call("reply", { id, body: "Sigue fallando" })).success).toBe(true);
  expect(mocks.reply.mock.calls[0][0]).toBe(id); expect(mocks.create).not.toHaveBeenCalled();
  expect((await call("resolve", { id })).success).toBe(false);
});
it("does not expose unknown or another employee's ticket", async () => {
  expect((await call("read", { id })).success).toBe(false);
  mocks.config.mockResolvedValue({ installationId: "foreign", paths: {} });
  expect((await call("list", {})).success).toBe(false);
});
it("includes only bound current-turn document screenshots and does not read unselected images", async () => {
  const load = vi.fn().mockResolvedValue(Buffer.from("synthetic-image"));
  const ctx = { ...context, documentImages: [{ id, name: "capture.png", mimeType: "image/png", size: 15, load }] };
  expect((await call("create", { kind: "bug", description: "Falla", screenshotIndices: [] }, ctx)).success).toBe(true);
  expect(load).not.toHaveBeenCalled();
  expect((await call("create", { kind: "bug", description: "Falla" }, ctx)).success).toBe(true);
  expect(load).toHaveBeenCalledOnce(); expect(mocks.create.mock.calls[1][1].screenshots[0].name).toBe("capture.png");
});
