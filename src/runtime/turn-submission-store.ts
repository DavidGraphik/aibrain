import { validExecutionOrigin, type WorkerExecutionOrigin } from "./workers/kernel-ownership";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { UserInput } from "../../contracts/codex/0.162.1/types/v2/UserInput";
import type { ClientRequest } from "../../contracts/codex/0.162.1/types/ClientRequest";
import { atomicWriteFile, ResourceLockManager } from "@/storage";
import type { ResourceLockLease } from "@/storage/resource-lock";
import { readRegularFileWithin } from "@/security/safe-file";
import { resolveWorkerOwnedPath } from "@/runtime/workers/provisioner";
import { validateAppServerRequest } from "@/runtime/transport/wire-protocol";
import { MAX_FILES_PER_MESSAGE } from "@/lib/chat-attachment-limits";
import { randomUUID } from "node:crypto";
import { isRejectedModelAdmission, MODEL_CAPACITY_RETRY_DELAYS_MS, type CapacityModel } from "@/runtime/model-capacity-retry";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const RETRY_FIELDS = ["capacityRetries", "retryClientUserMessageId", "rejectedRuntimeTurnId", "dispatchedClientUserMessageId", "retryModel"] as const;
type Inputs = { directory: string | null; codexInputs: readonly UserInput[] };
type Phase = "preparing" | "ready" | "dispatched" | "terminal";
type Terminal = "completed" | "failed" | "interrupted";

type RecordData = {
  schemaVersion: 3;
  retryModel: CapacityModel | null;
  capacityRetries: number;
  retryClientUserMessageId: string | null;
  rejectedRuntimeTurnId: string | null;
  dispatchedClientUserMessageId: string | null;
  binding: string;
  workspace: string;
  phase: Phase;
  inputs: Inputs | null;
  inputDirectory: string | null;
  threadRequest: string | null;
  turnRequest: string | null;
  runtimeThreadId: string | null;
  runtimeTurnId: string | null;
  terminal: Terminal | null;
};

export class TurnSubmissionRecoveryRequired extends Error {
  constructor(message = "El torn pendent necessita reconciliar l’estat remot; no s’ha repetit cap petició.") {
    super(message);
    this.name = "TurnSubmissionRecoveryRequired";
  }
}

