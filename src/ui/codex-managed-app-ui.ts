import { isApprovalItem, type ApprovalDecision, type ApprovalItem } from "@/lib/chat-contract";

const CONNECTOR_ID = "codex-managed-app";
const OPERATION = "execute-allowlisted-action";
const FINGERPRINT = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export type ManagedAppActionTarget = Readonly<{
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId: string;
}>;

export type ManagedAppActionDescriptor = Readonly<{
  operation: typeof OPERATION;
  locator: ManagedAppActionTarget;
  authorizationFingerprint: string;
  approval: ApprovalItem;
}>;

export type ManagedAppActionOutcome = "executed" | "replayed" | "indeterminate" | "denied";

export type ManagedAppActionResolution =
  | Readonly<{ state: "terminal"; outcome: ManagedAppActionOutcome; approval: ApprovalItem }>
  | Readonly<{ state: "recoverable"; stage: "approval" | "execute" | "current-thread" }>;

export function managedAppActionKey(locator: ManagedAppActionTarget) {
  return JSON.stringify([locator.threadId, locator.turnId, locator.itemId, locator.approvalId]);
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function target(value: unknown): ManagedAppActionTarget | null {
  if (!record(value) || Object.keys(value).length !== 4) return null;
  const fields = ["threadId", "turnId", "itemId", "approvalId"] as const;
  if (!fields.every((field) => typeof value[field] === "string" && OPAQUE_ID.test(value[field]))) return null;
  return value as ManagedAppActionTarget;
}

function descriptor(value: unknown): ManagedAppActionDescriptor | null {
  if (!record(value) || Object.keys(value).length !== 4 || value.operation !== OPERATION ||
      typeof value.authorizationFingerprint !== "string" || !FINGERPRINT.test(value.authorizationFingerprint)) return null;
  const locator = target(value.locator);
  if (!locator || !isApprovalItem(value.approval)) return null;
  const approval = value.approval;
  if (approval.id !== locator.approvalId || approval.threadId !== locator.threadId ||
      approval.turnId !== locator.turnId || approval.itemId !== locator.itemId || approval.status !== "pending") return null;
  return { operation: OPERATION, locator, authorizationFingerprint: value.authorizationFingerprint, approval };
}

function managedAppAvailable(value: unknown) {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.connectors)) return false;
  return value.connectors.some((connector) => record(connector) && connector.connectorId === CONNECTOR_ID &&
    connector.status === "connected" && Array.isArray(connector.effectiveOperations) &&
    connector.effectiveOperations.includes(OPERATION));
}

async function json(response: Response) {
  return response.json().catch(() => null) as Promise<unknown>;
}

function approvalResponseIsValid(value: unknown, status: "approved" | "denied") {
  return record(value) && value.ok === true && value.status === status;
}

function outcome(value: unknown): ManagedAppActionOutcome | null {
  if (!record(value) || typeof value.outcome !== "string") return null;
  return (["executed", "replayed", "indeterminate", "denied"] as const).includes(value.outcome as ManagedAppActionOutcome)
    ? value.outcome as ManagedAppActionOutcome
    : null;
}

export async function loadManagedAppCapability(fetcher: FetchLike) {
  const response = await fetcher("/api/connectors", { cache: "no-store" });
  return response.ok && managedAppAvailable(await json(response));
}

export async function prepareManagedAppAction(fetcher: FetchLike, actionTarget: ManagedAppActionTarget) {
  const response = await fetcher("/api/connectors/codex-managed-app/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "prepare", ...actionTarget }),
  });
  const body = await json(response);
  if (!response.ok || !record(body) || body.schemaVersion !== 1) return null;
  const prepared = descriptor(body.descriptor);
  return prepared && sameTarget(prepared.locator, actionTarget) ? prepared : null;
}

function sameTarget(left: ManagedAppActionTarget, right: ManagedAppActionTarget) {
  return left.threadId === right.threadId && left.turnId === right.turnId &&
    left.itemId === right.itemId && left.approvalId === right.approvalId;
}

export async function resolveManagedAppAction(
  fetcher: FetchLike,
  prepared: ManagedAppActionDescriptor,
  current: Pick<ManagedAppActionTarget, "threadId" | "turnId">,
  decision: ApprovalDecision,
): Promise<ManagedAppActionResolution> {
  if (prepared.locator.threadId !== current.threadId || prepared.locator.turnId !== current.turnId) {
    return { state: "recoverable", stage: "current-thread" };
  }
  const approvalDecision = decision === "accept" ? "accept" : "decline";
  try {
    const approvalResponse = await fetcher("/api/runtime/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...prepared.locator, authorizationFingerprint: prepared.authorizationFingerprint, decision: approvalDecision }),
    });
    if (!approvalResponse.ok || !approvalResponseIsValid(await json(approvalResponse), approvalDecision === "accept" ? "approved" : "denied")) {
      return { state: "recoverable", stage: "approval" };
    }
  } catch {
    return { state: "recoverable", stage: "approval" };
  }
  if (approvalDecision === "decline") {
    return { state: "terminal", outcome: "denied", approval: { ...prepared.approval, status: "declined" } };
  }
  try {
    const executeResponse = await fetcher("/api/connectors/codex-managed-app/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "execute", locator: prepared.locator, authorizationFingerprint: prepared.authorizationFingerprint }),
    });
    const resolvedOutcome = executeResponse.ok ? outcome(await json(executeResponse)) : null;
    if (!resolvedOutcome) return { state: "recoverable", stage: "execute" };
    return { state: "terminal", outcome: resolvedOutcome, approval: { ...prepared.approval, status: "accepted" } };
  } catch {
    return { state: "recoverable", stage: "execute" };
  }
}
