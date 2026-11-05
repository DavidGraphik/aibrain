import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MaintenanceDrainTimeoutError, type MaintenanceStatus } from "@/operations/maintenance";

const mocked = vi.hoisted(() => ({
  sameOrigin: true,
  status: null as MaintenanceStatus | null,
  enterTimeoutMs: null as number | null,
  enterError: null as Error | null,
}));

vi.mock("@/auth/request-security", () => ({
  isSameOriginMutation: async () => mocked.sameOrigin,
}));
vi.mock("@/runtime/worker-runtime-service", () => ({
  workerMaintenanceStatus: async () => mocked.status,
  enterWorkerMaintenance: async ({ timeoutMs }: { timeoutMs: number }) => {
    mocked.enterTimeoutMs = timeoutMs;
    if (mocked.enterError) throw mocked.enterError;
    return mocked.status;
  },
  resumeWorkerMaintenance: async () => mocked.status,
}));

import { GET, POST } from "@/app/api/operations/maintenance/route";

const SECRET = "maintenance-test-secret-with-32-bytes-minimum";
const originalSecret = process.env.AIBRAIN_MAINTENANCE_SECRET;
const originalOperatorSecret = process.env.AIBRAIN_OPERATOR_SECRET;

function status(phase: MaintenanceStatus["phase"], activeActivities = 0): MaintenanceStatus {
  return {
    schemaVersion: 1,
    phase,
    generation: 2,
    transitionedAt: "2026-08-27T12:00:00.000Z",
    activeActivities,
    activeByKind: { turn: activeActivities, "worker-start": 0 },
  };
}

function request(method: "GET" | "POST", body?: unknown, secret = SECRET) {
  return new Request("https://brain.example/api/operations/maintenance", {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      Origin: "https://brain.example",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("maintenance operator route", () => {
  beforeEach(() => {
    delete process.env.AIBRAIN_OPERATOR_SECRET;
    process.env.AIBRAIN_MAINTENANCE_SECRET = SECRET;
    mocked.sameOrigin = true;
    mocked.status = status("accepting");
    mocked.enterTimeoutMs = null;
    mocked.enterError = null;
  });

  afterAll(() => {
    if (originalOperatorSecret === undefined) delete process.env.AIBRAIN_OPERATOR_SECRET;
    else process.env.AIBRAIN_OPERATOR_SECRET = originalOperatorSecret;
    if (originalSecret === undefined) delete process.env.AIBRAIN_MAINTENANCE_SECRET;
    else process.env.AIBRAIN_MAINTENANCE_SECRET = originalSecret;
  });

  it("fails closed without the independent operator bearer secret", async () => {
    expect((await GET(request("GET", undefined, "wrong-secret"))).status).toBe(401);
    delete process.env.AIBRAIN_MAINTENANCE_SECRET;
    expect((await GET(request("GET"))).status).toBe(401);
  });

  it("returns private typed status to an authenticated operator", async () => {
    const response = await GET(request("GET"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(status("accepting"));
  });

  it("enforces Origin and a bounded drain timeout", async () => {
    mocked.sameOrigin = false;
    expect((await POST(request("POST", { action: "drain", timeoutMs: 500 }))).status).toBe(403);
    mocked.sameOrigin = true;
    expect((await POST(request("POST", { action: "drain", timeoutMs: 0 }))).status).toBe(400);
    expect((await POST(request("POST", { action: "drain", timeoutMs: 600_001 }))).status).toBe(400);

    mocked.status = status("maintenance");
    const response = await POST(request("POST", { action: "drain", timeoutMs: 500 }));
    expect(response.status).toBe(200);
    expect(mocked.enterTimeoutMs).toBe(500);
  });

  it("reports a timed-out drain without reopening admission", async () => {
    const draining = status("draining", 1);
    mocked.enterError = new MaintenanceDrainTimeoutError(draining);
    const response = await POST(request("POST", { action: "drain", timeoutMs: 20 }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Maintenance drain timed out before all active work completed.",
      code: "MAINTENANCE_DRAIN_TIMEOUT",
      status: draining,
    });
  });
});
