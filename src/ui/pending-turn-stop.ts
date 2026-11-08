import type { ChatMessage } from "@/lib/chat-contract";
import { isWorkbenchThread } from "@/workbench/types";

export function stopControlAccepted(value: unknown) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    "ok" in value && value.ok === true && "action" in value && value.action === "stop" &&
    "idempotent" in value && typeof value.idempotent === "boolean");
}

/** One read-only, bounded reconciliation; never treats a control receipt as terminal. */
export async function readTurnTerminalAfterStop(identity: {
  threadId: string; projectId: string; assistantMessageId: string;
}): Promise<ChatMessage | null> {
  try {
    const response = await fetch(`/api/threads/${encodeURIComponent(identity.threadId)}`, {
      method: "GET", cache: "no-store", signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    const thread = payload && typeof payload === "object" && "thread" in payload ? payload.thread : null;
    if (!isWorkbenchThread(thread) || thread.id !== identity.threadId || thread.projectId !== identity.projectId) return null;
    const message = thread.messages.find(candidate => candidate.id === identity.assistantMessageId && candidate.role === "assistant");
    return message && message.status !== "streaming" ? message : null;
  } catch {
    // Missing, unauthorized, unavailable and still-running snapshots do not
    // establish success. The caller keeps the original control error visible.
    return null;
  }
}

/** Client intent only. Only a server stream/snapshot can establish a terminal result. */
export class PendingTurnStop {
  private accepted = false;
  private requested = false;
  private controlAccepted = false;
  private followup = false;
  private flight: Promise<void> | null = null;
  private disposed = false;
  private terminal = false;

  constructor(private readonly options: {
    sendControl: (context: { admissionConfirmed: boolean }) => Promise<boolean>;
    onPause: () => void;
    onBusy: (busy: boolean) => void;
  }) {}

  get retriesPaused() { return this.requested && !this.accepted && !this.terminal; }
  get terminalObserved() { return this.terminal; }

  requestStop() {
    if (this.disposed || this.terminal) return Promise.resolve();
    this.requested = true;
    if (!this.accepted) this.options.onPause();
    return this.dispatch();
  }

  confirmAdmission() {
    if (this.disposed || this.terminal || this.accepted) return;
    this.accepted = true;
    if (!this.requested || this.controlAccepted) return;
    if (this.flight) this.followup = true;
    else void this.dispatch();
  }

  observeTerminal() { this.terminal = true; this.followup = false; }
  dispose() { this.disposed = true; this.followup = false; }

  private dispatch(): Promise<void> {
    if (this.flight) return this.flight;
    this.options.onBusy(true);
    this.flight = Promise.resolve().then(() => this.disposed || this.terminal ? false : this.options.sendControl({ admissionConfirmed: this.accepted })).then(
      accepted => { if (!this.disposed) this.controlAccepted = accepted; },
      () => { /* Unavailable control is not a stopped turn. The UI sender reports it. */ },
    ).finally(() => {
      this.flight = null;
      if (this.disposed) return;
      this.options.onBusy(false);
      if (this.followup) {
        this.followup = false;
        if (!this.terminal && !this.controlAccepted) void this.dispatch();
      }
    });
    return this.flight;
  }
}
