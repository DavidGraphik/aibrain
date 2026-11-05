import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  applyChatStreamEvent,
  isChatMessage,
  isChatStreamEvent,
  type ChatMessage,
  type ChatStreamEvent,
} from "@/lib/chat-contract";
import { readThreadTokenContext } from "@/runtime/thread-token";
import type { AppServerEvent } from "@/runtime/transport";
import {
  atomicWriteJson,
  defineVersionedSchema,
  expectArray,
  expectInteger,
  expectIsoDate,
  expectString,
  readValidatedJson,
  ResourceLockManager,
  type ValidationContext,
} from "@/storage";
import { WorkbenchPersistenceError } from "@/workbench/errors";
import { isUuid } from "@/workbench/types";

const INSTALLATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PROJECTION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const MAX_PROJECTION_BYTES = 64 * 1024 * 1024;
// A single completed tool item can supply 100 sources plus its result and
// activity events. Keep the cursor bounded without rejecting that fan-out.
const MAX_KEYS_PER_TRANSPORT_EVENT = 128;

export type TurnProjection = {
  schemaVersion: 1;
  installationId: string;
  userId: string;
  threadId: string;
  assistantMessageId: string;
  lastTransportSequence: number;
  lastTransportEventId: string | null;
  appliedKeysAtLastSequence: string[];
  localRevision: number;
  runtimeThreadToken: string | null;
  runtimeTurnId: string | null;
  message: ChatMessage;
  createdAt: string;
  updatedAt: string;
};

export type TurnProjectionTransportEvent = {
  envelope: AppServerEvent;
  projectionKey: string;
  event: ChatStreamEvent;
};

function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error &&
    (code === undefined || (error as NodeJS.ErrnoException).code === code));
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function nullableSafeString(
  value: unknown,
  context: ValidationContext,
  maximum: number,
  pattern?: RegExp,
) {
  return value === null ? null : expectString(value, context, {
    minLength: 1,
    maxLength: maximum,
    ...(pattern ? { pattern } : {}),
  });
}

function parseMessage(value: unknown, context: ValidationContext) {
  if (!isChatMessage(value) || !isUuid(value.id) || value.role !== "assistant") {
    context.fail("expected a valid assistant message");
  }
  const parsed = new Date(value.createdAt);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value.createdAt) {
    context.at("createdAt").fail("expected a canonical ISO timestamp");
  }
  return value;
}

const turnProjectionSchema = defineVersionedSchema<TurnProjection>({
  name: "TurnProjection",
  schemaVersion: 1,
  keys: [
    "installationId",
    "userId",
    "threadId",
    "assistantMessageId",
    "lastTransportSequence",
    "lastTransportEventId",
    "appliedKeysAtLastSequence",
    "localRevision",
    "runtimeThreadToken",
    "runtimeTurnId",
    "message",
    "createdAt",
    "updatedAt",
  ],
  parse(record, context) {
    const projection: TurnProjection = {
      schemaVersion: 1,
      installationId: expectString(record.installationId, context.at("installationId"), {
        minLength: 2,
        maxLength: 63,
        pattern: INSTALLATION_ID_PATTERN,
      }),
      userId: expectString(record.userId, context.at("userId"), {
        minLength: 36,
        maxLength: 36,
        pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      }),
      threadId: expectString(record.threadId, context.at("threadId"), {
        minLength: 36,
        maxLength: 36,
        pattern: /^[0-9a-f-]{36}$/,
      }),
      assistantMessageId: expectString(record.assistantMessageId, context.at("assistantMessageId"), {
        minLength: 36,
        maxLength: 36,
        pattern: /^[0-9a-f-]{36}$/,
      }),
      lastTransportSequence: expectInteger(
        record.lastTransportSequence,
        context.at("lastTransportSequence"),
        { minimum: 0 },
      ),
      lastTransportEventId: nullableSafeString(
        record.lastTransportEventId,
        context.at("lastTransportEventId"),
        256,
        EVENT_ID_PATTERN,
      ),
      appliedKeysAtLastSequence: expectArray(
        record.appliedKeysAtLastSequence,
        context.at("appliedKeysAtLastSequence"),
        (item, itemContext) => expectString(item, itemContext, {
          minLength: 1,
          maxLength: 512,
          pattern: PROJECTION_KEY_PATTERN,
        }),
        { maxLength: MAX_KEYS_PER_TRANSPORT_EVENT },
      ),
      localRevision: expectInteger(record.localRevision, context.at("localRevision"), { minimum: 0 }),
      runtimeThreadToken: nullableSafeString(record.runtimeThreadToken, context.at("runtimeThreadToken"), 2_048),
      runtimeTurnId: nullableSafeString(
        record.runtimeTurnId,
        context.at("runtimeTurnId"),
        256,
        EVENT_ID_PATTERN,
      ),
      message: parseMessage(record.message, context.at("message")),
      createdAt: expectIsoDate(record.createdAt, context.at("createdAt")),
      updatedAt: expectIsoDate(record.updatedAt, context.at("updatedAt")),
    };
    if (projection.message.id !== projection.assistantMessageId) {
      context.at("message.id").fail("must match assistantMessageId");
    }
    if ((projection.lastTransportSequence === 0) !== (projection.lastTransportEventId === null)) {
      context.at("lastTransportEventId").fail("must be null only before the first transport event");
    }
    if (new Set(projection.appliedKeysAtLastSequence).size !== projection.appliedKeysAtLastSequence.length) {
      context.at("appliedKeysAtLastSequence").fail("must contain unique keys");
    }
    if (projection.updatedAt < projection.createdAt) {
      context.at("updatedAt").fail("must not precede createdAt");
    }
    return projection;
  },
});

