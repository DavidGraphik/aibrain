import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { DecidePublicationInput, FreezePublicationInput } from "@/documents/document-publisher";
import { FilePublicationCapacityGate, type PublicationCapacityGate } from "@/documents/publication-capacity";
import { PUBLICATION_UUID, PUBLICATION_REQUEST_ID, publicationPreviewSchema,
  type PublicationOperation } from "@/documents/publication-contract";
import { ensurePrivateDirectoryTree } from "@/documents/staging-store";
import { readRegularFileWithin } from "@/security/safe-file";
import { atomicWriteFile } from "@/storage/atomic-file";
import { StorageError } from "@/storage/errors";
import type { ResourceLockManager } from "@/storage/resource-lock";
import type { RemotePublicationTransport, RemoteWriteBinding, RemoteWriteReceipt } from "./publication-client";
import { g03PublicationTarget } from "./publication-target";

const MAX_BYTES = 16 * 1024 * 1024;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
function deny(code: string): never { throw new StorageError(code, "The remote publication could not be safely completed."); }
function uuid(value: string) { if (!PUBLICATION_UUID.test(value)) deny("PUBLICATION_INPUT_INVALID"); return value; }
function requestId(value: string) { if (!PUBLICATION_REQUEST_ID.test(value)) deny("PUBLICATION_INPUT_INVALID"); return value; }
function overlaps(a: string, b: string) { return a === b || b.startsWith(a + path.sep) || a.startsWith(b + path.sep); }

type Stored = {
  schemaVersion: 1; projectId: string; operation: PublicationOperation; snapshot: string;
  freezeFingerprint: string; decisionId: string | null;
  events: Array<{ status: string; at: string }>;
  remoteReceipt: RemoteWriteReceipt | null;
};
type Reservation = { userId: string; operationId: string; projectId: string; unresolved: boolean };
type Options = {
  installationId: string; userId: string; projectId: string;
  stagingRoot: string; stateRoot: string; workerVisibleRoots: string[];
  confirmationSecret: string; locks: ResourceLockManager;
  transport: RemotePublicationTransport; now?: () => number; confirmationTtlMs?: number;
  capacityGate?: PublicationCapacityGate;
};

