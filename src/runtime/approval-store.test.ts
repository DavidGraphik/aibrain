import { createInteractiveChatAuthorization } from "@/runtime/interactive-chat-authorization";
import type { AuthSession } from "@/auth/types";
vi.mock("server-only", () => ({}));
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isApprovalItem, isApprovalResolutionRequest, type ApprovalItem } from "@/lib/chat-contract";
import {
  FileApprovalStore,
  approvalLocatorFromItem,
  waitForApproval,
  type ConnectorApprovalReceipt,
  type ApprovalLocator,
} from "@/runtime/approval-store";

const INSTALLATION_ID = "northwind-test";
const USER_A = "11a11111-1111-4111-8111-111111111111";
const USER_B = "22b22222-2222-4222-8222-222222222222";

function approval(
  approvalId: string,
  threadId: string,
  turnId: string,
  itemId: string,
): ApprovalItem {
  return {
    id: approvalId,
    threadId,
    turnId,
    itemId,
    kind: "command",
    title: "Approve command",
    detail: "Synthetic approval used only by tests.",
    status: "pending",
  };
}

describe("FileApprovalStore", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-approvals-"));
    temporaryRoots.push(root);
    const usersRoot = path.join(root, "employees");
    await mkdir(path.join(usersRoot, USER_A), { recursive: true, mode: 0o700 });
    await mkdir(path.join(usersRoot, USER_B), { recursive: true, mode: 0o700 });
    await chmod(usersRoot, 0o700);
    await chmod(path.join(usersRoot, USER_A), 0o700);
    await chmod(path.join(usersRoot, USER_B), 0o700);
    return { root, usersRoot };
  }

  function store(usersRoot: string, userId = USER_A, now?: () => number) {
    return new FileApprovalStore({
      installationId: INSTALLATION_ID,
      userId,
      usersRoot,
      ...(now ? { now } : {}),
    });
  }

  function locator(item: ApprovalItem, userId = USER_A): ApprovalLocator {
    return approvalLocatorFromItem(INSTALLATION_ID, userId, item);
  }

  function fingerprint(seed = "a") {
    return seed.repeat(64);
  }

  function receiptFrom(result: { receipt: ConnectorApprovalReceipt | null }) {
    if (!result.receipt) throw new Error("Expected connector approval receipt.");
    return result.receipt;
  }

  it("resolves real native receipts from exact chat authority and preserves immutable binding across store restart", async () => {
    const { usersRoot } = await fixture();
    const item = approval("chat-native", "chat-thread", "chat-turn", "chat-command");
    const itemLocator = locator(item);
    const currentFileStore = store(usersRoot);
    const createAuthority = (overrides: { userId?: string; threadId?: string; turnId?: string; message?: string; userMessageId?: string } = {}) => {
      const actor = overrides.userId ?? USER_A;
      return createInteractiveChatAuthorization({ installationId: INSTALLATION_ID, userId: actor,
        threadId: overrides.threadId ?? item.threadId, turnId: overrides.turnId ?? item.turnId,
        userMessageId: overrides.userMessageId ?? "direct-message", message: overrides.message ?? "Create the requested project file",
        signal: new AbortController().signal, backgroundExecution: false, mode: "agent", localTurnId: "local-turn",
        session: { provider: "local", tenant: { id: INSTALLATION_ID, name: "QA" }, user: { id: actor, name: "Test", email: "qa@example.test" }, expiresAt: new Date(Date.now() + 3600000).toISOString() } as AuthSession,
        permissions: { installationId: INSTALLATION_ID, userId: actor, turnId: "local-turn", fingerprint: fingerprint(), rules: [{ ruleId: "tools.execute", action: "execute", effect: "allow", instruction: "Execute authorized project work", sourceScope: "installation", sourcePolicyVersion: 1, precedence: 0 }] },
      })!;
    };
    const authorization = createAuthority();
    const request = { locator: itemLocator, requestType: "command" as const, requestFingerprint: fingerprint("b"), authorization };
    const legacyPending = vi.spyOn(currentFileStore, "createPending");
    // The real locator has itemId/approvalId beyond the four authority fields.
    // This caught the structural-extra-property authorization regression.
    await expect(currentFileStore.resolveChatApproval(request)).resolves.toBe("accept");
    expect(legacyPending).not.toHaveBeenCalled();
    expect(await currentFileStore.read(itemLocator)).toMatchObject({ status: "resolved", decision: "accept" });
    await expect(currentFileStore.resolveChatApproval(request)).resolves.toBe("accept");
    const restartedFileStore = store(usersRoot);
    await expect(restartedFileStore.resolveChatApproval({ ...request, authorization: createAuthority() })).resolves.toBe("accept");
    expect((await restartedFileStore.readEvents()).map(event => event.payload.eventType)).toEqual(["requested", "resolved"]);
    await expect(restartedFileStore.resolveChatApproval({ ...request, requestFingerprint: fingerprint("c") })).rejects.toMatchObject({ code: "APPROVAL_RECORD_MISMATCH" });
    for (const patch of [{ message: "A different action" }, { userMessageId: "another-direct-message" }])
      await expect(restartedFileStore.resolveChatApproval({ ...request, authorization: createAuthority(patch) })).rejects.toMatchObject({ code: "APPROVAL_RECORD_MISMATCH" });
    for (const patch of [{ userId: USER_B }, { threadId: "foreign-thread" }, { turnId: "foreign-turn" }])
      await expect(restartedFileStore.resolveChatApproval({ ...request, authorization: createAuthority(patch) })).rejects.toThrow("INTERACTIVE_CHAT_REQUIRED");
    await expect(restartedFileStore.resolveChatApproval({ ...request, authorization: { ...authorization } })).rejects.toThrow("INTERACTIVE_CHAT_REQUIRED");
    expect(await restartedFileStore.read(itemLocator)).toMatchObject({ status: "resolved", decision: "accept" });
    expect((await restartedFileStore.readEvents()).map(event => event.payload.eventType)).toEqual(["requested", "resolved"]);
  });

  it("persists a decision across independent store instances and restart replay", async () => {
    const { usersRoot } = await fixture();
    const item = approval("approval-restart", "thread-restart", "turn-restart", "item-restart");
    const firstProcess = store(usersRoot);
    await firstProcess.createPending({ locator: locator(item), requestType: "command" });

    const secondProcess = store(usersRoot);
    expect((await secondProcess.resolve(locator(item), "accept")).outcome).toBe("resolved");

    const restartedProcess = store(usersRoot);
    await expect(waitForApproval(
      restartedProcess,
      item,
      "command",
      new AbortController().signal,
      { pollIntervalMs: 5 },
    )).resolves.toBe("accept");
    expect(await restartedProcess.read(locator(item))).toMatchObject({
      status: "resolved",
      decision: "accept",
    });
    expect((await restartedProcess.readEvents()).map((entry) => entry.payload.eventType))
      .toEqual(["requested", "resolved"]);
  });

  it("repairs a missing journal tail from the authoritative record after a crash", async () => {
    const { usersRoot } = await fixture();
    const item = approval("approval-repair", "thread-repair", "turn-repair", "item-repair");
    const firstProcess = store(usersRoot);
    await firstProcess.createPending({ locator: locator(item), requestType: "permissions" });
    await firstProcess.resolve(locator(item), "acceptForSession");
    await rm(firstProcess.journalPath);

    const restartedProcess = store(usersRoot);
    await expect(waitForApproval(
      restartedProcess,
      item,
      "permissions",
      new AbortController().signal,
      { pollIntervalMs: 5 },
    )).resolves.toBe("acceptForSession");
    expect((await restartedProcess.readEvents()).map((entry) => ({
      eventType: entry.payload.eventType,
      decision: entry.payload.decision,
    }))).toEqual([
      { eventType: "requested", decision: null },
      { eventType: "resolved", decision: "acceptForSession" },
    ]);
  });

  it("rejects cross-user identity and cannot resolve a different thread, turn, or item", async () => {
    const { usersRoot } = await fixture();
    const item = approval("approval-isolated", "thread-a", "turn-a", "item-a");
    const userAStore = store(usersRoot, USER_A);
    await userAStore.createPending({ locator: locator(item, USER_A), requestType: "command" });

    const wrongThread = { ...locator(item, USER_A), threadId: "thread-b" };
    const wrongTurn = { ...locator(item, USER_A), turnId: "turn-b" };
    const wrongItem = { ...locator(item, USER_A), itemId: "item-b" };
    await expect(userAStore.resolve(wrongThread, "accept")).resolves.toMatchObject({
      outcome: "not-found",
    });
    await expect(userAStore.resolve(wrongTurn, "accept")).resolves.toMatchObject({
      outcome: "not-found",
    });
    await expect(userAStore.resolve(wrongItem, "accept")).resolves.toMatchObject({
      outcome: "not-found",
    });

    const userBStore = store(usersRoot, USER_B);
    await expect(userBStore.resolve(locator(item, USER_A), "accept"))
      .rejects.toMatchObject({ code: "APPROVAL_IDENTITY_MISMATCH" });
    expect(await userAStore.read(locator(item, USER_A))).toMatchObject({ status: "pending" });
  });

  it("lets an unrelated approval resolve while another turn remains pending", async () => {
    const { usersRoot } = await fixture();
    const approvals = store(usersRoot);
    const first = approval("approval-first", "thread-first", "turn-first", "item-first");
    const second = approval("approval-second", "thread-second", "turn-second", "item-second");
    await approvals.createPending({ locator: locator(first), requestType: "command" });
    await approvals.createPending({ locator: locator(second), requestType: "command" });

    const firstWait = waitForApproval(
      approvals,
      first,
      "command",
      new AbortController().signal,
      { pollIntervalMs: 5 },
    );
    const secondWait = waitForApproval(
      approvals,
      second,
      "command",
      new AbortController().signal,
      { pollIntervalMs: 5 },
    );
    await approvals.resolve(locator(second), "decline");
    await expect(secondWait).resolves.toBe("decline");
    expect(await approvals.read(locator(first))).toMatchObject({ status: "pending" });
    await approvals.resolve(locator(first), "acceptForSession");
    await expect(firstWait).resolves.toBe("acceptForSession");
  });

  it("is exactly idempotent for the same decision and rejects conflicting replay", async () => {
    const { usersRoot } = await fixture();
    const approvals = store(usersRoot);
    const item = approval("approval-idempotent", "thread-idempotent", "turn-idempotent", "item-idempotent");
    await approvals.createPending({ locator: locator(item), requestType: "file" });
    expect((await approvals.resolve(locator(item), "accept")).outcome).toBe("resolved");
    expect((await approvals.resolve(locator(item), "accept")).outcome).toBe("already-resolved");
    await expect(approvals.resolve(locator(item), "decline"))
      .rejects.toMatchObject({ code: "APPROVAL_DECISION_CONFLICT" });
    expect((await approvals.readEvents()).map((entry) => entry.payload.eventType))
      .toEqual(["requested", "resolved"]);
  });

  it("expires pending state durably and cancels a waiting approval on abort", async () => {
    const { usersRoot } = await fixture();
    let clock = Date.UTC(2026, 7, 27, 12, 0, 0);
    const approvals = store(usersRoot, USER_A, () => clock);
    const expiring = approval("approval-expiring", "thread-expiring", "turn-expiring", "item-expiring");
    await approvals.createPending({
      locator: locator(expiring),
      requestType: "command",
      ttlMs: 100,
    });
    clock += 101;
    expect(await approvals.read(locator(expiring))).toMatchObject({ status: "expired" });

    const cancellable = approval("approval-cancel", "thread-cancel", "turn-cancel", "item-cancel");
    const controller = new AbortController();
    const waiting = waitForApproval(approvals, cancellable, "command", controller.signal, {
      pollIntervalMs: 5,
      ttlMs: 1_000,
    });
    controller.abort();
    await expect(waiting).resolves.toBe("cancel");
    expect(await approvals.read(locator(cancellable))).toMatchObject({ status: "cancelled" });
  });

  it("rejects a symlink substituted for a durable approval record", async () => {
    const { root, usersRoot } = await fixture();
    const approvals = store(usersRoot);
    const item = approval("approval-link", "thread-link", "turn-link", "item-link");
    await approvals.createPending({ locator: locator(item), requestType: "command" });
    const files = await readdir(approvals.recordsRoot);
    const target = path.join(approvals.recordsRoot, files[0]);
    await rm(target);
    await symlink(path.join(root, "outside.json"), target);
    await expect(approvals.read(locator(item)))
      .rejects.toMatchObject({ code: "APPROVAL_PATH_UNSAFE" });
  });

  it("requires the complete routing tuple in the browser decision contract", () => {
    expect(isApprovalItem({
      ...approval("approval-browser", "thread-browser", "turn-browser", "item-browser"),
      kind: "browser",
      permissionFingerprint: "a".repeat(64),
    })).toBe(true);
    expect(isApprovalResolutionRequest({
      approvalId: "approval-contract",
      threadId: "thread-contract",
      turnId: "turn-contract",
      itemId: "item-contract",
      decision: "accept",
    })).toBe(true);
    expect(isApprovalResolutionRequest({
      approvalId: "approval-contract",
      decision: "accept",
    })).toBe(false);
    expect(isApprovalResolutionRequest({
      approvalId: "approval-contract",
      threadId: "thread-other",
      turnId: "turn-contract",
      itemId: "item-contract",
      decision: "always",
    })).toBe(false);
  });

  it("binds connector authorization, receipt, revalidation, execution, and audit without arguments", async () => {
    const { usersRoot } = await fixture();
    const approvals = store(usersRoot);
    const item = approval("connector-success", "thread-connector", "turn-connector", "item-connector");
    const prepared = await approvals.prepareConnectorApproval({
      locator: locator(item),
      authorizationFingerprint: fingerprint(),
    });
    const receipt = receiptFrom(prepared);
    expect(prepared.record.status).toBe("approval_requested");
    expect((await approvals.approveConnectorApproval(receipt)).outcome).toBe("approved");

    let executions = 0;
    const first = await approvals.executeConnectorApproval(receipt, {
      revalidate: () => true,
      execute: () => {
        executions += 1;
        return "connector mutation completed";
      },
    });
    expect(first).toMatchObject({ outcome: "executed", value: "connector mutation completed" });
    expect((await approvals.executeConnectorApproval(receipt, {
      revalidate: () => true,
      execute: () => {
        executions += 1;
      },
    })).outcome).toBe("replayed");
    expect(executions).toBe(1);

    const events = await approvals.readConnectorApprovalEvents();
    expect(events.map((entry) => entry.payload.eventType))
      .toEqual(["authorized", "approval_requested", "approved", "executing", "executed"]);
    expect(Object.keys(events[0]?.payload ?? {}).sort()).toEqual([
      "approvalId",
      "authorizationFingerprint",
      "eventType",
      "installationId",
      "itemId",
      "occurredAt",
      "schemaVersion",
      "threadId",
      "turnId",
      "userId",
    ]);
  });

  it("denies tampered, cross-user, expired, and failed connector approvals", async () => {
    const { usersRoot } = await fixture();
    const approvals = store(usersRoot);
    const item = approval("connector-tamper", "thread-tamper", "turn-tamper", "item-tamper");
    const receipt = receiptFrom(await approvals.prepareConnectorApproval({
      locator: locator(item),
      authorizationFingerprint: fingerprint("a"),
    }));
    const tampered = { ...receipt, authorizationFingerprint: fingerprint("b") };
    expect((await approvals.approveConnectorApproval(tampered)).outcome).toBe("denied");
    expect(await approvals.readConnectorApproval(locator(item))).toMatchObject({ status: "denied" });

    const locatorFingerprintItem = approval("connector-locator-fingerprint", "thread-locator", "turn-locator", "item-locator");
    await approvals.prepareConnectorApproval({
      locator: locator(locatorFingerprintItem),
      authorizationFingerprint: fingerprint("f"),
    });
    expect((await approvals.approveConnectorApprovalByLocator(
      locator(locatorFingerprintItem),
      fingerprint("0"),
    )).outcome).toBe("fingerprint-mismatch");
    expect(await approvals.readConnectorApproval(locator(locatorFingerprintItem)))
      .toMatchObject({ status: "approval_requested" });

    const deniedItem = approval("connector-denied", "thread-denied", "turn-denied", "item-denied");
    await approvals.prepareConnectorApproval({
      locator: locator(deniedItem),
      authorizationFingerprint: fingerprint("9"),
    });
    expect((await approvals.denyConnectorApprovalByLocator(
      locator(deniedItem),
      fingerprint("9"),
    )).outcome).toBe("denied");
    expect((await approvals.denyConnectorApprovalByLocator(
      locator(deniedItem),
      fingerprint("9"),
    )).outcome).toBe("already-denied");
    expect((await approvals.approveConnectorApprovalByLocator(
      locator(deniedItem),
      fingerprint("9"),
    )).outcome).toBe("not-pending");
    expect(await store(usersRoot).readConnectorApproval(locator(deniedItem)))
      .toMatchObject({ status: "denied" });

    const crossUserItem = approval("connector-cross-user", "thread-cross", "turn-cross", "item-cross");
    const crossUserReceipt = receiptFrom(await approvals.prepareConnectorApproval({
      locator: locator(crossUserItem),
      authorizationFingerprint: fingerprint("c"),
    }));
    await expect(store(usersRoot, USER_B).approveConnectorApproval(crossUserReceipt))
      .rejects.toMatchObject({ code: "APPROVAL_IDENTITY_MISMATCH" });
    expect(await approvals.readConnectorApproval(locator(crossUserItem))).toMatchObject({ status: "approval_requested" });

    let clock = Date.UTC(2026, 7, 28, 12, 0, 0);
    const expiring = store(usersRoot, USER_A, () => clock);
    const expiredItem = approval("connector-expired", "thread-expired", "turn-expired", "item-expired");
    const expiredReceipt = receiptFrom(await expiring.prepareConnectorApproval({
      locator: locator(expiredItem),
      authorizationFingerprint: fingerprint("d"),
      ttlMs: 10,
    }));
    clock += 11;
    expect((await expiring.approveConnectorApproval(expiredReceipt)).outcome).toBe("not-pending");
    expect(await expiring.readConnectorApproval(locator(expiredItem))).toMatchObject({ status: "denied" });

    const staleItem = approval("connector-stale", "thread-stale", "turn-stale", "item-stale");
    const staleReceipt = receiptFrom(await approvals.prepareConnectorApproval({
      locator: locator(staleItem),
      authorizationFingerprint: fingerprint("f"),
    }));
    await approvals.approveConnectorApproval(staleReceipt);
    let staleExecuted = false;
    expect((await approvals.executeConnectorApproval(staleReceipt, {
      revalidate: () => false,
      execute: () => { staleExecuted = true; },
    })).outcome).toBe("denied");
    expect(staleExecuted).toBe(false);
    expect(await approvals.readConnectorApproval(locator(staleItem))).toMatchObject({ status: "denied" });

    const failureItem = approval("connector-failed", "thread-failed", "turn-failed", "item-failed");
    const failureReceipt = receiptFrom(await approvals.prepareConnectorApproval({
      locator: locator(failureItem),
      authorizationFingerprint: fingerprint("e"),
    }));
    await approvals.approveConnectorApproval(failureReceipt);
    expect((await approvals.executeConnectorApproval(failureReceipt, {
      revalidate: () => true,
      execute: () => { throw new Error("adapter unavailable"); },
    })).outcome).toBe("indeterminate");
    expect(await approvals.readConnectorApproval(locator(failureItem))).toMatchObject({ status: "indeterminate" });

    const revalidationItem = approval("connector-revalidation", "thread-revalidation", "turn-revalidation", "item-revalidation");
    const revalidationReceipt = receiptFrom(await approvals.prepareConnectorApproval({
      locator: locator(revalidationItem),
      authorizationFingerprint: fingerprint("a"),
    }));
    await approvals.approveConnectorApproval(revalidationReceipt);
    await expect(approvals.executeConnectorApproval(revalidationReceipt, {
      revalidate: () => { throw new Error("permission source unavailable"); },
      execute: () => { throw new Error("must not execute"); },
    })).rejects.toMatchObject({ code: "CONNECTOR_APPROVAL_REVALIDATION_FAILED" });
    expect(await approvals.readConnectorApproval(locator(revalidationItem))).toMatchObject({ status: "failed" });
  });

  it("recovers a durable executing record after restart without dispatching again", async () => {
    const { usersRoot } = await fixture();
    const firstProcess = store(usersRoot);
    const item = approval("connector-crash", "thread-crash", "turn-crash", "item-crash");
    const itemLocator = locator(item);
    await firstProcess.prepareConnectorApproval({
      locator: itemLocator,
      authorizationFingerprint: fingerprint("b"),
    });
    await firstProcess.approveConnectorApprovalByLocator(itemLocator, fingerprint("b"));

    // This is the durable state left by a process crash after marking dispatch started.
    const [recordName] = await readdir(firstProcess.connectorRecordsRoot);
    const recordPath = path.join(firstProcess.connectorRecordsRoot, recordName ?? "");
    const persisted = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    await writeFile(recordPath, `${JSON.stringify({ ...persisted, status: "executing", completedAt: null })}\n`, { mode: 0o600 });

    let restartDispatches = 0;
    const restartedProcess = store(usersRoot);
    expect((await restartedProcess.executeConnectorApprovalByLocator(itemLocator, fingerprint("b"), {
      revalidate: () => true,
      execute: () => { restartDispatches += 1; },
    })).outcome).toBe("indeterminate");
    expect(restartDispatches).toBe(0);
    expect(await restartedProcess.readConnectorApproval(itemLocator)).toMatchObject({ status: "indeterminate" });
  });

  it("dispatches at most once and rejects restart, cross-user, and fingerprint replay", async () => {
    const { usersRoot } = await fixture();
    const approvals = store(usersRoot);
    const item = approval("connector-at-most-once", "thread-once", "turn-once", "item-once");
    const itemLocator = locator(item);
    await approvals.prepareConnectorApproval({
      locator: itemLocator,
      authorizationFingerprint: fingerprint("c"),
    });
    await approvals.approveConnectorApprovalByLocator(itemLocator, fingerprint("c"));

    let dispatches = 0;
    expect((await approvals.executeConnectorApprovalByLocator(itemLocator, fingerprint("c"), {
      revalidate: () => true,
      execute: () => {
        dispatches += 1;
        throw new Error("provider outcome unavailable after dispatch");
      },
    })).outcome).toBe("indeterminate");
    expect(dispatches).toBe(1);

    const restartedProcess = store(usersRoot);
    expect((await restartedProcess.executeConnectorApprovalByLocator(itemLocator, fingerprint("c"), {
      revalidate: () => true,
      execute: () => { dispatches += 1; },
    })).outcome).toBe("indeterminate");
    expect(dispatches).toBe(1);
    await expect(store(usersRoot, USER_B).executeConnectorApprovalByLocator(itemLocator, fingerprint("c"), {
      revalidate: () => true,
      execute: () => { dispatches += 1; },
    })).rejects.toMatchObject({ code: "APPROVAL_IDENTITY_MISMATCH" });
    expect((await restartedProcess.executeConnectorApprovalByLocator(itemLocator, fingerprint("0"), {
      revalidate: () => true,
      execute: () => { dispatches += 1; },
    })).outcome).toBe("fingerprint-mismatch");
    expect(dispatches).toBe(1);
  });
});
