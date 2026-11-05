import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, isSameOriginMutation, codexManagedAppActionForSession, prepare, execute } = vi.hoisted(() => ({
  getSession: vi.fn(), isSameOriginMutation: vi.fn(), codexManagedAppActionForSession: vi.fn(), prepare: vi.fn(), execute: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({ getSession }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation }));
vi.mock("@/connectors/server-service", () => ({ codexManagedAppActionForSession }));

import { POST } from "@/app/api/connectors/codex-managed-app/action/route";

const session = {
  provider: "local" as const,
  user: { id: "00000000-0000-4000-8000-000000000001", name: "Ada", email: "ada@example.com" },
  tenant: { id: "example-lab", name: "Example" }, expiresAt: "2026-08-29T00:00:00.000Z",
};
const locator = { threadId: "thread-one", turnId: "turn-one", itemId: "item-one", approvalId: "approval-one" };
const fingerprint = "a".repeat(64);

describe("Codex managed action route", () => {
  beforeEach(() => {
    vi.clearAllMocks(); getSession.mockResolvedValue(session); isSameOriginMutation.mockResolvedValue(true);
    codexManagedAppActionForSession.mockResolvedValue({ prepare, execute });
  });

  it("returns only a safe pending descriptor and routes server-derived identity", async () => {
    prepare.mockResolvedValue({ operation: "execute-allowlisted-action", locator, authorizationFingerprint: fingerprint, approval: { id: locator.approvalId, ...locator, kind: "command", title: "Confirm", detail: "Configured action", status: "pending" } });
    const response = await POST(new Request("https://example.test/api/connectors/codex-managed-app/action", { method: "POST", body: JSON.stringify({ operation: "prepare", ...locator }) }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({ schemaVersion: 1, descriptor: expect.objectContaining({ authorizationFingerprint: fingerprint }) }));
    expect(JSON.stringify(body)).not.toMatch(/receipt|credentialRef|authorization"|server|tool|arguments/i);
    expect(prepare).toHaveBeenCalledWith({ installationId: session.tenant.id, userId: session.user.id, ...locator });
  });

  it("rejects browser supplied receipt, snapshot, authorization, server, tool, or arguments", async () => {
    for (const forbidden of ["receipt", "snapshot", "authorization", "auth", "server", "tool", "args", "arguments"]) {
      const response = await POST(new Request("https://example.test/api/connectors/codex-managed-app/action", { method: "POST", body: JSON.stringify({ operation: "execute", locator, authorizationFingerprint: fingerprint, [forbidden]: "x" }) }));
      expect(response.status).toBe(400);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes only operation, locator, and fingerprint for execution", async () => {
    execute.mockResolvedValue({ outcome: "executed" });
    const response = await POST(new Request("https://example.test/api/connectors/codex-managed-app/action", { method: "POST", body: JSON.stringify({ operation: "execute", locator, authorizationFingerprint: fingerprint }) }));
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith({ operation: "execute-allowlisted-action", locator, authorizationFingerprint: fingerprint });
  });
});
