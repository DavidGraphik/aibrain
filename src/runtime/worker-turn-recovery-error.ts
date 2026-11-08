/** The same durable turn needs reconciliation; this is not a failed model result. */
export class WorkerTurnRecoveryPendingError extends Error {
  constructor(message = "El runtime s’ha desconnectat mentre el torn continuava actiu.") {
    super(message);
    this.name = "WorkerTurnRecoveryPendingError";
  }
}
