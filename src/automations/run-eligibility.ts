import type { AutomationTask } from './contracts';

/** A manual occurrence may run while its schedule remains paused or completed.
 * This admits only the exact persisted request claimed by the worker; it does
 * not grant any effect, bypass preparation, or resume the recurring schedule. */
export function automationOccurrenceStillEligible(fresh: AutomationTask, claimed: AutomationTask, runKey: string): boolean {
  if (fresh.id !== claimed.id || fresh.state !== claimed.state || fresh.preparationBlock || claimed.preparationBlock ||
    fresh.deletedAt || fresh.cancellationRequestedAt || !fresh.lease || !claimed.lease ||
    fresh.lease.scheduledFor !== claimed.lease.scheduledFor) return false;
  const request = claimed.manualRun;
  if (request) return (fresh.state === 'active' || fresh.state === 'paused' || fresh.state === 'completed') &&
    runKey === `${claimed.id}:manual:${request.requestId}` && fresh.manualRun?.requestId === request.requestId &&
    fresh.manualRun.scheduledFor === request.scheduledFor && request.scheduledFor === claimed.lease.scheduledFor;
  return fresh.state === 'active' && !fresh.manualRun && runKey === `${claimed.id}:${claimed.lease.scheduledFor}`;
}
