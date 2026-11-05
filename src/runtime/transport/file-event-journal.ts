import path from "node:path";
import { lstat } from "node:fs/promises";
import type {
  AppServerEvent,
  ReplayCursor,
  TransportEventJournal,
} from "@/runtime/transport/contracts";
import { TransportProtocolError, parseAppServerEvent } from "@/runtime/transport/wire-protocol";
import { FileJournal } from "@/storage/journal";
import { atomicWriteJson, readValidatedJson } from "@/storage/atomic-file";
import type { ResourceLockManager } from "@/storage/resource-lock";
import {
  defineVersionedSchema,
  expectInteger,
  expectString,
  type StorageSchema,
} from "@/storage/schema";

const appServerEventSchema: StorageSchema<AppServerEvent> = Object.freeze({
  name: "AppServerEvent@codex-0.162.1",
  parse(value: unknown) {
    return parseAppServerEvent(value);
  },
});

const eventSequence = (event: AppServerEvent) => event.sequence;
const eventKey = (event: AppServerEvent) => event.eventId;

type DeliveryCursorRecord = {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
};

const deliveryCursorSchema = defineVersionedSchema<DeliveryCursorRecord>({
  name: "TransportDeliveryCursor",
  schemaVersion: 1,
  keys: ["eventId", "sequence"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      eventId: expectString(record.eventId, context.at("eventId"), {
        minLength: 1,
        maxLength: 256,
      }),
      sequence: expectInteger(record.sequence, context.at("sequence"), { minimum: 1 }),
    };
  },
});

export type FileTransportEventJournalOptions = {
  filePath: string;
  lockManager: ResourceLockManager;
  maxRetainedDeliveredEvents?: number;
  maxRetainedDeliveredBytes?: number;
};

/** Durable per-worker transport cursor and event log. */
export class FileTransportEventJournal implements TransportEventJournal {
  readonly filePath: string;
  private readonly journal: FileJournal<AppServerEvent>;
  private readonly lockManager: ResourceLockManager;
  private readonly deliveryCursorPath: string;
  private readonly maxRetainedDeliveredEvents: number;
  private readonly maxRetainedDeliveredBytes: number;
  private deliveredBytesSinceCompaction = 0;
  private checkedInitialCompaction = false;
  private compactionDeferred = false;
  private readonly verifiedEvents = new Map<number, { eventId: string; bytes: number }>();

