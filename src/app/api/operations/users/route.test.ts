import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  sameOrigin: true,
  execute: vi.fn(),
}));

vi.mock("@/auth/request-security", () => ({
  isSameOriginMutation: async () => mocked.sameOrigin,
}));
vi.mock("@/users/lifecycle-server", () => ({
  executeUserLifecycleCommand: mocked.execute,
}));

import { POST } from "@/app/api/operations/users/route";

const SECRET = "operator-user-lifecycle-secret-32-bytes-minimum";
const originalOperatorSecret = process.env.AIBRAIN_OPERATOR_SECRET;
const originalMaintenanceSecret = process.env.AIBRAIN_MAINTENANCE_SECRET;
const command = {
  schemaVersion: 1,
  requestId: "10000000-0000-4000-8000-000000000001",
  action: "disable",
  userId: "00000000-0000-4000-8000-000000000001",
};

function request(body: unknown, secret = SECRET) {
  return new Request("https://brain.example/api/operations/users", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      Origin: "https://brain.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("user lifecycle operator route", () => {
  beforeEach(() => {
    process.env.AIBRAIN_OPERATOR_SECRET = SECRET;
    delete process.env.AIBRAIN_MAINTENANCE_SECRET;
    mocked.sameOrigin = true;
    mocked.execute.mockReset();
    mocked.execute.mockResolvedValue({ ...command, installationId: "example-qa", replayed: false });
  });

  afterAll(() => {
    if (originalOperatorSecret === undefined) delete process.env.AIBRAIN_OPERATOR_SECRET;
    else process.env.AIBRAIN_OPERATOR_SECRET = originalOperatorSecret;
    if (originalMaintenanceSecret === undefined) delete process.env.AIBRAIN_MAINTENANCE_SECRET;
    else process.env.AIBRAIN_MAINTENANCE_SECRET = originalMaintenanceSecret;
  });

  it("requires the independent operator bearer and same Origin", async () => {
    expect((await POST(request(command, "wrong-secret"))).status).toBe(401);
    mocked.sameOrigin = false;
    expect((await POST(request(command))).status).toBe(403);
    expect(mocked.execute).not.toHaveBeenCalled();
  });

  it("rejects malformed commands before execution", async () => {
    const response = await POST(request({ ...command, unexpected: true }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "USER_LIFECYCLE_COMMAND_INVALID" });
    expect(mocked.execute).not.toHaveBeenCalled();
  });

  it("returns a no-store typed receipt", async () => {
    const response = await POST(request(command));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocked.execute).toHaveBeenCalledWith(command);
  });
});
