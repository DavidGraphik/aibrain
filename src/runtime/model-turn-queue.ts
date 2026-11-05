import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicWriteFile, ResourceLockManager } from "@/storage";
import { readRegularFileWithin } from "@/security/safe-file";

export type ModelQueueTicket = { key: string; owner: string; state: "waiting" | "running"; seenAt: number };
type QueueState = { schemaVersion: 1; tickets: ModelQueueTicket[] };
export type ModelQueueReconciler = (ticket: Readonly<ModelQueueTicket>, release: () => Promise<void>) => Promise<void>;
export class BackgroundModelAdmissionDeferred extends Error {
  constructor() { super("AUTOMATION_MODEL_ADMISSION_DEFERRED"); this.name="BackgroundModelAdmissionDeferred"; }
}
export const backgroundModelConcurrency = (maximum:number) => Math.max(1,maximum-1);
type ExecutionClass = "foreground" | "background";
type ExecutionClasses = Record<string,ExecutionClass>;
export type ModelTurnAdmission = { complete(): Promise<void> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function integer(value: string | number | undefined, fallback: number, maximum: number) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error("Invalid model queue configuration.");
  return parsed;
}

/** Shared by app and automation processes. Waiting tickets expire; admitted
 * tickets never expire automatically because the provider may still be working.
 * Recovery requires the same durable turn or authoritative terminal evidence
 * under its exclusive runner lease. */
export class FileModelTurnQueue {
  private readonly locks: ResourceLockManager;
  private readonly maxConcurrent: number;
  private readonly maxWaiting: number;
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly staleWaitingMs: number;
  constructor(private readonly root: string, options: {
    maxConcurrent?: number; maxWaiting?: number; waitMs?: number; pollMs?: number; staleWaitingMs?: number;
  } = {}) {
    if (!path.isAbsolute(root) || root === path.parse(root).root) throw new Error("Invalid model queue root.");
    this.maxConcurrent = integer(options.maxConcurrent ?? process.env.AIBRAIN_MODEL_MAX_CONCURRENT, 2, 32);
    this.maxWaiting = integer(options.maxWaiting ?? process.env.AIBRAIN_MODEL_MAX_WAITING, 50, 200);
    this.waitMs = integer(options.waitMs ?? process.env.AIBRAIN_MODEL_QUEUE_WAIT_MS, 300_000, 3_600_000);
    this.pollMs = integer(options.pollMs, 1_000, 10_000);
    this.staleWaitingMs = integer(options.staleWaitingMs, 30_000, 300_000);
    this.locks = new ResourceLockManager({ rootDirectory: path.join(root, "locks") });
  }

