import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallationConfig } from "@/config/installation-schema";

const mocks = vi.hoisted(() => ({ access: vi.fn(), search: vi.fn(), read: vi.fn() }));
vi.mock("@/connectors/outlook-server-service", () => ({ withOutlookReadAccess: mocks.access }));
vi.mock("@/connectors/outlook-api", () => ({ searchOutlookMessages: mocks.search, readOutlookMessage: mocks.read }));
import { handleOutlookDynamicToolCall } from "@/runtime/outlook-dynamic-tools";

const config = { installationId: "company-qa" } as InstallationConfig;
const params = { threadId: "runtime-thread", turnId: "runtime-turn", callId: "call-1", namespace: "aibrain_outlook", tool: "search", arguments: { query: "quarterly review", maxResults: 5 } } as const;
const context = { config, installationId: "company-qa", userId: "11111111-1111-4111-8111-111111111111", runtimeThreadId: "runtime-thread", runtimeTurnId: "runtime-turn", outlookSelected: true };

describe("Outlook dynamic tool authorization", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.access.mockImplementation(async (_config, _user, read) => read("access-token-value")); mocks.search.mockResolvedValue({ messages: [] }); });

  it("reports an unavailable user connection without touching credentials, and preserves turn checks", async () => {
    await expect(handleOutlookDynamicToolCall(params, { ...context, outlookSelected: false })).resolves.toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "Outlook connection is not available or verified for this user." }],
    });
    await expect(handleOutlookDynamicToolCall(params, { ...context, runtimeTurnId: "another-turn" })).resolves.toMatchObject({ success: false });
    expect(mocks.access).not.toHaveBeenCalled();
  });

  it("returns the exact personal reconnect route when silent renewal cannot recover", async () => {
    mocks.access.mockRejectedValueOnce(Object.assign(new Error("expired"), { code: "OUTLOOK_REAUTH_REQUIRED" }));
    const response = await handleOutlookDynamicToolCall(params, context);
    expect(response).toMatchObject({ success: false });
    expect(JSON.stringify(response)).toContain("/api/connectors/outlook/oauth/start");
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("resolves only the authenticated employee token after identity checks", async () => {
    await expect(handleOutlookDynamicToolCall(params, context)).resolves.toMatchObject({ success: true });
    expect(mocks.access).toHaveBeenCalledWith(config, context.userId, expect.any(Function), undefined);
    expect(mocks.search).toHaveBeenCalledWith(fetch, "access-token-value", "quarterly review", 5);
  });
});
