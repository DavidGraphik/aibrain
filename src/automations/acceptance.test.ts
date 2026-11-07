import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AUTOMATION_EXECUTION_CONTEXT, type AutomationTaskInput } from "@/automations/contracts";
import { FileAutomationProposalStore, isExplicitAutomationConfirmation } from "@/automations/chat-tools";
import { scheduledTurnOptions } from "@/automations/execution-context";
import { FileAutomationStore } from "@/automations/store";

vi.mock("server-only", () => ({}));

const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
const projectId = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000001";
const baseTime = Date.parse("2030-08-30T08:00:00.000Z");

function input(runAt = "2030-08-30T09:00:00.000Z"): AutomationTaskInput {
  return {
    name: "Informe",
    prompt: "Prepara el informe.",
    projectId,
    projectName: "Operaciones",
    timeZone: "Europe/Madrid",
    schedule: { kind: "once", runAt },
    executionContext: DEFAULT_AUTOMATION_EXECUTION_CONTEXT,
    audience: { membershipPolicy: "current", userIds: [userA], groupIds: [] },
  };
}

describe("automation product acceptance", () => {
  it("persists a two-hour schedule across restart and settles an offline catch-up without a burst", async () => {
    const usersRoot = await mkdtemp(path.join(os.tmpdir(), "aibrain-automation-two-hour-"));
    const first = new FileAutomationStore({ installationId: "acceptance", userId: userA, usersRoot, now: () => baseTime });
    const task = await first.create({ ...input(), schedule: { kind: "interval", minutes: 120, anchorAt: new Date(baseTime + 120 * 60_000).toISOString() } });
    expect(task.nextRunAt).toBe(new Date(baseTime + 120 * 60_000).toISOString());
    const restarted = new FileAutomationStore({ installationId: "acceptance", userId: userA, usersRoot, now: () => baseTime + 9 * 3_600_000 });
    const [claim] = await restarted.claimDue("restarted-worker");
    expect(claim.task.schedule.kind).toBe("interval");
    expect(await restarted.claimDue("other-worker")).toEqual([]);
    await restarted.settle(claim, { status: "succeeded" });
    expect((await restarted.get(task.id)).nextRunAt).toBe(new Date(baseTime + 10 * 3_600_000).toISOString());
    expect(await restarted.claimDue("restarted-worker")).toEqual([]);
  });

  it("keeps an offline occurrence durable across restart and isolated from another user", async () => {
    const usersRoot = await mkdtemp(path.join(os.tmpdir(), "aibrain-automation-offline-"));
    const first = new FileAutomationStore({ installationId: "acceptance", userId: userA, usersRoot, now: () => baseTime });
    const task = await first.create(input());
    const restarted = new FileAutomationStore({ installationId: "acceptance", userId: userA, usersRoot, now: () => baseTime + 3_600_001 });
    expect((await restarted.list()).map(({ id }) => id)).toEqual([task.id]);
    expect(await restarted.claimDue("worker-restarted")).toHaveLength(1);
    const foreign = new FileAutomationStore({ installationId: "acceptance", userId: userB, usersRoot, now: () => baseTime + 3_600_001 });
    await expect(foreign.get(task.id)).rejects.toMatchObject({ code: "AUTOMATION_NOT_FOUND" });
  }, 30_000);

  it("queues run-now exactly once while paused and preserves the paused recurrence", async () => {
    const usersRoot = await mkdtemp(path.join(os.tmpdir(), "aibrain-automation-run-now-"));
    const store = new FileAutomationStore({ installationId: "acceptance", userId: userA, usersRoot, now: () => baseTime });
    const task = await store.create({ ...input(), schedule: { kind: "daily", hour: 12, minute: 0 } });
    await store.update(task.id, { state: "paused" });
    await store.runNow(task.id, requestId);
    await store.runNow(task.id, requestId);
    await expect(store.runNow(task.id, "20000000-0000-4000-8000-000000000002"))
      .rejects.toMatchObject({ code: "AUTOMATION_RUN_PENDING" });
    const [claim] = await store.claimDue("worker-manual");
    expect(claim.runKey).toBe(`${task.id}:manual:${requestId}`);
    await store.appendRun({
      schemaVersion: 1,
      runKey: claim.runKey,
      taskId: task.id,
      installationId: "acceptance",
      userId: userA,
      scheduledFor: claim.scheduledFor,
      status: "running",
      attempt: 1,
      startedAt: new Date(baseTime).toISOString(),
      finishedAt: null,
      threadId: null,
      error: null,
    });
    await store.appendRun({
      schemaVersion: 1,
      runKey: claim.runKey,
      taskId: task.id,
      installationId: "acceptance",
      userId: userA,
      scheduledFor: claim.scheduledFor,
      status: "running",
      attempt: 1,
      startedAt: new Date(baseTime).toISOString(),
      finishedAt: null,
      threadId: "30000000-0000-4000-8000-000000000001",
      error: null,
    });
    await store.appendRun({
      schemaVersion: 1,
      runKey: claim.runKey,
      taskId: task.id,
      installationId: "acceptance",
      userId: userA,
      scheduledFor: claim.scheduledFor,
      status: "succeeded",
      attempt: 1,
      startedAt: new Date(baseTime).toISOString(),
      finishedAt: new Date(baseTime + 1).toISOString(),
      threadId: "30000000-0000-4000-8000-000000000001",
      error: null,
    });
    await store.settle(claim, { status: "succeeded" });
    expect(await store.get(task.id)).toMatchObject({ state: "paused", manualRun: null, lastRunStatus: "succeeded" });
    expect(await store.listRuns(task.id)).toEqual([
      expect.objectContaining({ runKey: claim.runKey, attempt: 1, status: "succeeded" }),
    ]);
    expect(await store.runNow(task.id, requestId)).toMatchObject({ manualRun: null });
    expect(await store.claimDue("worker-manual")).toEqual([]);
  }, 30_000);

  it("always enables web and carries current authorized skills and connector ids into a scheduled turn", () => {
    expect(scheduledTurnOptions({ skillsAuthorized: true, connectorMentions: ["gmail", "crm-company"] }))
      .toMatchObject({ webSearch: true, inheritAuthorizedSkills: true, connectorMentions: ["gmail", "crm-company"] });
  }, 30_000);

  it("requires a later explicit chat confirmation and replays confirmation without creating twice", async () => {
    const usersRoot = await mkdtemp(path.join(os.tmpdir(), "aibrain-automation-chat-"));
    const first = new FileAutomationProposalStore({ installationId: "acceptance", userId: userA, usersRoot });
    const proposal = await first.propose(input(), { sourceThreadId: projectId, sourceTurnId: requestId, callId: "call-1" });
    expect(isExplicitAutomationConfirmation("Sí, confírmala")).toBe(true);
    expect(isExplicitAutomationConfirmation("No, todavía no la crees")).toBe(false);
    expect(isExplicitAutomationConfirmation("yes, don't create it")).toBe(false);
    expect(isExplicitAutomationConfirmation("sí, espera")).toBe(false);
    expect(isExplicitAutomationConfirmation("confirmar si esto se puede editar")).toBe(false);
    await expect(first.confirm(proposal.id, { sourceThreadId: projectId, currentTurnId: requestId, currentMessage: "Sí" }, async () => undefined))
      .rejects.toThrow("mensaje posterior");
    const restarted = new FileAutomationProposalStore({ installationId: "acceptance", userId: userA, usersRoot });
    const create = vi.fn(async () => undefined);
    const confirmed = await restarted.confirm(proposal.id, { sourceThreadId: projectId, currentTurnId: userB, currentMessage: "Confirmo, adelante" }, create);
    expect(confirmed.status).toBe("confirmed");
    await restarted.confirm(proposal.id, { sourceThreadId: projectId, currentTurnId: userB, currentMessage: "Confirmo" }, create);
    expect(create).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("reconciles a crash after durable confirmation without asking for consent again", async () => {
    const usersRoot = await mkdtemp(path.join(os.tmpdir(), "aibrain-automation-confirming-"));
    const proposals = new FileAutomationProposalStore({ installationId: "acceptance", userId: userA, usersRoot });
    const proposal = await proposals.propose(input(), { sourceThreadId: projectId, sourceTurnId: requestId, callId: "call-crash" });
    const firstEffect = vi.fn(async () => { throw new Error("crash-after-create"); });
    await expect(proposals.confirm(proposal.id, {
      sourceThreadId: projectId,
      currentTurnId: userB,
      currentMessage: "Sí, confírmala",
    }, firstEffect)).rejects.toThrow("crash-after-create");

    const restarted = new FileAutomationProposalStore({ installationId: "acceptance", userId: userA, usersRoot });
    const reconcile = vi.fn(async () => undefined);
    const confirmed = await restarted.confirm(proposal.id, {
      sourceThreadId: projectId,
      currentTurnId: "00000000-0000-4000-8000-000000000005",
      currentMessage: "recovery does not grant new consent",
    }, reconcile);
    expect(confirmed).toMatchObject({ status: "confirmed", confirmationTurnId: userB });
    expect(firstEffect).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  }, 120_000);
});
