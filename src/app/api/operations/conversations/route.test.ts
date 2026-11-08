import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/operations/conversations", () => ({ operatorConversations: mocks.read }));
import { GET } from "./route";
const secret = "conversation-dashboard-secret-with-32-bytes";
const url = "https://arnall.test/api/operations/conversations?userId=target&threadId=thread";
beforeEach(() => { vi.unstubAllEnvs(); vi.stubEnv("AIBRAIN_USAGE_DASHBOARD_SECRET", secret); mocks.read.mockReset().mockResolvedValue({ thread: { messages: [] } }); });
describe("operator conversation route", () => {
  it("denies missing, wrong and unconfigured bearer before content reads", async () => {
    expect((await GET(new Request(url))).status).toBe(401);
    expect((await GET(new Request(url, { headers: { Authorization: "Bearer wrong" } }))).status).toBe(401);
    vi.stubEnv("AIBRAIN_USAGE_DASHBOARD_SECRET", "");
    expect((await GET(new Request(url, { headers: { Authorization: `Bearer ${secret}` } }))).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("forwards the authenticated transport actor and returns non-cacheable content", async () => {
    const response = await GET(new Request(url, { headers: { Authorization: `Bearer ${secret}`, "X-AiBrain-Operator-Id": "actor" } }));
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.read).toHaveBeenCalledWith("actor", "target", "thread", undefined, undefined);
  });
});