export function turnSubmissionBinding(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function nodeError(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

function serializeRecord(data: RecordData) {
  // Ordinary turns retain the previous wire format for operational rollback.
  if (data.capacityRetries > 0) return JSON.stringify(data);
  const legacy: Record<string, unknown> = { ...data, schemaVersion: 1 };
  for (const field of RETRY_FIELDS) delete legacy[field];
  return JSON.stringify(legacy);
}

function clientInputId(params: unknown) {
  return params && typeof params === "object" && "clientUserMessageId" in params &&
    typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : null;
}

function parseRecord(bytes: Buffer): RecordData {
  const value = JSON.parse(bytes.toString("utf8")) as RecordData;
  // Upgrade existing receipts without reopening their at-most-once fence.
  if (value && (value.schemaVersion as number) === 1) {
    if (RETRY_FIELDS.some(key => key in value)) {
      throw new Error("Invalid legacy durable turn submission.");
    }
    Object.assign(value, { schemaVersion: 3, retryModel: null, capacityRetries: 0, retryClientUserMessageId: null,
      rejectedRuntimeTurnId: null, dispatchedClientUserMessageId: typeof value.turnRequest === "string"
        ? clientInputId(JSON.parse(value.turnRequest).params) : null });
  }
  if (value && (value.schemaVersion as number) === 2) {
    if ("retryModel" in value) throw new Error("Invalid legacy retry model.");
    Object.assign(value, { schemaVersion: 3, retryModel: null });
  }
  if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== [
    "schemaVersion", "binding", "workspace", "phase", "inputs", "inputDirectory", "threadRequest",
    "turnRequest", "runtimeThreadId", "runtimeTurnId", "terminal", "capacityRetries", "retryClientUserMessageId", "rejectedRuntimeTurnId", "dispatchedClientUserMessageId", "retryModel",
  ].sort().join() || value.schemaVersion !== 3 || !HASH.test(value.binding) ||
      (value.retryModel !== null && (!value.retryModel || Object.keys(value.retryModel).sort().join() !== "effort,model" ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(value.retryModel.model) ||
        (value.retryModel.effort !== null && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value.retryModel.effort)))) ||
      (value.capacityRetries === 0 && value.retryModel !== null) ||
      !Number.isInteger(value.capacityRetries) || value.capacityRetries < 0 || value.capacityRetries > MODEL_CAPACITY_RETRY_DELAYS_MS.length ||
      (value.capacityRetries === 0 ? value.retryClientUserMessageId !== null || value.rejectedRuntimeTurnId !== null :
        !UUID.test(value.retryClientUserMessageId ?? "") || !value.rejectedRuntimeTurnId) ||
      typeof value.workspace !== "string" || !path.isAbsolute(value.workspace) ||
      !["preparing", "ready", "dispatched", "terminal"].includes(value.phase) ||
      (value.terminal !== null && !["completed", "failed", "interrupted"].includes(value.terminal)) ||
      (value.phase === "terminal") !== (value.terminal !== null)) {
    throw new Error("Invalid durable turn submission.");
  }
  for (const field of [value.inputDirectory, value.runtimeThreadId, value.runtimeTurnId, value.rejectedRuntimeTurnId, value.dispatchedClientUserMessageId]) {
    if (field !== null && (typeof field !== "string" || field.length === 0 || field.length > 4096)) {
      throw new Error("Invalid durable turn reference.");
    }
  }
  for (const [kind, request] of [["thread/start", value.threadRequest], ["turn/start", value.turnRequest]] as const) {
    if (request === null) continue;
    if (typeof request !== "string") throw new Error("Invalid durable request.");
    const rpc = JSON.parse(request);
    if (rpc.method !== kind || typeof rpc.id !== "string") throw new Error("Invalid durable request method.");
    validateAppServerRequest({ kind: "rpc-request", clientRequestId: rpc.id, rpc });
  }
  if (value.inputs !== null && (!value.inputs || typeof value.inputs !== "object" ||
      Object.keys(value.inputs).sort().join() !== "codexInputs,directory" ||
      value.inputs.directory !== value.inputDirectory || !Array.isArray(value.inputs.codexInputs) ||
      value.inputs.codexInputs.length > 1 || value.inputs.codexInputs.some((item) =>
        !item || item.type !== "text" || typeof item.text !== "string" ||
        !Array.isArray(item.text_elements) || item.text_elements.length !== 0))) {
    throw new Error("Invalid durable workbook inputs.");
  }
  if (value.phase === "ready" && !value.inputs) throw new Error("Missing prepared inputs.");
  return value;
}

async function privateDirectory(directory: string) {
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (!nodeError(error, "EEXIST")) throw error; }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("Unsafe turn submission directory.");
  }
}

/** App-owned state is outside every worker mount. The lease covers the whole
 * runner, not just a write, so concurrent reconnects cannot own the same turn. */
export class DurableTurnSubmission {
  private writes: Promise<void> = Promise.resolve();
  private constructor(
    readonly filePath: string,
    private data: RecordData,
    private readonly lease: ResourceLockLease,
    private persisted: boolean,
  ) {}

