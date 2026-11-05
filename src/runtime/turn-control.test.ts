import { describe, expect, it, vi } from "vitest";
import { isTurnControlRequest, type TurnControlRequest } from "@/lib/chat-contract";

const mocked = vi.hoisted(() => ({
  cancel: vi.fn(() => true),
  queueCancellation: vi.fn(() => true),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/runtime/worker-runtime-service", () => ({
  cancelWorkerTurnLocally: mocked.cancel,
  requestPendingWorkerTurnCancellation: mocked.queueCancellation,
  workerAppServerForUser: vi.fn(),
}));

import { cancelPendingWorkerTurn, executeTurnControl, TurnControlError } from "@/runtime/turn-control";
import { AppServerRequestTimeoutError } from "@/runtime/transport/app-server-rpc-router";

const identity = {
  installationId: "qa-company",
  userId: "00000000-0000-4000-8000-000000000001",
  runtimeThreadId: "runtime-thread-1",
  runtimeTurnId: "runtime-turn-1",
};
const assistantMessageId = "00000000-0000-4000-8000-000000000041";
const clientRequestId = "00000000-0000-4000-8000-000000000051";
const userMessageId = "00000000-0000-4000-8000-000000000061";

describe("turn control", () => {
  it("validates strict, bounded UI control contracts", () => {
    expect(isTurnControlRequest({
      action: "stop",
      threadId: "00000000-0000-4000-8000-000000000021",
      assistantMessageId,
      clientRequestId,
    })).toBe(true);
    expect(isTurnControlRequest({
      action: "steer",
      threadId: "00000000-0000-4000-8000-000000000021",
      assistantMessageId,
      clientRequestId,
      userMessageId,
      message: "Comprova també el risc contractual.",
    })).toBe(true);
    expect(isTurnControlRequest({
      action: "stop",
      threadId: "00000000-0000-4000-8000-000000000021",
      assistantMessageId,
      clientRequestId,
      runtimeTurnId: "attacker-selected",
    })).toBe(false);
    expect(isTurnControlRequest({
      action: "steer",
      threadId: "00000000-0000-4000-8000-000000000021",
      assistantMessageId,
      clientRequestId,
      userMessageId,
      message: "\0",
    })).toBe(false);
  });

  it("steers only the expected active runtime turn and persists before resolving", async () => {
    const persisted: unknown[] = [];
    const request = vi.fn(async (
      method: string,
      params: unknown,
      purpose: string,
      _timeout: number,
      beforeResolve: (value: unknown) => Promise<void>,
    ) => {
      expect(method).toBe("turn/steer");
      expect(params).toEqual({
        threadId: identity.runtimeThreadId,
        expectedTurnId: identity.runtimeTurnId,
        clientUserMessageId: userMessageId,
        input: [{
          type: "text",
          text: "Comprova també el risc contractual.",
          text_elements: [],
        }],
      });
      expect(purpose).toBe(`turn-steer:${clientRequestId}`);
      await beforeResolve({ turnId: identity.runtimeTurnId });
      expect(persisted).toHaveLength(1);
      return { turnId: identity.runtimeTurnId };
    });
    const control: TurnControlRequest = {
      action: "steer",
      threadId: "00000000-0000-4000-8000-000000000021",
      assistantMessageId,
      clientRequestId,
      userMessageId,
      message: "  Comprova també el risc contractual.  ",
    };
    await expect(executeTurnControl(
      { request } as never,
      identity,
      control,
      async (event) => { persisted.push(event); },
    )).resolves.toEqual({ action: "steer", runtimeTurnId: identity.runtimeTurnId });
    expect(persisted).toMatchObject([{ type: "activity", item: { id: `steer:${clientRequestId}` } }]);
  });

  it("persists only an interrupt request ACK, then cancels local approval waiters", async () => {
    mocked.cancel.mockClear();
    const persisted: unknown[] = [];
    const request = vi.fn(async (
      method: string,
      params: unknown,
      purpose: string,
      _timeout: number,
      beforeResolve: (value: unknown) => Promise<void>,
    ) => {
      expect(method).toBe("turn/interrupt");
      expect(params).toEqual({
        threadId: identity.runtimeThreadId,
        turnId: identity.runtimeTurnId,
      });
      expect(purpose).toBe(`turn-interrupt:${clientRequestId}`);
      await beforeResolve({});
      return {};
    });
    const control: TurnControlRequest = {
      action: "stop",
      threadId: "00000000-0000-4000-8000-000000000021",
      assistantMessageId,
      clientRequestId,
    };
    await expect(executeTurnControl(
      { request } as never,
      identity,
      control,
      async (event) => { persisted.push(event); },
    )).resolves.toEqual({
      action: "stop",
      runtimeTurnId: identity.runtimeTurnId,
      activeRunnerCancelled: true,
    });
    expect(persisted).toEqual([
      { type: "activity", item: expect.objectContaining({ id: `stop:${clientRequestId}`, status: "complete" }) },
    ]);
    expect(mocked.cancel).toHaveBeenCalledWith(
      identity.userId,
      identity.runtimeThreadId,
      assistantMessageId,
      true,
    );
  });

  it("accepts a late interrupt request ACK without projecting a terminal result", async () => {
    mocked.cancel.mockClear();
    const persisted: unknown[] = [];
    const request = vi.fn(async (
      _method: string,
      _params: unknown,
      purpose: string,
      _timeout: number,
      beforeResolve: (value: unknown) => Promise<void>,
    ) => {
      const lateResponse = Promise.resolve().then(async () => {
        await beforeResolve({});
        return {};
      });
      throw new AppServerRequestTimeoutError("turn/interrupt", purpose, 10_000, lateResponse);
    });
    const control: TurnControlRequest = {
      action: "stop",
      threadId: "00000000-0000-4000-8000-000000000021",
      assistantMessageId,
      clientRequestId,
    };
    await expect(executeTurnControl(
      { request } as never,
      identity,
      control,
      async (event) => { persisted.push(event); },
    )).resolves.toEqual({
      action: "stop",
      runtimeTurnId: identity.runtimeTurnId,
      activeRunnerCancelled: true,
    });
    expect(persisted).toEqual([
      { type: "activity", item: expect.objectContaining({ id: `stop:${clientRequestId}`, status: "complete" }) },
    ]);
  });

  it("records only a pending request before App Server has assigned a runtime turn id", async () => {
    mocked.cancel.mockClear();
    mocked.cancel.mockReturnValueOnce(true);
    const persisted: unknown[] = [];
    const control: Extract<TurnControlRequest, { action: "stop" }> = {
      action: "stop",
      threadId: "00000000-0000-4000-8000-000000000021",
      assistantMessageId,
      clientRequestId,
    };

    await expect(cancelPendingWorkerTurn(
      {
        installationId: identity.installationId,
        userId: identity.userId,
        runtimeThreadId: identity.runtimeThreadId,
      },
      control,
      async (event) => { persisted.push(event); },
    )).resolves.toEqual({
      action: "stop",
      runtimeTurnId: null,
      activeRunnerCancelled: true,
    });
    expect(mocked.cancel).toHaveBeenCalledWith(
      identity.userId,
      identity.runtimeThreadId,
      assistantMessageId,
      false,
    );
    expect(persisted).toEqual([
      { type: "activity", item: expect.objectContaining({ id: `stop:${clientRequestId}`, status: "complete" }) },
    ]);
  });

  it("does not claim a pending stop when no matching local worker turn exists", async () => {
    mocked.cancel.mockReturnValueOnce(false);
    mocked.queueCancellation.mockReturnValueOnce(false);
    await expect(cancelPendingWorkerTurn(
      {
        installationId: identity.installationId,
        userId: identity.userId,
        runtimeThreadId: identity.runtimeThreadId,
      },
      {
        action: "stop",
        threadId: "00000000-0000-4000-8000-000000000021",
        assistantMessageId,
        clientRequestId,
      },
      vi.fn(),
    )).rejects.toMatchObject({ code: "TURN_CONTROL_NOT_ACTIVE" });
  });

  it("queues an immediate stop before App Server has returned a thread id", async () => {
    mocked.queueCancellation.mockClear();
    mocked.queueCancellation.mockReturnValueOnce(true);
    const persisted: unknown[] = [];
    await expect(cancelPendingWorkerTurn(
      {
        installationId: identity.installationId,
        userId: identity.userId,
        runtimeThreadId: null,
      },
      {
        action: "stop",
        threadId: "00000000-0000-4000-8000-000000000021",
        assistantMessageId,
        clientRequestId,
      },
      async (event) => { persisted.push(event); },
    )).resolves.toMatchObject({ action: "stop", runtimeTurnId: null });
    expect(mocked.queueCancellation).toHaveBeenCalledWith(identity.userId, assistantMessageId);
    expect(persisted).toEqual([
      { type: "activity", item: expect.objectContaining({ status: "complete" }) },
    ]);
  });

  it("rejects an inconsistent steer response", async () => {
    const request = vi.fn(async (
      _method: string,
      _params: unknown,
      _purpose: string,
      _timeout: number,
      beforeResolve: (value: unknown) => Promise<void>,
    ) => {
      await beforeResolve({ turnId: "runtime-turn-other" });
      return { turnId: "runtime-turn-other" };
    });
    await expect(executeTurnControl(
      { request } as never,
      identity,
      {
        action: "steer",
        threadId: "00000000-0000-4000-8000-000000000021",
        assistantMessageId,
        clientRequestId,
        userMessageId,
        message: "Una indicació",
      },
      async () => undefined,
    )).rejects.toBeInstanceOf(TurnControlError);
  });
});
