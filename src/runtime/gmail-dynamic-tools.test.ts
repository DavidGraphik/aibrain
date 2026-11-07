import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallationConfig } from "@/config/installation-schema";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  search: vi.fn(),
  read: vi.fn(),
}));

vi.mock("@/connectors/gmail-server-service", () => ({ withGmailReadAccess: mocks.access }));
vi.mock("@/connectors/gmail-api", () => ({ searchGmail: mocks.search, readGmailMessage: mocks.read }));

import { handleGmailDynamicToolCall } from "@/runtime/gmail-dynamic-tools";

const config = { installationId: "company-qa" } as InstallationConfig;
const params = {
  threadId: "runtime-thread",
  turnId: "runtime-turn",
  callId: "call-1",
  namespace: "aibrain_gmail",
  tool: "search",
  arguments: { query: "from:person@example.com", maxResults: 5 },
} as const;
const context = {
  config,
  installationId: "company-qa",
  userId: "11111111-1111-4111-8111-111111111111",
  runtimeThreadId: "runtime-thread",
  runtimeTurnId: "runtime-turn",
  gmailSelected: true,
};

describe("Gmail dynamic tool authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockImplementation(async (_config, _user, read) => read("access-token-value"));
    mocks.search.mockResolvedValue({ messages: [], resultSizeEstimate: 0 });
  });

  it("reports an unavailable user connection without touching credentials, and preserves turn checks", async () => {
    await expect(handleGmailDynamicToolCall(params, { ...context, gmailSelected: false })).resolves.toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "Gmail connection is not available or verified for this user." }],
    });
    await expect(handleGmailDynamicToolCall(params, { ...context, runtimeTurnId: "another-turn" })).resolves.toMatchObject({ success: false });
    expect(mocks.access).not.toHaveBeenCalled();
  });

  it("returns the exact personal reconnect route when silent renewal cannot recover", async () => {
    mocks.access.mockRejectedValueOnce(Object.assign(new Error("expired"), { code: "GMAIL_REAUTH_REQUIRED" }));
    const response = await handleGmailDynamicToolCall(params, context);
    expect(response).toMatchObject({ success: false });
    expect(JSON.stringify(response)).toContain("/api/connectors/gmail/oauth/start");
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("resolves only the authenticated employee token after identity checks", async () => {
    await expect(handleGmailDynamicToolCall(params, context)).resolves.toMatchObject({ success: true });
    expect(mocks.access).toHaveBeenCalledWith(config, context.userId, expect.any(Function), undefined);
    expect(mocks.search).toHaveBeenCalledWith(fetch, "access-token-value", "from:person@example.com", 5);
  });
});