export function isUnboundTurnBefore(projection: TurnProjection, restartedAt: string, preparedSourceName?: string) {
  const cutoff = Date.parse(restartedAt);
  const message = projection.message;
  const preparedSources = (message.sources ?? []).every(source =>
    preparedSourceName !== undefined && source.kind === "file" && source.title === preparedSourceName &&
    source.id.startsWith("source-file-") && isUuid(source.id.slice("source-file-".length)) &&
    source.url === null && source.domain === null && source.publishedAt === null);
  return Number.isFinite(cutoff) && cutoff <= Date.now() && Date.parse(projection.updatedAt) < cutoff &&
    projection.runtimeThreadToken === null && projection.runtimeTurnId === null && projection.lastTransportSequence === 0 &&
    message.status === "streaming" && message.content === "" && !message.approvals.length && !message.artifacts.length &&
    !message.attachments.length && !message.diff && !message.toolResults?.length && preparedSources && !message.plan.length &&
    message.activity.every(item => item.kind === "system" && item.id.startsWith("runtime-"));
}

export class FileTurnProjectionStore {
  readonly installationId: string;
  readonly userId: string;
  readonly usersRoot: string;
  readonly userRoot: string;
  readonly projectionRoot: string;
  readonly lockRoot: string;
  private readonly locks: ResourceLockManager;

  constructor(options: { installationId: string; userId: string; usersRoot: string }) {
    if (!INSTALLATION_ID_PATTERN.test(options.installationId) || !isUuid(options.userId) ||
        !path.isAbsolute(options.usersRoot)) {
      throw new WorkbenchPersistenceError("La identitat del projection store no és vàlida.");
    }
    this.installationId = options.installationId;
    this.userId = options.userId;
    this.usersRoot = path.resolve(options.usersRoot);
    this.userRoot = path.resolve(this.usersRoot, options.userId);
    if (this.userRoot === this.usersRoot || !inside(this.usersRoot, this.userRoot)) {
      throw new WorkbenchPersistenceError("La ruta de projeccions surt de usersRoot.");
    }
    this.projectionRoot = path.join(this.userRoot, "state", "turn-projections");
    this.lockRoot = path.join(this.userRoot, "state", ".locks");
    this.locks = new ResourceLockManager({ rootDirectory: this.lockRoot });
  }

  private identity(threadId: string, assistantMessageId: string) {
    if (!isUuid(threadId) || !isUuid(assistantMessageId)) {
      throw new WorkbenchPersistenceError("La identitat de projecció no és vàlida.");
    }
    const threadRoot = path.join(this.projectionRoot, threadId);
    return {
      threadId,
      assistantMessageId,
      threadRoot,
      filePath: path.join(threadRoot, `${assistantMessageId}.json`),
      lockKey: `turn-projection:${this.installationId}:${this.userId}:${threadId}:${assistantMessageId}`,
    };
  }