  static async open(input: {
    userRoot: string; installationId: string; userId: string; projectId: string;
    threadId: string; assistantMessageId: string; workspace: string; binding: string;
    recoveryOnly?: boolean; signal?: AbortSignal;
  }) {
    if (![input.userId, input.projectId, input.threadId, input.assistantMessageId].every(id => UUID.test(id)) ||
        !/^[a-z][a-z0-9-]{1,62}$/.test(input.installationId) || !HASH.test(input.binding) ||
        !path.isAbsolute(input.userRoot) || !path.isAbsolute(input.workspace)) {
      throw new Error("Invalid durable turn identity.");
    }
    const state = await resolveWorkerOwnedPath(input.userRoot, "state");
    await privateDirectory(state);
    const root = path.join(state, "turn-submissions");
    await privateDirectory(root);
    const thread = path.join(root, input.threadId);
    await privateDirectory(thread);
    const lockRoot = path.join(state, ".locks");
    await privateDirectory(lockRoot);
    const locks = new ResourceLockManager({ rootDirectory: lockRoot });
    let lease: ResourceLockLease;
    try {
      lease = await locks.acquire(`turn-submission:${input.installationId}:${input.userId}:${input.threadId}:${input.assistantMessageId}`,
        { timeoutMs: 100, signal: input.signal });
    } catch (error) {
      if (nodeError(error, "STORAGE_LOCK_TIMEOUT")) throw new TurnSubmissionRecoveryRequired();
      throw error;
    }
    const filePath = path.join(thread, `${input.assistantMessageId}.json`);
    try {
      let data: RecordData;
      let persisted = true;
      try {
        const metadata = await lstat(filePath);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
          throw new Error("Unsafe durable turn file.");
        }
        data = parseRecord(await readRegularFileWithin(thread, path.basename(filePath), MAX_RECORD_BYTES));
        if (data.binding !== input.binding || data.workspace !== input.workspace) {
          throw new Error("The durable turn does not match its authorized request.");
        }
      } catch (error) {
        if (!nodeError(error, "ENOENT")) throw error;
        data = { schemaVersion: 3, retryModel: null, capacityRetries: 0, retryClientUserMessageId: null, rejectedRuntimeTurnId: null, dispatchedClientUserMessageId: null,
          binding: input.binding, workspace: input.workspace,
          phase: input.recoveryOnly ? "dispatched" : "preparing", inputs: null, inputDirectory: null,
          threadRequest: null, turnRequest: null, runtimeThreadId: null, runtimeTurnId: null, terminal: null };
        // A reconnect can outrun the original runner before it creates its
        // receipt. Do not fence out that first runner merely because this
        // observer has no evidence yet. Legacy callers remain recovery-only;
        // persist their receipt only after finding their exact remote turn.
        persisted = !input.recoveryOnly;
        if (persisted) await atomicWriteFile(filePath, serializeRecord(data), { mode: 0o600 });
      }
      return new DurableTurnSubmission(filePath, data, lease, persisted);
    } catch (error) { await lease.release(); throw error; }
  }

  /** Backend-only recovery of an existing receipt. Takes the exact same lease
   * as the runner and never creates a receipt or dispatches model work. */
  static async reconcileExisting(input: {
    userRoot: string; installationId: string; userId: string; threadId: string; assistantMessageId: string;
  }, reconcile: (submission: DurableTurnSubmission) => Promise<void>) {
    if (![input.userId, input.threadId, input.assistantMessageId].every(id => UUID.test(id)) ||
        !/^[a-z][a-z0-9-]{1,62}$/.test(input.installationId)) throw new Error("Invalid reconciliation identity.");
    const state = await resolveWorkerOwnedPath(input.userRoot, "state");
    const directory = await resolveWorkerOwnedPath(input.userRoot, `state/turn-submissions/${input.threadId}`);
    const locks = new ResourceLockManager({ rootDirectory: path.join(state, ".locks") });
    const lease = await locks.acquire(`turn-submission:${input.installationId}:${input.userId}:${input.threadId}:${input.assistantMessageId}`,
      { timeoutMs: 100 });
    let submission: DurableTurnSubmission | undefined;
    try {
      const filePath = path.join(directory, `${input.assistantMessageId}.json`);
      const metadata = await lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
        throw new Error("Unsafe durable turn file.");
      }
      const data = parseRecord(await readRegularFileWithin(directory, path.basename(filePath), MAX_RECORD_BYTES));
      submission = new DurableTurnSubmission(filePath, data, lease, true);
      await reconcile(submission);
    } finally {
      if (submission) await submission.close();
      else await lease.release();
    }
  }

  /** Optional app-owned sidecar keeps schema-v1 receipts rollback compatible.
   * It is written before dispatch and may change only before a new model intent. */
  async bindExecutionOrigin(origin: WorkerExecutionOrigin, requestId: string) {
    if (!this.modelTurnNotDispatched || !validExecutionOrigin(origin) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) throw new TurnSubmissionRecoveryRequired();
    await this.lease.assertHeld();
    await atomicWriteFile(`${this.filePath}.origin.json`, JSON.stringify({ binding: this.data.binding, origin, requestId, runtimeTurnId: null }), { mode: 0o600 });
  }
  async executionOrigin(): Promise<WorkerExecutionOrigin | null> {
    const file = `${this.filePath}.origin.json`;
    try {
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) throw new Error("Unsafe model execution origin.");
      const value = JSON.parse((await readRegularFileWithin(path.dirname(file), path.basename(file), 4096)).toString("utf8"));
      if (!value || Object.keys(value).sort().join() !== "binding,origin,requestId,runtimeTurnId" || value.binding !== this.data.binding || !validExecutionOrigin(value.origin) ||
          typeof value.requestId !== "string" || (value.runtimeTurnId !== null && typeof value.runtimeTurnId !== "string")) throw new Error("Invalid model execution origin.");
      if (!this.data.runtimeTurnId || value.runtimeTurnId !== this.data.runtimeTurnId || !this.data.turnRequest ||
          JSON.parse(this.data.turnRequest).id !== value.requestId) return null;
      return value.origin;
    } catch (error) { if (nodeError(error, "ENOENT")) return null; throw error; }
  }

  get runtimeThreadId() { return this.data.runtimeThreadId; }
  /** The exact authorized creation intent; never reconstructed on reconnect. */
  get pendingThreadRequest(): Extract<ClientRequest, { method: "thread/start" }> | null {
    return this.data.runtimeThreadId === null && this.data.threadRequest !== null
      ? JSON.parse(this.data.threadRequest)
      : null;
  }
  /** A replacement creation retains its absent/unresponsive metadata-only
   * predecessor in the immutable request key. Restart can reconcile the old
   * UI token without weakening ordinary creation or model identity fences. */
  get replacedMissingThreadId() {
    if (!this.data.threadRequest) return null;
    const requestId = JSON.parse(this.data.threadRequest).id as string;
    return /^thread-start:[0-9a-f-]{36}:(?:missing|metadata-timeout):([A-Za-z0-9][A-Za-z0-9._:-]{0,255})$/.exec(requestId)?.[1] ?? null;
  }
  get replacementThreadReason() {
    if (!this.data.threadRequest) return null;
    const requestId = JSON.parse(this.data.threadRequest).id as string;
    return /^thread-start:[0-9a-f-]{36}:(missing|metadata-timeout):/.exec(requestId)?.[1] ?? null;
  }
  get runtimeTurnId() { return this.data.runtimeTurnId; }
  get capacityRetries() { return this.data.capacityRetries; }
  get retryModel() { return this.data.retryModel; }
  get modelTurnNotDispatched() {
    return ["preparing", "ready"].includes(this.data.phase) && this.data.turnRequest === null && this.data.runtimeTurnId === null;
  }
  get hasPendingModelTurn() { return this.data.phase === "dispatched" && this.data.terminal === null; }
  get retryClientUserMessageId() { return this.data.retryClientUserMessageId; }
  get rejectedRuntimeTurnId() { return this.data.rejectedRuntimeTurnId; }
  get needsRecovery() {
    return this.data.phase === "dispatched" || this.data.phase === "terminal" ||
      (this.data.threadRequest !== null && this.data.runtimeThreadId === null);
  }
  get threadCreationRejected() {
    return this.data.terminal === "failed" && this.data.threadRequest !== null &&
      this.data.runtimeThreadId === null && this.data.runtimeTurnId === null && this.data.turnRequest === null;
  }

  get turnRejectedBeforeSend() {
    return this.data.phase === "terminal" && this.data.terminal === "failed" && this.data.turnRequest !== null && this.data.runtimeTurnId === null;
  }

  get terminal() { return this.data.terminal; }
  get admittedWorkspace() { return this.data.workspace; }
  get cancelledBeforeDispatch() {
    return this.data.phase === "terminal" && this.data.terminal === "interrupted" &&
      this.data.threadRequest === null && this.data.turnRequest === null && this.data.runtimeTurnId === null;
  }

  /** Requires the exclusive runner lease; no age/process inference. Retain a
   * durable tombstone so a later recovery cannot submit this cancelled turn. */
  async cancelBeforeDispatch() {
    await this.lease.assertHeld();
    if (this.cancelledBeforeDispatch) return true;
    if (!this.modelTurnNotDispatched || this.data.threadRequest !== null) return false;
    await this.update((data) => {
      if (!["preparing", "ready"].includes(data.phase) || data.threadRequest !== null ||
          data.turnRequest !== null || data.runtimeTurnId !== null) {
        throw new TurnSubmissionRecoveryRequired();
      }
      return { ...data, phase: "terminal", terminal: "interrupted" };
    }, true);
    return true;
  }

  private update(change: (data: RecordData) => RecordData, writeAhead = false) {
    const operation = this.writes.then(async () => {
      await this.lease.assertHeld();
      const next = change(this.data);
      parseRecord(Buffer.from(JSON.stringify(next)));
      const bytes = Buffer.from(serializeRecord(next));
      if (bytes.length > MAX_RECORD_BYTES) throw new Error("Durable turn exceeds its bounded storage limit.");
      parseRecord(bytes);
      if (this.persisted || next.runtimeTurnId !== null) {
        try {
          await atomicWriteFile(this.filePath, bytes, { mode: 0o600 });
        } catch (error) {
          if (!writeAhead) throw error;
          // A rename may have succeeded before directory fsync failed. Fence
          // this runner too; only reopening durable state can resolve that gap.
          this.data = next;
          throw new TurnSubmissionRecoveryRequired();
        }
        this.persisted = true;
      }
      this.data = next;
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  private async assertInputDirectory(directory: string) {
    const name = path.basename(directory);
    if (!/^\.aibrain-turn-inputs-[A-Za-z0-9]+$/.test(name) || path.dirname(directory) !== this.data.workspace) {
      throw new Error("Workbook directory escaped its admitted workspace.");
    }
    const safe = await resolveWorkerOwnedPath(this.data.workspace, name);
    const metadata = await lstat(safe);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 ||
        await realpath(safe) !== path.join(await realpath(this.data.workspace), name)) {
      throw new Error("Unsafe admitted workbook directory.");
    }
  }

  async prepareInputs(prepare: (onDirectoryCreated: (directory: string) => Promise<void>) => Promise<Inputs>) {
    if (this.needsRecovery) throw new TurnSubmissionRecoveryRequired();
    if (this.data.inputs) {
      await this.validateWorkingCopies();
      return this.data.inputs;
    }
    // A crash during preparation cannot have sent this turn. Only this
    // recorded, private, unpublished directory may be discarded and rebuilt.
    await this.removeInputDirectory();
    const inputs = await prepare(async (directory) => {
      await this.assertInputDirectory(directory);
      await this.update(data => ({ ...data, inputDirectory: directory }));
    });
    await this.update(data => ({ ...data, inputs, inputDirectory: inputs.directory, phase: "ready" }));
    return inputs;
  }

  async validateWorkingCopies() {
    if (!this.data.inputDirectory) return;
    await this.assertInputDirectory(this.data.inputDirectory);
    const text = this.data.inputs?.codexInputs[0];
    if (!text || text.type !== "text") throw new Error("Missing admitted workbook manifest.");
    const files: unknown = JSON.parse(text.text.split("\n").at(-1)!);
    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES_PER_MESSAGE + 100) throw new Error("Invalid workbook manifest.");
    for (const [index, file] of files.entries()) {
      const referenceName = typeof file?.relativePath === "string" ? path.posix.basename(file.relativePath) : "";
      const reference = file?.role === "project-reference";
      const name = referenceName;
      if (reference && !new RegExp(`^reference-${index + 1}\\.(xlsx|pdf|docx|pptx|txt)$`).test(name)) throw new Error("Invalid admitted reference path.");
      if (!reference && !new RegExp(`^input-${index + 1}\\.(xlsx|pdf|png|jpg|gif|webp)$`).test(name)) throw new Error("Invalid admitted attachment path.");
      if (!file || file.relativePath !== path.posix.join(path.basename(this.data.inputDirectory), name)) {
        throw new Error("Invalid admitted workbook path.");
      }
      const metadata = await lstat(path.join(this.data.inputDirectory, name));
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
          (metadata.mode & 0o077) !== 0 || metadata.size > 50 * 1024 * 1024) {
        throw new Error("Unsafe admitted workbook copy.");
      }
      if (name.endsWith(".pdf") &&
          (!HASH.test(file.sha256 ?? "") || createHash("sha256").update(await readRegularFileWithin(this.data.inputDirectory, name, 50 * 1024 * 1024)).digest("hex") !== file.sha256)) {
        throw new Error("Admitted PDF bytes changed.");
      }
      const imageType = ({ png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as Record<string, string>)[path.extname(name).slice(1)];
      if (imageType && (file.mediaType !== imageType || file.size !== metadata.size || !HASH.test(file.sha256 ?? "") ||
          createHash("sha256").update(await readRegularFileWithin(this.data.inputDirectory, name, 50 * 1024 * 1024)).digest("hex") !== file.sha256)) {
        throw new Error("Admitted image bytes changed.");
      }
      // Workbooks are editable; original PDF/image working copies retain their
      // admitted hashes. Derived images must use separate files.
    }
  }

  async bindThread(threadId: string) {
    if (this.data.runtimeThreadId && this.data.runtimeThreadId !== threadId) throw new Error("Durable thread identity changed.");
    await this.update(data => {
      if (data.runtimeThreadId && data.runtimeThreadId !== threadId) throw new Error("Durable thread identity changed.");
      return { ...data, runtimeThreadId: threadId };
    });
  }

  async startThreadOnce(params: unknown, requestId: string) {
    if (this.data.threadRequest || this.needsRecovery) throw new TurnSubmissionRecoveryRequired();
    await this.update(data => {
      if (data.threadRequest || data.phase === "dispatched" || data.phase === "terminal") throw new TurnSubmissionRecoveryRequired();
      return { ...data, threadRequest: JSON.stringify({ method: "thread/start", id: requestId, params }) };
    }, true);
  }

  /** Only a correlated protocol rejection before creation can close this intent.
   * Retain the exact thread request as a tombstone; never reopen or replay it. */
  async rejectThreadStart(requestId: string | number, code: number) {
    if (![-32600, -32601, -32602].includes(code)) throw new TurnSubmissionRecoveryRequired();
    await this.update(data => {
      if (!data.threadRequest || JSON.parse(data.threadRequest).id !== requestId ||
          data.runtimeThreadId !== null || data.runtimeTurnId !== null || data.turnRequest !== null ||
          data.phase === "dispatched" || data.phase === "terminal") throw new TurnSubmissionRecoveryRequired();
      return { ...data, phase: "terminal", terminal: "failed", inputs: null };
    });
  }

  /** Only a typed local transport rejection before socket.send may settle this
   * exact intent without a remote turn. Retain the request as a tombstone. */
  async rejectTurnBeforeSend(requestId: string) {
    await this.update(data => {
      if (data.phase !== "dispatched" || data.runtimeTurnId !== null || !data.turnRequest ||
          JSON.parse(data.turnRequest).id !== requestId) throw new TurnSubmissionRecoveryRequired();
      return { ...data, phase: "terminal", terminal: "failed", inputs: null };
    });
  }

  async dispatchOnce(params: unknown, requestId: string) {
    if (this.data.phase !== "ready" || !this.data.runtimeThreadId) throw new TurnSubmissionRecoveryRequired();
    await this.validateWorkingCopies();
    // Write-ahead intent is an at-most-once fence, including after receipt
    // compaction at the gateway. Any failure after this write requires a read;
    // it never rolls the phase back or authorizes another model submission.
    await this.update(data => {
      if (data.phase !== "ready") throw new TurnSubmissionRecoveryRequired();
      const clientId = clientInputId(params);
      if (data.retryClientUserMessageId && clientId !== data.retryClientUserMessageId) throw new TurnSubmissionRecoveryRequired();
      if (data.retryModel && (!params || typeof params !== "object" || !("model" in params) ||
          params.model !== data.retryModel.model || ("effort" in params ? params.effort : null) !== data.retryModel.effort)) {
        throw new TurnSubmissionRecoveryRequired("The model retry does not match its durable selection.");
      }
      return { ...data, phase: "dispatched",
        dispatchedClientUserMessageId: clientId,
        turnRequest: JSON.stringify({ method: "turn/start", id: requestId, params }) };
    }, true);
  }

  async bindTurn(turnId: string) {
    if (this.data.runtimeTurnId && this.data.runtimeTurnId !== turnId) throw new Error("Durable turn identity changed.");
    await this.update(data => {
      if (data.runtimeTurnId && data.runtimeTurnId !== turnId) throw new Error("Durable turn identity changed.");
      return { ...data, runtimeTurnId: turnId };
    });
    // Bind the optional origin to both the exact write-ahead request and its
    // provider turn. A rollback's later retry cannot inherit a stale origin.
    const file = `${this.filePath}.origin.json`;
    try {
      const value = JSON.parse((await readRegularFileWithin(path.dirname(file), path.basename(file), 4096)).toString("utf8"));
      if (value.binding === this.data.binding && validExecutionOrigin(value.origin) && this.data.turnRequest &&
          value.requestId === JSON.parse(this.data.turnRequest).id && (value.runtimeTurnId === null || value.runtimeTurnId === turnId)) {
        await this.lease.assertHeld();
        await atomicWriteFile(file, JSON.stringify({ ...value, runtimeTurnId: turnId }), { mode: 0o600 });
      }
    } catch (error) { if (!nodeError(error, "ENOENT")) throw error; }
  }

  async observeTerminal(turnId: string, status: Terminal) {
    if ((this.data.runtimeTurnId && this.data.runtimeTurnId !== turnId) ||
        (this.data.terminal && this.data.terminal !== status)) throw new Error("Terminal turn identity changed.");
    await this.update(data => {
      if ((data.runtimeTurnId && data.runtimeTurnId !== turnId) ||
          (data.terminal && data.terminal !== status)) throw new Error("Terminal turn identity changed.");
      return { ...data, phase: "terminal", terminal: status, runtimeTurnId: turnId,
        threadRequest: null, turnRequest: null, inputs: null };
    });
  }

  /** Called only after a fresh, full, actor-bound read of the failed turn.
   * Persist the consumed budget and new client identity before any new RPC. */
  async retryRejectedCapacityTurn(turn: unknown, clientUserMessageId: string, retryModel: CapacityModel | null = null) {
    const eligible = (data: RecordData) => data.phase === "terminal" && data.terminal === "failed" &&
      data.runtimeTurnId !== null && data.runtimeThreadId !== null &&
      data.dispatchedClientUserMessageId === clientUserMessageId &&
      data.capacityRetries < MODEL_CAPACITY_RETRY_DELAYS_MS.length &&
      isRejectedModelAdmission(turn, data.runtimeTurnId, clientUserMessageId);
    if (!eligible(this.data)) throw new TurnSubmissionRecoveryRequired();
    await this.removeInputDirectory();
    const nextClientId = randomUUID();
    await this.update(data => {
      if (!eligible(data)) throw new TurnSubmissionRecoveryRequired();
      return { ...data, phase: "preparing", terminal: null, inputs: null, inputDirectory: null,
        turnRequest: null, runtimeTurnId: null, capacityRetries: data.capacityRetries + 1, retryModel,
        retryClientUserMessageId: nextClientId, rejectedRuntimeTurnId: data.runtimeTurnId, dispatchedClientUserMessageId: null };
    }, true);
  }

  private async removeInputDirectory() {
    if (!this.data.inputDirectory) return;
    try {
      await this.assertInputDirectory(this.data.inputDirectory);
      await rm(this.data.inputDirectory, { recursive: true, force: false });
    } catch (error) { if (!nodeError(error, "ENOENT")) throw error; }
    await this.update(data => ({ ...data, inputDirectory: null }));
  }

  async close() {
    try {
      await this.writes;
      if (this.data.phase === "terminal") await this.removeInputDirectory();
    } finally { await this.lease.release(); }
  }
}
