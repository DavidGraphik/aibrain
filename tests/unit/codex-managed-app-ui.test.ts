import { describe, expect, it, vi } from "vitest";
import {
  loadManagedAppCapability,
  prepareManagedAppAction,
  resolveManagedAppAction,
} from "@/ui/codex-managed-app-ui";

const target = { threadId: "thread-current", turnId: "turn-current", itemId: "turn-current", approvalId: "turn-current" };
const fingerprint = "a".repeat(64);
const descriptor = {
  operation: "execute-allowlisted-action",
  locator: target,
  authorizationFingerprint: fingerprint,
  approval: {
    id: target.approvalId, ...target, kind: "command", title: "Confirmar acción conectada",
    detail: "Ejecutar la acción aprobada de la aplicación conectada.", status: "pending",
  },
} as const;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("codex managed app UI adapter", () => {
  it("gates the consumer on a connected allowlisted capability", async () => {
    const unavailable = vi.fn(async () => response({ schemaVersion: 1, connectors: [{ connectorId: "codex-managed-app", status: "connected", effectiveOperations: [] }] }));
    await expect(loadManagedAppCapability(unavailable)).resolves.toBe(false);

    const available = vi.fn(async () => response({ schemaVersion: 1, connectors: [{ connectorId: "codex-managed-app", status: "connected", effectiveOperations: ["execute-allowlisted-action"] }] }));
    await expect(loadManagedAppCapability(available)).resolves.toBe(true);
  });

  it("prepares pending approval, executes only after accept, and exports no protected fields", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/connectors/codex-managed-app/action" && JSON.parse(String(init?.body)).operation === "prepare") {
        return response({ schemaVersion: 1, descriptor });
      }
      if (input === "/api/runtime/approvals") return response({ ok: true, status: "approved" });
      return response({ schemaVersion: 1, outcome: "executed" });
    });
    const prepared = await prepareManagedAppAction(fetcher, target);
    expect(prepared?.approval.status).toBe("pending");
    const result = await resolveManagedAppAction(fetcher, prepared!, { threadId: target.threadId, turnId: target.turnId }, "accept");
    expect(result).toEqual({ state: "terminal", outcome: "executed", approval: { ...descriptor.approval, status: "accepted" } });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({ operation: "execute", locator: target, authorizationFingerprint: fingerprint });
    expect(JSON.stringify(result)).not.toMatch(/receipt|authorizationSnapshot|credentialRef|server|tool|arguments|correlation/i);
  });

  it("declines without execute and clears cross-thread stale descriptors without any request", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ ok: true, status: "denied" }));
    const declined = await resolveManagedAppAction(fetcher, descriptor, { threadId: target.threadId, turnId: target.turnId }, "decline");
    expect(declined).toMatchObject({ state: "terminal", outcome: "denied", approval: { status: "declined" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("/api/runtime/approvals");

    fetcher.mockClear();
    const stale = await resolveManagedAppAction(fetcher, descriptor, { threadId: "thread-other", turnId: target.turnId }, "accept");
    expect(stale).toEqual({ state: "recoverable", stage: "current-thread" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps an indeterminate outcome visible without exposing provider data", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => input === "/api/runtime/approvals"
      ? response({ ok: true, status: "approved" })
      : response({ schemaVersion: 1, outcome: "indeterminate", correlation: "must-not-leak" }));
    const result = await resolveManagedAppAction(fetcher, descriptor, { threadId: target.threadId, turnId: target.turnId }, "accept");
    expect(result).toMatchObject({ state: "terminal", outcome: "indeterminate" });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("keeps the same descriptor recoverable after approval or execute failures", async () => {
    const approvalFailure = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ error: "unavailable" }, 503));
    await expect(resolveManagedAppAction(approvalFailure, descriptor, target, "accept"))
      .resolves.toEqual({ state: "recoverable", stage: "approval" });
    expect(approvalFailure).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(approvalFailure.mock.calls[0]?.[1]?.body))).toEqual({
      ...target,
      authorizationFingerprint: fingerprint,
      decision: "accept",
    });

    let executeAttempts = 0;
    const retryingFetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/runtime/approvals") return response({ ok: true, status: "approved" });
      executeAttempts += 1;
      return executeAttempts === 1
        ? response({ error: "temporary" }, 500)
        : response({ schemaVersion: 1, outcome: "replayed" });
    });
    const first = await resolveManagedAppAction(retryingFetcher, descriptor, target, "accept");
    expect(first).toEqual({ state: "recoverable", stage: "execute" });
    const retry = await resolveManagedAppAction(retryingFetcher, descriptor, target, "accept");
    expect(retry).toMatchObject({ state: "terminal", outcome: "replayed" });
    expect(JSON.parse(String(retryingFetcher.mock.calls[1]?.[1]?.body))).toEqual(
      JSON.parse(String(retryingFetcher.mock.calls[3]?.[1]?.body)),
    );
  });

  it("does not invent a terminal result for malformed execute JSON", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => input === "/api/runtime/approvals"
      ? response({ ok: true, status: "approved" })
      : new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(resolveManagedAppAction(fetcher, descriptor, target, "accept"))
      .resolves.toEqual({ state: "recoverable", stage: "execute" });
  });
});