  constructor(options: FileTransportEventJournalOptions) {
    this.filePath = path.resolve(options.filePath);
    this.lockManager = options.lockManager;
    this.deliveryCursorPath = `${this.filePath}.delivery.json`;
    this.maxRetainedDeliveredEvents = options.maxRetainedDeliveredEvents ?? 256;
    if (!Number.isSafeInteger(this.maxRetainedDeliveredEvents) ||
        this.maxRetainedDeliveredEvents < 1 || this.maxRetainedDeliveredEvents > 65_536) {
      throw new Error("Delivered event retention must be between 1 and 65536.");
    }
    this.maxRetainedDeliveredBytes = options.maxRetainedDeliveredBytes ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxRetainedDeliveredBytes) || this.maxRetainedDeliveredBytes < 1) {
      throw new Error("Delivered event byte retention must be a positive safe integer.");
    }
    this.journal = new FileJournal({
      filePath: this.filePath,
      lockManager: options.lockManager,
      payloadSchema: appServerEventSchema,
      contiguousPayloadSequence: eventSequence,
      keyOf: eventKey,
      shareReadIndex: true,
    });
  }

  async loadCursor(): Promise<ReplayCursor | null> {
    const last = (await this.journal.readLast())?.payload;
    return last ? { eventId: last.eventId, sequence: last.sequence } : null;
  }

  async append(event: AppServerEvent) {
    const validated = appServerEventSchema.parse(event);
    const appended = await this.journal.appendIndexed(validated, (existing, lastSequence) => {
      if (existing) {
        if (existing.payload.sequence !== validated.sequence) {
          throw new TransportProtocolError("Worker reused an eventId with a different sequence.");
        }
        return false;
      }
      const expected = lastSequence + 1;
      if (validated.sequence !== expected) {
        throw new TransportProtocolError(
          `Durable event journal expected sequence ${expected}, received ${validated.sequence}.`,
        );
      }
      return true;
    });
    if (appended !== null) this.rememberVerified(validated);
    return appended !== null;
  }

  async readEvents(afterSequence = 0, limit = Number.MAX_SAFE_INTEGER, maxBytes?: number) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 ||
        !Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Transport event read bounds are invalid.");
    }
    return (await this.journal.readContiguous(afterSequence, limit, maxBytes))
      .map((entry) => entry.payload);
  }

  async loadDeliveryCursor() {
    try {
      return await readValidatedJson(this.deliveryCursorPath, deliveryCursorSchema);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async readUndelivered(limit: number, afterSequence = 0) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Undelivered event limit must be positive.");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("Undelivered event cursor must be a non-negative safe integer.");
    }
    return this.lockManager.withLock(`transport-delivery:${this.deliveryCursorPath}`, async () => {
      const cursor = await this.loadDeliveryCursor();
      if (cursor) {
        const persisted = (await this.readEvents(cursor.sequence - 1, 1))[0];
        if (!persisted || persisted.eventId !== cursor.eventId || persisted.sequence !== cursor.sequence) {
          throw new TransportProtocolError("Transport delivery cursor does not match the durable event journal.");
        }
      }
      const events = await this.readEvents(Math.max(cursor?.sequence ?? 0, afterSequence), limit, 4 * 1024 * 1024);
      for (const event of events) this.rememberVerified(event);
      return events;
    });
  }

  async markDelivered(event: AppServerEvent) {
    return this.markDeliveredBatch([event]);
  }

  async markDeliveredIdentity(eventId: string, sequence: number) {
    if (!eventId || !Number.isSafeInteger(sequence) || sequence < 1) {
      throw new TransportProtocolError("Transport delivery identity is invalid.");
    }
    return this.markDeliveredIdentities([{ eventId, sequence }]);
  }

  async markDeliveredBatch(events: readonly AppServerEvent[]) {
    if (!events.length || events.length > 256) throw new TransportProtocolError("Invalid delivery batch size.");
    return this.markDeliveredIdentities(events.map(event => appServerEventSchema.parse(event)));
  }

  private async markDeliveredIdentities(validated: readonly {eventId: string; sequence: number}[]) {
    await this.lockManager.withLock(`transport-delivery:${this.deliveryCursorPath}`, async () => {
      const cursor = await this.loadDeliveryCursor();
      if (validated.length === 1 && cursor?.eventId === validated[0].eventId && cursor.sequence === validated[0].sequence) return;
      let expected = (cursor?.sequence ?? 0) + 1;
      let bytes = 0;
      // Validate EVERY identity before the single durable commit. A failed or
      // out-of-order handler can never disappear behind the final watermark.
      for (const event of validated) {
        if (event.sequence !== expected) throw new TransportProtocolError(
          `Transport delivery expected sequence ${expected}, received ${event.sequence}.`,
        );
        const verified = this.verifiedEvents.get(event.sequence);
        const persisted = verified === undefined ? (await this.readEvents(event.sequence - 1, 1))[0] : null;
        if ((verified && verified.eventId !== event.eventId) ||
            (!verified && (!persisted || persisted.eventId !== event.eventId || persisted.sequence !== event.sequence))) {
          throw new TransportProtocolError("Cannot acknowledge an event absent from the durable journal.");
        }
        bytes += verified?.bytes ?? Buffer.byteLength(JSON.stringify(persisted));
        expected++;
      }
      const last = validated[validated.length - 1];
      await atomicWriteJson(this.deliveryCursorPath, {
        schemaVersion: 1, eventId: last.eventId, sequence: last.sequence,
      }, deliveryCursorSchema, { mode: 0o600 });
      this.deliveredBytesSinceCompaction += bytes;
      for (const event of validated) this.verifiedEvents.delete(event.sequence);
      await this.compactDelivered(last.sequence);
    });
  }

  /**
   * Reconcile the gateway delivery cursor with a client resume cursor that was
   * already validated against this durable journal. Event acknowledgements are
   * cumulative: after a reconnect the client may have compacted intermediate
   * events, so requiring one ACK for every historical sequence can leave the
   * gateway cursor permanently behind.
   */
  async reconcileDeliveryCursor(eventId: string, sequence: number) {
    if (!eventId || !Number.isSafeInteger(sequence) || sequence < 1) {
      throw new TransportProtocolError("Transport delivery identity is invalid.");
    }
    await this.lockManager.withLock(`transport-delivery:${this.deliveryCursorPath}`, async () => {
      const cursor = await this.loadDeliveryCursor();
      if (cursor && sequence < cursor.sequence) {
        throw new TransportProtocolError("Transport resume cursor is behind the delivery cursor.");
      }
      if (cursor?.eventId === eventId && cursor.sequence === sequence) return;
      if (cursor?.sequence === sequence) {
        throw new TransportProtocolError("Transport resume cursor conflicts with the delivery cursor.");
      }
      const persisted = (await this.readEvents(sequence - 1, 1))[0];
      if (!persisted || persisted.eventId !== eventId || persisted.sequence !== sequence) {
        throw new TransportProtocolError("Cannot reconcile an event absent from the durable journal.");
      }
      await atomicWriteJson(this.deliveryCursorPath, {
        schemaVersion: 1,
        eventId,
        sequence,
      }, deliveryCursorSchema, { mode: 0o600 });
      for (const verifiedSequence of this.verifiedEvents.keys()) {
        if (verifiedSequence <= sequence) this.verifiedEvents.delete(verifiedSequence);
      }
      await this.compactDelivered(sequence, true);
    });
  }

  private async compactDelivered(sequence: number, forceCheck = false) {
    const countBoundary = sequence % this.maxRetainedDeliveredEvents === 0
      || sequence === this.maxRetainedDeliveredEvents * 2 + 1;
    const byteBoundary = this.deliveredBytesSinceCompaction >= this.maxRetainedDeliveredBytes;
    const initialCheck = !this.checkedInitialCompaction;
    this.checkedInitialCompaction = true;
    if (!forceCheck && !countBoundary && !byteBoundary && !initialCheck && !this.compactionDeferred) return;
    const oversized = (await lstat(this.filePath)).size > this.maxRetainedDeliveredBytes * 2;
    if (!forceCheck && !countBoundary && !oversized && !this.compactionDeferred) return;
    const result = await this.journal.compactContiguousTail({ anchorSequence: sequence,
      // Reconciliation forces this check, not a rewrite of undelivered history.
      deferWhilePending: true,
      maxRetainedEntries: this.maxRetainedDeliveredEvents,
      maxRetainedBytes: this.maxRetainedDeliveredBytes,
      minimumEntries: oversized ? 0 : this.maxRetainedDeliveredEvents * 2,
      // Pending history also contributes to `oversized`. Rewriting that entire
      // suffix to retire one small delivered record blocks startup reception.
      // Batch small ACKs; a genuinely large retired prefix can still be pruned.
      minimumRemovedEntries: this.maxRetainedDeliveredEvents,
      ...(oversized ? { minimumRemovedBytes: this.maxRetainedDeliveredBytes } : {}) });
    this.compactionDeferred = "deferred" in result && result.deferred === true;
    if (!this.compactionDeferred) this.deliveredBytesSinceCompaction = 0;
  }

  private rememberVerified(event: AppServerEvent) {
    this.verifiedEvents.delete(event.sequence);
    this.verifiedEvents.set(event.sequence, { eventId: event.eventId, bytes: Buffer.byteLength(JSON.stringify(event)) });
    while (this.verifiedEvents.size > 4_096) {
      const oldest = this.verifiedEvents.keys().next().value;
      if (oldest === undefined) break;
      this.verifiedEvents.delete(oldest);
    }
  }

  async verifyAndRepair() {
    return this.journal.verifyAndRepair();
  }
}
