import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallationConfig } from "@/config/installation-schema";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/connectors/instantly-service", () => ({ instantlyReadForIdentity: mocks.read }));
import { handleInstantlyTool } from "@/runtime/instantly-dynamic-tools";
const config = { installationId: "company-a" } as InstallationConfig;
const params = { threadId: "t1", turnId: "r1", callId: "c1", namespace: "aibrain_instantly", tool: "read", arguments: { operation: "accounts", arguments: {} } };
const context = { config, installationId: "company-a", userId: "11111111-1111-4111-8111-111111111111", runtimeThreadId: "t1", runtimeTurnId: "r1", instantlySelected: true };
describe("Instantly turn identity", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.read.mockResolvedValue({ items: [] }); });
  it("never touches credentials for another tenant, turn or absent selection", async () => {
    for (const override of [{ installationId: "foreign" }, { runtimeTurnId: "foreign" }, { runtimeThreadId: "foreign" }, { instantlySelected: false }]) expect(await handleInstantlyTool(params, { ...context, ...override })).toMatchObject({ success: false });
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("uses the current employee only, validates tools and hides raw failures", async () => {
    expect(await handleInstantlyTool(params, context)).toMatchObject({ success: true });
    expect(mocks.read).toHaveBeenCalledWith(config, context.userId, "accounts", {}, undefined);
    mocks.read.mockRejectedValue(new Error("secret-token"));
    expect(JSON.stringify(await handleInstantlyTool(params, context))).not.toContain("secret-token");
    expect(await handleInstantlyTool({ ...params, tool: "send" }, context)).toMatchObject({ success: false });
  });
});