  private async change<T>(operation: (state: QueueState, classes: ExecutionClasses) => T): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Unsafe model queue root.");
    const lease = await this.locks.acquire("model-turn-queue", { timeoutMs: 10_000 });
    try {
      let state: QueueState;
      try {
        const file = await lstat(path.join(this.root, "queue.json"));
        if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o077) !== 0) throw new Error("Unsafe model queue state.");
        state = JSON.parse((await readRegularFileWithin(this.root, "queue.json", 1_048_576)).toString("utf8"));
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        state = { schemaVersion: 1, tickets: [] };
      }
      if (!state || state.schemaVersion !== 1 || Object.keys(state).sort().join() !== "schemaVersion,tickets" ||
          !Array.isArray(state.tickets) || state.tickets.length > 4096 || state.tickets.some(ticket =>
            !ticket || Object.keys(ticket).sort().join() !== "key,owner,seenAt,state" ||
            !/^[a-f0-9]{64}$/.test(ticket.key) || !UUID.test(ticket.owner) ||
            !["waiting", "running"].includes(ticket.state) || !Number.isSafeInteger(ticket.seenAt) || ticket.seenAt < 0) ||
          new Set(state.tickets.map(ticket => ticket.key)).size !== state.tickets.length) throw new Error("Invalid model queue state.");
      // Keep queue.json byte-schema compatible with rollback readers. They
      // ignore this separate ephemeral sidecar and retain all running tickets.
      let classes:ExecutionClasses={};
      try {
        const metadata=await lstat(path.join(this.root,"execution-classes.json"));
        if (!metadata.isFile()||metadata.isSymbolicLink()||metadata.nlink!==1||(metadata.mode&0o077)!==0) throw Error("Unsafe queue execution classes.");
        const sidecar=JSON.parse((await readRegularFileWithin(this.root,"execution-classes.json",1_048_576)).toString("utf8"));
        if (!sidecar||Object.keys(sidecar).sort().join()!=="classes,schemaVersion"||sidecar.schemaVersion!==1||!sidecar.classes||typeof sidecar.classes!=="object"||Array.isArray(sidecar.classes)||Object.keys(sidecar.classes).length>4096||Object.entries(sidecar.classes).some(([key,value])=>!/^([a-f0-9]{64})$/.test(key)||!["foreground","background"].includes(String(value)))) throw Error("Invalid queue execution classes.");
        classes=sidecar.classes;
      } catch(error) { if (!(error&&typeof error==="object"&&"code" in error&&error.code==="ENOENT")) throw error; }
      const beforeClasses=JSON.stringify(classes);
      const before = JSON.stringify(state);
      const result = operation(state,classes);
      const retained=new Set(state.tickets.map(ticket=>ticket.key));
      for (const key of Object.keys(classes)) if(!retained.has(key))delete classes[key];
      if(beforeClasses!==JSON.stringify(classes)){
        await lease.assertHeld();
        await atomicWriteFile(path.join(this.root,"execution-classes.json"),JSON.stringify({schemaVersion:1,classes}),{mode:0o600});
      }
      const after = JSON.stringify(state);
      if (before !== after) {
        await lease.assertHeld();
        await atomicWriteFile(path.join(this.root, "queue.json"), after, { mode: 0o600 });
      }
      return result;
    } finally { await lease.release(); }
  }

  /** The observer holds the durable submission lease until release finishes.
   * Never infer completion from age, a dead process, or a missing remote turn. */
  async reconcileRunning(reconcile: ModelQueueReconciler) {
    const tickets = await this.change(state => state.tickets.filter(ticket => ticket.state === "running").map(ticket => ({ ...ticket })));
    let released = 0;
    for (const ticket of tickets.slice(0, 32)) {
      await reconcile(Object.freeze(ticket), async () => {
        const removed = await this.change(state => {
          const before = state.tickets.length;
          state.tickets = state.tickets.filter(current => current.key !== ticket.key || current.owner !== ticket.owner || current.state !== "running");
          return state.tickets.length < before;
        });
        if (removed) released += 1;
      });
    }
    return released;
  }

  /** Advisory only: no ticket/authority is created. Actual acquire still
   * fences model dispatch, including races after this preflight. */
  async backgroundCapacityAvailable(): Promise<boolean> {
    return this.change((state, classes) => {
      const running = state.tickets.filter(ticket => ticket.state === "running");
      return running.length < this.maxConcurrent &&
        running.filter(ticket => classes[ticket.key] !== "foreground").length < backgroundModelConcurrency(this.maxConcurrent) &&
        !state.tickets.some(ticket => ticket.state === "waiting" && Date.now() - ticket.seenAt < this.staleWaitingMs);
    });
  }

  async acquire(identity: { installationId: string; userId: string; threadId: string; turnId: string }, options: {
    signal: AbortSignal; recovering: boolean; onWaiting(position: number): Promise<void>;
    /** Server-authenticated execution mode, never tool/model input. */
    backgroundExecution?: boolean;
    reconcileRunning?: ModelQueueReconciler;
  }): Promise<ModelTurnAdmission> {
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(identity.installationId) ||
        [identity.userId, identity.threadId, identity.turnId].some(id => !UUID.test(id))) throw new Error("Invalid queue identity.");
    const key = createHash("sha256").update(JSON.stringify([identity.installationId, identity.userId, identity.threadId, identity.turnId])).digest("hex");
    const owner = randomUUID();
    const started = Date.now();
    let position = -1;
    let lastReconciliation = 0;
    let backgroundReconciled = false;
    const complete = async () => {
      await this.change(state => { state.tickets = state.tickets.filter(ticket => ticket.key !== key || ticket.owner !== owner); });
    };
    try {
      for (;;) {
        if (options.signal.aborted) throw options.signal.reason ?? new Error("Queue wait cancelled.");
        if (Date.now() - started >= this.waitMs) throw new Error("La petición ha esperado demasiado en la cola. La conversación y los adjuntos se conservan; vuelve a intentarlo en unos minutos.");
        const observed = await this.change((state,classes) => {
          const now = Date.now();
          state.tickets = state.tickets.filter(ticket => ticket.state === "running" || ticket.key === key || now - ticket.seenAt < this.staleWaitingMs);
          let ticket = state.tickets.find(value => value.key === key);
          if (!ticket) {
            if (!options.recovering && state.tickets.filter(value => value.state === "waiting").length >= this.maxWaiting) {
              if(options.backgroundExecution)throw new BackgroundModelAdmissionDeferred();
              throw new Error("Hay demasiadas peticiones en espera. La conversación y los adjuntos se conservan; vuelve a intentarlo en unos minutos.");
            }
            ticket = { key, owner, state: options.recovering ? "running" : "waiting", seenAt: now };
            state.tickets.push(ticket);
            classes[key]=options.backgroundExecution?"background":"foreground";
          }
          if(ticket.state==="waiting"&&!classes[key])classes[key]=options.backgroundExecution?"background":"foreground";
          if (ticket.state==="waiting" && classes[key] && classes[key] !== (options.backgroundExecution?"background":"foreground")) throw Error("Queue execution class changed.");
          ticket.owner = owner;
          if (now - ticket.seenAt >= Math.min(5_000, this.staleWaitingMs / 2)) ticket.seenAt = now;
          const waiting = state.tickets.filter(value => value.state === "waiting");
          const running=state.tickets.filter(value=>value.state==="running");
          // Unknown legacy reservations consume the background budget too;
          // uncertainty never grants an extra slot or evicts existing work.
          const backgroundAvailable=running.filter(value=>classes[value.key]!=="foreground").length < backgroundModelConcurrency(this.maxConcurrent);
          const foreground=waiting.find(value=>classes[value.key]==="foreground");
          const eligible=foreground??(backgroundAvailable?waiting[0]:undefined);
          if (ticket.state === "waiting" && eligible === ticket && running.length < this.maxConcurrent) ticket.state="running";
          return ticket.state === "running" ? 0 : waiting.filter(value=>classes[value.key]==="foreground"||value===ticket).indexOf(ticket)+1;
        });
        if (observed === 0) return { complete };
        // A background claim must return to the durable scheduler, not spend
        // the five-minute human wait or consume a failed execution attempt.
        if (options.backgroundExecution && !options.recovering) {
          // A legacy reservation can consume the only background slot after a
          // restart. Probe once OUTSIDE the queue lock before durable deferral;
          // re-observe admission only after the authoritative reconciler really
          // removed the exact snapshotted owner. Live/unknown work stays held.
          if (!backgroundReconciled && options.reconcileRunning) {
            backgroundReconciled = true;
            const released = await this.reconcileRunning(options.reconcileRunning);
            if (released > 0 && Date.now() - started < this.waitMs) continue;
          }
          throw new BackgroundModelAdmissionDeferred();
        }
        if (position !== observed) { position = observed; await options.onWaiting(position); }
        // Only the first waiter probes; provider reads occur outside the queue
        // lock and are throttled independently of the polling heartbeat.
        if (observed === 1 && options.reconcileRunning && Date.now() - lastReconciliation >= 30_000) {
          lastReconciliation = Date.now();
          await this.reconcileRunning(options.reconcileRunning);
        }
        await delay(this.pollMs, undefined, { signal: options.signal });
      }
    } catch (error) {
      // No model dispatch can occur until acquire has returned its receipt.
      await complete();
      throw error;
    }
  }
}