  private async assertDirectory(directory: string) {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
      throw new WorkbenchPersistenceError("El directori de projeccions no és segur.");
    }
  }

  private async prepare(threadId: string, assistantMessageId: string) {
    const identity = this.identity(threadId, assistantMessageId);
    await this.assertDirectory(this.userRoot);
    for (const directory of [path.join(this.userRoot, "state"), this.projectionRoot, identity.threadRoot, this.lockRoot]) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
      await this.assertDirectory(directory);
      await chmod(directory, 0o700);
    }
    const [canonicalUser, canonicalProjection, canonicalThread] = await Promise.all([
      realpath(this.userRoot),
      realpath(this.projectionRoot),
      realpath(identity.threadRoot),
    ]);
    if (!inside(canonicalUser, canonicalProjection) || !inside(canonicalProjection, canonicalThread)) {
      throw new WorkbenchPersistenceError("La projecció resol fora de l’usuari.");
    }
    return identity;
  }

  private async readUnlocked(filePath: string) {
    try {
      const metadata = await lstat(filePath);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 ||
          metadata.size > MAX_PROJECTION_BYTES || (metadata.mode & 0o077) !== 0) {
        throw new WorkbenchPersistenceError("El fitxer de projecció no és segur.");
      }
      return await readValidatedJson(filePath, turnProjectionSchema);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
  }

  private assertBinding(projection: TurnProjection, threadId: string, assistantMessageId: string) {
    if (projection.installationId !== this.installationId || projection.userId !== this.userId ||
        projection.threadId !== threadId || projection.assistantMessageId !== assistantMessageId) {
      throw new WorkbenchPersistenceError("La projecció no pertany a aquest torn.");
    }
  }

  private async write(filePath: string, projection: TurnProjection) {
    if (Buffer.byteLength(JSON.stringify(projection), "utf8") > MAX_PROJECTION_BYTES) {
      throw new WorkbenchPersistenceError("La projecció supera el límit operatiu segur.");
    }
    await atomicWriteJson(filePath, projection, turnProjectionSchema, { mode: 0o600 });
  }

  private assertSnapshotBinding(event: ChatStreamEvent, message: ChatMessage) {
    // These immutable fields cannot be laundered by a later valid snapshot.
    // Structural validation already ran; no extra full-transcript scan here.
    if (event.type === "snapshot" && (event.message.id !== message.id ||
        event.message.role !== "assistant" || event.message.createdAt !== message.createdAt)) {
      throw new WorkbenchPersistenceError("El snapshot no pertany al missatge original.");
    }
  }

  async initialize(threadId: string, message: ChatMessage) {
    const identity = await this.prepare(threadId, message.id);
    return this.locks.withLock(identity.lockKey, async () => {
      const existing = await this.readUnlocked(identity.filePath);
      if (existing) {
        this.assertBinding(existing, threadId, message.id);
        return existing;
      }
      if (!isChatMessage(message) || message.role !== "assistant" || !isUuid(message.id)) {
        throw new WorkbenchPersistenceError("El missatge inicial de projecció no és vàlid.");
      }
      const now = new Date().toISOString();
      const projection = turnProjectionSchema.parse({
        schemaVersion: 1,
        installationId: this.installationId,
        userId: this.userId,
        threadId,
        assistantMessageId: message.id,
        lastTransportSequence: 0,
        lastTransportEventId: null,
        appliedKeysAtLastSequence: [],
        localRevision: 0,
        runtimeThreadToken: null,
        runtimeTurnId: null,
        message,
        createdAt: now,
        updatedAt: now,
      });
      await this.write(identity.filePath, projection);
      return projection;
    });
  }

  async read(threadId: string, assistantMessageId: string) {
    const identity = await this.prepare(threadId, assistantMessageId);
    // Projection writes use atomic replacement, so readers always observe a
    // complete snapshot without joining the writer's per-turn lock queue.
    const projection = await this.readUnlocked(identity.filePath);
    if (projection) this.assertBinding(projection, threadId, assistantMessageId);
    return projection;
  }

  async applyTransportEvent(
    threadId: string,
    assistantMessageId: string,
    envelope: AppServerEvent,
    projectionKey: string,
    event: ChatStreamEvent,
  ) {
    const result = await this.applyTransportEvents(threadId, assistantMessageId, [{
      envelope,
      projectionKey,
      event,
    }]);
    return { projection: result.projection, applied: result.applied[0] ?? false };
  }

  /**
   * Applies a short ordered transport batch with one lock/read/atomic-write.
   * The transport journal remains the durable source for replay; this compact
   * projection is the refresh/restart checkpoint exposed to the workbench.
   */
  async applyTransportEvents(
    threadId: string,
    assistantMessageId: string,
    events: readonly TurnProjectionTransportEvent[],
  ) {
    if (events.length < 1 || events.length > 256 || events.some(({ envelope, projectionKey, event }) =>
      !envelope || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1 ||
      typeof envelope.eventId !== "string" || !EVENT_ID_PATTERN.test(envelope.eventId) ||
      typeof projectionKey !== "string" || !PROJECTION_KEY_PATTERN.test(projectionKey) || !isChatStreamEvent(event))) {
      throw new WorkbenchPersistenceError("El lot d’esdeveniments de projecció no és vàlid.");
    }
    const identity = await this.prepare(threadId, assistantMessageId);
    return this.locks.withLock(identity.lockKey, async () => {
      const stored = await this.readUnlocked(identity.filePath);
      if (!stored) throw new WorkbenchPersistenceError("La projecció del torn no existeix.");
      this.assertBinding(stored, threadId, assistantMessageId);
      let projection = stored;
      let changed = false;
      const applied: boolean[] = [];
      for (const { envelope, projectionKey, event } of events) {
        this.assertSnapshotBinding(event, stored.message);
        if (envelope.sequence < projection.lastTransportSequence) {
          applied.push(false);
          continue;
        }
        let keys = projection.appliedKeysAtLastSequence;
        if (envelope.sequence === projection.lastTransportSequence) {
          if (projection.lastTransportEventId !== envelope.eventId) {
            throw new WorkbenchPersistenceError("La seqüència de transport s’ha reutilitzat.");
          }
          if (keys.includes(projectionKey)) {
            applied.push(false);
            continue;
          }
        } else {
          keys = [];
        }
        if (keys.length >= MAX_KEYS_PER_TRANSPORT_EVENT) {
          throw new WorkbenchPersistenceError("La seqüència supera el límit de projeccions.");
        }
        // Events are validated above; validate the complete accumulated
        // transcript at the atomic-write boundary, not once for every token.
        projection = {
          ...projection,
          lastTransportSequence: envelope.sequence,
          lastTransportEventId: envelope.eventId,
          appliedKeysAtLastSequence: [...keys, projectionKey],
          message: applyChatStreamEvent(projection.message, event),
          updatedAt: new Date().toISOString(),
        };
        changed = true;
        applied.push(true);
      }
      if (changed) {
        projection = turnProjectionSchema.parse(projection);
        await this.write(identity.filePath, projection);
      }
      return { projection, applied };
    });
  }

  async applyLocalEvent(
    threadId: string,
    assistantMessageId: string,
    event: ChatStreamEvent,
  ) {
    if (!isChatStreamEvent(event)) throw new WorkbenchPersistenceError("L’esdeveniment local no és vàlid.");
    const identity = await this.prepare(threadId, assistantMessageId);
    return this.locks.withLock(identity.lockKey, async () => {
      const projection = await this.readUnlocked(identity.filePath);
      if (!projection) throw new WorkbenchPersistenceError("La projecció del torn no existeix.");
      this.assertBinding(projection, threadId, assistantMessageId);
      this.assertSnapshotBinding(event, projection.message);
      const next = turnProjectionSchema.parse({
        ...projection,
        localRevision: projection.localRevision + 1,
        message: applyChatStreamEvent(projection.message, event),
        updatedAt: new Date().toISOString(),
      });
      await this.write(identity.filePath, next);
      return next;
    });
  }

  /** Operator recovery after a verified app restart; never completes work. */
  async stopUnboundTurnBefore(
    threadId: string,
    assistantMessageId: string,
    options: { restartedAt: string; expectedDigest: string; preparedSourceName?: string },
  ) {
    const cutoff = Date.parse(options.restartedAt);
    if (!Number.isFinite(cutoff) || cutoff > Date.now() ||
        !/^[a-f0-9]{64}$/.test(options.expectedDigest)) {
      throw new WorkbenchPersistenceError("La prova de recuperació no és vàlida.");
    }
    const identity = await this.prepare(threadId, assistantMessageId);
    return this.locks.withLock(identity.lockKey, async () => {
      const projection = await this.readUnlocked(identity.filePath);
      if (!projection) throw new WorkbenchPersistenceError("La projecció del torn no existeix.");
      this.assertBinding(projection, threadId, assistantMessageId);
      const digest = createHash("sha256").update(JSON.stringify(projection)).digest("hex");
      const message = projection.message;
      if (digest !== options.expectedDigest || !isUnboundTurnBefore(projection, options.restartedAt, options.preparedSourceName)) {
        throw new WorkbenchPersistenceError("El torn no és un inici abandonat sense execució.");
      }
      const recoveredMessage: ChatMessage = {
        ...message,
        content: "Ejecución interrumpida antes de iniciar el análisis, durante una versión anterior del servicio. No hay resultado ni acciones ejecutadas por este turno.",
        status: "stopped",
        activity: message.activity.map(item =>
          ["pending", "running", "waiting"].includes(item.status)
            ? { ...item, status: "stopped" as const } : item),
      };
      const next = turnProjectionSchema.parse({
        ...projection,
        localRevision: projection.localRevision + 1,
        message: recoveredMessage,
        updatedAt: new Date().toISOString(),
      });
      await this.write(identity.filePath, next);
      return next;
    });
  }

  async setRuntimeThreadToken(threadId: string, assistantMessageId: string, token: string) {
    if (token.length < 1 || token.length > 2_048 || /\p{C}/u.test(token)) {
      throw new WorkbenchPersistenceError("El token de runtime no és vàlid.");
    }
    const identity = await this.prepare(threadId, assistantMessageId);
    return this.locks.withLock(identity.lockKey, async () => {
      const projection = await this.readUnlocked(identity.filePath);
      if (!projection) throw new WorkbenchPersistenceError("La projecció del torn no existeix.");
      if (projection.runtimeThreadToken && projection.runtimeThreadToken !== token) {
        // Reissued signed tokens have a new expiry/signature on every resume.
        // Rotation is safe only for the same verified tenant/user/thread/toolset.
        const previous = readThreadTokenContext(projection.runtimeThreadToken, projection.installationId, projection.userId);
        const next = readThreadTokenContext(token, projection.installationId, projection.userId);
        if (!previous || !next || previous.threadId !== next.threadId || previous.toolsetRevision !== next.toolsetRevision) {
          throw new WorkbenchPersistenceError("El runtime thread del torn ha canviat de forma insegura.");
        }
      }
      if (projection.runtimeThreadToken === token) return projection;
      const next = turnProjectionSchema.parse({
        ...projection,
        runtimeThreadToken: token,
        localRevision: projection.localRevision + 1,
        updatedAt: new Date().toISOString(),
      });
      await this.write(identity.filePath, next);
      return next;
    });
  }

  async setRuntimeTurnId(threadId: string, assistantMessageId: string, runtimeTurnId: string, rejectedTurnId?: string) {
    if (!EVENT_ID_PATTERN.test(runtimeTurnId)) {
      throw new WorkbenchPersistenceError("L’identificador de runtime turn no és vàlid.");
    }
    const identity = await this.prepare(threadId, assistantMessageId);
    return this.locks.withLock(identity.lockKey, async () => {
      const projection = await this.readUnlocked(identity.filePath);
      if (!projection) throw new WorkbenchPersistenceError("La projecció del torn no existeix.");
      if (projection.runtimeTurnId && projection.runtimeTurnId !== runtimeTurnId) {
        // Only the server runner supplies this proof after a fresh confirmed
        // capacity rejection and a durable retry intent. Never rotate partial
        // work or a terminal local response into another provider turn.
        const message = projection.message;
        if (rejectedTurnId !== projection.runtimeTurnId ||
            message.status !== "streaming" || message.content.length > 0 || message.plan.length > 0 ||
            message.approvals.length > 0 || message.diff.length > 0 || message.artifacts.length > 0 ||
            (message.toolResults?.length ?? 0) > 0 || (message.sources?.length ?? 0) > 0) {
          throw new WorkbenchPersistenceError("El runtime turn ha canviat de forma insegura.");
        }
      }
      if (projection.runtimeTurnId === runtimeTurnId) return projection;
      const next = turnProjectionSchema.parse({
        ...projection,
        runtimeTurnId,
        localRevision: projection.localRevision + 1,
        updatedAt: new Date().toISOString(),
      });
      await this.write(identity.filePath, next);
      return next;
    });
  }
}