/** Separate G03 store/transport. Never silently repoints the local publisher. */
export class G03RemoteDocumentPublisher {
  readonly #options: Options;
  readonly #now: () => number;
  readonly #capacity: PublicationCapacityGate;
  constructor(options: Options) {
    if (!/^g03(?:-[a-z0-9-]+)?$/.test(options.installationId)) deny("PUBLICATION_SCOPE_MISMATCH");
    uuid(options.userId); uuid(options.projectId);
    if (Buffer.byteLength(options.confirmationSecret) < 32 ||
        (options.confirmationTtlMs !== undefined && (!Number.isSafeInteger(options.confirmationTtlMs) || options.confirmationTtlMs < 1 || options.confirmationTtlMs > 86_400_000)) ||
        ![options.stagingRoot, options.stateRoot].every((root) => path.isAbsolute(root) && path.resolve(root) === root && root !== "/") ||
        overlaps(options.stagingRoot, options.stateRoot) || options.workerVisibleRoots.length === 0 ||
        options.workerVisibleRoots.some((root) => !path.isAbsolute(root) || overlaps(path.resolve(root), options.stateRoot))) deny("PUBLICATION_OPTIONS_INVALID");
    this.#options = options; this.#now = options.now ?? Date.now;
    this.#capacity = options.capacityGate ?? new FilePublicationCapacityGate({
      rootDirectory: path.join(options.stateRoot, "locks", "capacity"), capacityRoot: options.stateRoot,
    });
  }
  #time() { return new Date(this.#now()).toISOString(); }
  #mac(purpose: string, value: unknown) {
    return createHmac("sha256", this.#options.confirmationSecret)
      .update(JSON.stringify(["g03-remote-v1", this.#options.installationId, purpose, value])).digest("hex");
  }
  #opPath(id: string) { return `operations/${this.#options.userId}/${uuid(id)}.json`; }
  async #write(file: string, payload: unknown) {
    await ensurePrivateDirectoryTree(this.#options.stateRoot, path.posix.dirname(file).split("/"));
    await atomicWriteFile(path.join(this.#options.stateRoot, file), JSON.stringify({
      schemaVersion: 1, payload, seal: this.#mac("state:" + file, payload),
    }) + "\n", { mode: 0o600 });
  }
  async #read<T>(file: string): Promise<T> {
    const raw = await readRegularFileWithin(this.#options.stateRoot, file, 256 * 1024);
    try {
      const envelope = JSON.parse(raw.toString("utf8"));
      if (envelope.schemaVersion !== 1 || Object.keys(envelope).sort().join() !== "payload,schemaVersion,seal" ||
          typeof envelope.seal !== "string" || !/^[a-f0-9]{64}$/.test(envelope.seal) ||
          !timingSafeEqual(Buffer.from(envelope.seal), Buffer.from(this.#mac("state:" + file, envelope.payload)))) deny("PUBLICATION_STATE_CORRUPT");
      // Only this server can produce this authenticated private representation.
      return envelope.payload as T;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      deny("PUBLICATION_STATE_CORRUPT");
    }
  }
  #assertScope(stored: Stored, threadId: string, turnId: string) {
    const op = stored.operation;
    if (stored.schemaVersion !== 1 || stored.projectId !== this.#options.projectId ||
        op.installationId !== this.#options.installationId || op.userId !== this.#options.userId ||
        op.threadId !== threadId || op.turnId !== turnId) deny("PUBLICATION_SCOPE_MISMATCH");
  }
  #token(stored: Stored) {
    const op = stored.operation;
    return this.#mac("confirm", { userId: op.userId, projectId: stored.projectId, operationId: op.operationId,
      threadId: op.threadId, turnId: op.turnId, target: op.targetRelativePath, candidate: op.candidate,
      original: op.original, preview: op.preview, expiresAt: op.confirmationExpiresAt });
  }
  #binding(stored: Stored): RemoteWriteBinding {
    const op = stored.operation;
    return { path: op.targetRelativePath, operationId: op.operationId, actorId: op.userId,
      projectId: stored.projectId, sha256: op.candidate.sha256, expectedSha256: op.original.sha256,
      writeOperation: op.original.exists ? "replace" : "create" };
  }
  async #save(stored: Stored, status = stored.operation.status) {
    stored.operation = { ...stored.operation, status, updatedAt: this.#time() };
    if (stored.events.at(-1)?.status !== status) stored.events.push({ status, at: this.#time() });
    await this.#write(this.#opPath(stored.operation.operationId), stored);
  }
  async #expire(stored: Stored) {
    if (stored.operation.status === "awaiting_confirmation" && this.#now() >= Date.parse(stored.operation.confirmationExpiresAt)) await this.#save(stored, "expired");
  }
  async #releaseReservation(stored: Stored) {
    const key = `targets/${hash(decodeURIComponent(stored.operation.targetRelativePath).toLowerCase())}.json`;
    await this.#options.locks.withLock(key, async () => {
      let reservation: Reservation;
      try { reservation = await this.#read<Reservation>(key); }
      catch (error) { if (missing(error)) return; throw error; }
      if (reservation.userId === stored.operation.userId && reservation.operationId === stored.operation.operationId &&
          reservation.projectId === stored.projectId && reservation.unresolved) await this.#write(key, { ...reservation, unresolved: false });
    });
  }
  async freezeCandidate(input: FreezePublicationInput) {
    const id = uuid(input.operationId); uuid(input.threadId); uuid(input.turnId); requestId(input.clientRequestId);
    const target = g03PublicationTarget(input.targetRelativePath);
    const preview = publicationPreviewSchema.parse(input.preview);
    if (preview.threadId !== input.threadId || preview.turnId !== input.turnId ||
        !input.candidateRelativePath.startsWith(`threads/${input.threadId}/uploads/`) ||
        input.candidateRelativePath.includes("\\") || input.candidateRelativePath.split("/").some((part) => !part || part === "." || part === "..") ||
        path.posix.extname(input.candidateRelativePath).toLowerCase() !== path.posix.extname(target).toLowerCase()) deny("PUBLICATION_CANDIDATE_MISMATCH");
    const fingerprint = hash(JSON.stringify({ ...input, targetRelativePath: target, projectId: this.#options.projectId }));
    const receiptPath = `requests/${this.#options.userId}/${hash(input.clientRequestId)}.json`;
    return this.#options.locks.withLock(receiptPath, () => this.#options.locks.withLock(this.#opPath(id), async () => {
      try {
        const existing = await this.#read<Stored>(this.#opPath(id));
        this.#assertScope(existing, input.threadId, input.turnId);
        if (existing.freezeFingerprint !== fingerprint) deny("PUBLICATION_REQUEST_CONFLICT");
        await this.#expire(existing);
        return { operation: existing.operation, confirmationToken: this.#token(existing) };
      } catch (error) { if (!missing(error)) throw error; }
      try {
        const prior = await this.#read<{ fingerprint: string }>(receiptPath);
        if (prior.fingerprint !== fingerprint) deny("PUBLICATION_REQUEST_CONFLICT");
      } catch (error) { if (!missing(error)) throw error; }
      const data = await readRegularFileWithin(this.#options.stagingRoot, input.candidateRelativePath, MAX_BYTES);
      if (!data.length || hash(data) !== preview.candidateSha256) deny("PUBLICATION_CANDIDATE_MISMATCH");
      await ensurePrivateDirectoryTree(this.#options.stateRoot, ["candidates", this.#options.userId]);
      return this.#capacity.run(data.length + 64 * 1024, async () => {
      // Count candidate directories as well as completed records: an interrupted
      // freeze must not bypass admission by leaving uncounted orphan snapshots.
      const candidates = await readdir(path.join(this.#options.stateRoot, "candidates", this.#options.userId));
      if (candidates.length >= 1000 && !candidates.includes(id)) deny("PUBLICATION_CAPACITY");
      const original = await this.#options.transport.snapshot(target);
      const snapshot = `candidates/${this.#options.userId}/${id}/document${path.posix.extname(target)}`;
      await ensurePrivateDirectoryTree(this.#options.stateRoot, path.posix.dirname(snapshot).split("/"));
      await atomicWriteFile(path.join(this.#options.stateRoot, snapshot), data, { mode: 0o400 });
      const now = this.#time();
      const stored: Stored = { schemaVersion: 1, projectId: this.#options.projectId, snapshot,
        freezeFingerprint: fingerprint, decisionId: null, remoteReceipt: null,
        events: [{ status: "awaiting_confirmation", at: now }],
        operation: { schemaVersion: 1, installationId: this.#options.installationId, userId: this.#options.userId,
          operationId: id, threadId: input.threadId, turnId: input.turnId, targetRelativePath: target,
          candidate: { fileName: path.posix.basename(input.candidateRelativePath), size: data.length, sha256: hash(data) },
          preview, original, status: "awaiting_confirmation", version: null, result: null,
          confirmationExpiresAt: new Date(this.#now() + (this.#options.confirmationTtlMs ?? 15 * 60_000)).toISOString(),
          createdAt: now, updatedAt: now } };
      await this.#write(receiptPath, { fingerprint });
      await this.#save(stored);
      return { operation: stored.operation, confirmationToken: this.#token(stored) };
      });
    }));
  }
  confirm(input: DecidePublicationInput) { return this.#decide(input, "confirm"); }
  decline(input: DecidePublicationInput) { return this.#decide(input, "decline"); }
  async #decide(input: DecidePublicationInput, action: "confirm" | "decline") {
    const id = uuid(input.operationId); uuid(input.threadId); uuid(input.turnId); requestId(input.clientRequestId);
    return this.#options.locks.withLock(this.#opPath(id), async () => {
      const stored = await this.#read<Stored>(this.#opPath(id));
      this.#assertScope(stored, input.threadId, input.turnId);
      const token = this.#token(stored);
      if (typeof input.confirmationToken !== "string" || !/^[a-f0-9]{64}$/.test(input.confirmationToken) ||
          !timingSafeEqual(Buffer.from(input.confirmationToken), Buffer.from(token))) deny("PUBLICATION_TOKEN_INVALID");
      await this.#expire(stored);
      const op = stored.operation;
      if (op.status === "expired") { if (action === "decline") return op; deny("PUBLICATION_TOKEN_EXPIRED"); }
      if (["published", "conflict", "declined"].includes(op.status)) {
        if ((action === "decline") !== (op.status === "declined")) deny("PUBLICATION_ALREADY_DECIDED");
        if (op.status !== "declined") await this.#releaseReservation(stored);
        return op;
      }
      if (action === "decline") {
        if (op.status !== "awaiting_confirmation") deny("PUBLICATION_REMOTE_UNCERTAIN");
        stored.decisionId = input.clientRequestId; await this.#save(stored, "declined"); return stored.operation;
      }
      const targetKey = hash(decodeURIComponent(op.targetRelativePath).toLowerCase());
      const reservationPath = `targets/${targetKey}.json`;
      return this.#options.locks.withLock(reservationPath, async () => {
        let reserved: Reservation | null = null;
        try { reserved = await this.#read<Reservation>(reservationPath); }
        catch (error) { if (!missing(error)) throw error; }
        if (reserved?.unresolved && (reserved.userId !== op.userId || reserved.operationId !== id || reserved.projectId !== stored.projectId)) deny("PUBLICATION_REMOTE_UNCERTAIN");
        const recovering = op.status === "publishing" || reserved?.unresolved === true;
        const reservation: Reservation = { userId: op.userId, operationId: id, projectId: stored.projectId, unresolved: true };
        let receipt: RemoteWriteReceipt;
        if (recovering) {
          // No re-dispatch, even if the prior process died immediately before send.
          // An ambiguous not_found requires explicit operator reconciliation.
          receipt = await this.#options.transport.receipt(this.#binding(stored));
        } else {
          const candidate = await readRegularFileWithin(this.#options.stateRoot, stored.snapshot, MAX_BYTES);
          if (candidate.length !== op.candidate.size || hash(candidate) !== op.candidate.sha256) deny("PUBLICATION_STATE_CORRUPT");
          await this.#write(reservationPath, reservation);
          stored.decisionId = input.clientRequestId; await this.#save(stored, "publishing");
          try { receipt = await this.#options.transport.publish(this.#binding(stored), candidate); }
          catch (error) {
            if (!(error instanceof StorageError && error.code === "PUBLICATION_ORIGINAL_CONFLICT")) throw error;
            receipt = await this.#options.transport.receipt(this.#binding(stored));
          }
        }
        stored.remoteReceipt = receipt;
        if (receipt.status === "not_found") { await this.#save(stored, "publishing"); deny("PUBLICATION_REMOTE_UNCERTAIN"); }
        if (receipt.status === "rejected" || receipt.status === "restored") {
          await this.#save(stored, "conflict");
        } else {
          const now = this.#time();
          stored.operation.version = op.original.exists ? { size: op.original.size!, sha256: op.original.sha256!, createdAt: receipt.checkedAt } : null;
          stored.operation.result = { size: op.candidate.size, sha256: receipt.sha256, publishedAt: now,
            recoveredAfterInterruption: recovering || receipt.status === "already_committed" };
          await this.#save(stored, "published");
        }
        await this.#write(reservationPath, { ...reservation, unresolved: false });
        return stored.operation;
      });
    });
  }
  async recoverThread(threadId: string) {
    uuid(threadId);
    const directory = `operations/${this.#options.userId}`;
    await ensurePrivateDirectoryTree(this.#options.stateRoot, directory.split("/"));
    const names = await readdir(path.join(this.#options.stateRoot, directory));
    if (names.length > 1000) deny("PUBLICATION_CAPACITY");
    const result = [];
    for (const name of names) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const value = await this.#options.locks.withLock(`${directory}/${name}`, async () => {
        const stored = await this.#read<Stored>(`${directory}/${name}`);
        if (stored.projectId !== this.#options.projectId || stored.operation.threadId !== threadId) return null;
        this.#assertScope(stored, threadId, stored.operation.turnId);
        await this.#expire(stored);
        return { operation: stored.operation, confirmationToken: this.#token(stored) };
      });
      if (value) result.push(value);
    }
    return result;
  }
}
