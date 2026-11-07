import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type {
  OperationalAlert,
  OperationalAlertCode,
  OperationalAlertEvaluation,
  OperationalAlertSeverity,
} from "@/operations/alerts";
import {
  atomicWriteJson,
  defineVersionedSchema,
  expectBoolean,
  expectFiniteNumber,
  expectInteger,
  expectIsoDate,
  expectOneOf,
  expectStrictRecord,
  expectString,
  readValidatedJson,
  ResourceLockManager,
  ValidationContext,
} from "@/storage";

const INSTALLATION_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SINK_ID_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const ALERT_CODES = Object.freeze([
  "READINESS_DEGRADED",
  "EGRESS_GATEWAY_DEGRADED",
  "DISK_PRESSURE",
  "PUBLISH_DISK_PRESSURE",
  "RESTART_LOOP",
  "BACKUP_UNVERIFIED",
  "BACKUP_STALE",
  "REPLICA_UNVERIFIED",
  "REPLICA_STALE",
  "PREFLIGHT_FAILURE",
] as const satisfies readonly OperationalAlertCode[]);
const ALERT_SEVERITIES = Object.freeze(["warning", "critical"] as const);
const EVENT_TYPES = Object.freeze(["raised", "updated", "resolved"] as const);
const FAILURE_CODES = Object.freeze(["timeout", "rejected", "unavailable", "unknown"] as const);

type AlertDeliveryEventType = typeof EVENT_TYPES[number];
type AlertDeliveryFailureCode = typeof FAILURE_CODES[number];

export class AlertDeliveryError extends Error {
  constructor(readonly code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "AlertDeliveryError";
  }
}

export class AlertSinkError extends Error {
  constructor(readonly code: AlertDeliveryFailureCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "AlertSinkError";
  }
}

export type AlertDeliveryEvent = {
  schemaVersion: 1;
  eventId: string;
  installationId: string;
  code: OperationalAlertCode;
  eventType: AlertDeliveryEventType;
  severity: OperationalAlertSeverity;
  value: number | null;
  threshold: number | null;
  generation: number;
  evaluatedAt: string;
  createdAt: string;
};

type AlertState = {
  schemaVersion: 1;
  installationId: string;
  code: OperationalAlertCode;
  active: boolean;
  severity: OperationalAlertSeverity;
  value: number | null;
  threshold: number | null;
  generation: number;
  fingerprint: string;
  updatedAt: string;
};

type AlertDeliveryJob = {
  schemaVersion: 1;
  event: AlertDeliveryEvent;
  attempts: number;
  nextAttemptAt: string;
  lastFailure: AlertDeliveryFailureCode | null;
};

export type AlertDeliveryReceipt = {
  schemaVersion: 1;
  eventId: string;
  installationId: string;
  sinkId: string;
  sinkReceiptHash: string;
  deliveredAt: string;
};

function nullableNumber(value: unknown, context: ValidationContext) {
  return value === null ? null : expectFiniteNumber(value, context);
}

function parseEvent(value: unknown, context: ValidationContext): AlertDeliveryEvent {
  const record = expectStrictRecord(value, [
    "schemaVersion",
    "eventId",
    "installationId",
    "code",
    "eventType",
    "severity",
    "value",
    "threshold",
    "generation",
    "evaluatedAt",
    "createdAt",
  ], context);
  if (record.schemaVersion !== 1) context.at("schemaVersion").fail("expected literal 1");
  return {
    schemaVersion: 1,
    eventId: expectString(record.eventId, context.at("eventId"), { minLength: 64, maxLength: 64, pattern: HASH_PATTERN }),
    installationId: expectString(record.installationId, context.at("installationId"), { minLength: 2, maxLength: 63, pattern: INSTALLATION_PATTERN }),
    code: expectOneOf(record.code, ALERT_CODES, context.at("code")),
    eventType: expectOneOf(record.eventType, EVENT_TYPES, context.at("eventType")),
    severity: expectOneOf(record.severity, ALERT_SEVERITIES, context.at("severity")),
    value: nullableNumber(record.value, context.at("value")),
    threshold: nullableNumber(record.threshold, context.at("threshold")),
    generation: expectInteger(record.generation, context.at("generation"), { minimum: 1 }),
    evaluatedAt: expectIsoDate(record.evaluatedAt, context.at("evaluatedAt")),
    createdAt: expectIsoDate(record.createdAt, context.at("createdAt")),
  };
}

export const alertDeliveryEventSchema = {
  name: "AlertDeliveryEvent",
  parse(value: unknown, source = "AlertDeliveryEvent") {
    return parseEvent(value, new ValidationContext("AlertDeliveryEvent", source));
  },
};

const alertStateSchema = defineVersionedSchema<AlertState>({
  name: "AlertState",
  schemaVersion: 1,
  keys: ["installationId", "code", "active", "severity", "value", "threshold", "generation", "fingerprint", "updatedAt"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      installationId: expectString(record.installationId, context.at("installationId"), { minLength: 2, maxLength: 63, pattern: INSTALLATION_PATTERN }),
      code: expectOneOf(record.code, ALERT_CODES, context.at("code")),
      active: expectBoolean(record.active, context.at("active")),
      severity: expectOneOf(record.severity, ALERT_SEVERITIES, context.at("severity")),
      value: nullableNumber(record.value, context.at("value")),
      threshold: nullableNumber(record.threshold, context.at("threshold")),
      generation: expectInteger(record.generation, context.at("generation"), { minimum: 0 }),
      fingerprint: expectString(record.fingerprint, context.at("fingerprint"), { minLength: 64, maxLength: 64, pattern: HASH_PATTERN }),
      updatedAt: expectIsoDate(record.updatedAt, context.at("updatedAt")),
    };
  },
});

const alertDeliveryJobSchema = defineVersionedSchema<AlertDeliveryJob>({
  name: "AlertDeliveryJob",
  schemaVersion: 1,
  keys: ["event", "attempts", "nextAttemptAt", "lastFailure"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      event: parseEvent(record.event, context.at("event")),
      attempts: expectInteger(record.attempts, context.at("attempts"), { minimum: 0, maximum: 1_000_000 }),
      nextAttemptAt: expectIsoDate(record.nextAttemptAt, context.at("nextAttemptAt")),
      lastFailure: record.lastFailure === null
        ? null
        : expectOneOf(record.lastFailure, FAILURE_CODES, context.at("lastFailure")),
    };
  },
});

export const alertDeliveryReceiptSchema = defineVersionedSchema<AlertDeliveryReceipt>({
  name: "AlertDeliveryReceipt",
  schemaVersion: 1,
  keys: ["eventId", "installationId", "sinkId", "sinkReceiptHash", "deliveredAt"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      eventId: expectString(record.eventId, context.at("eventId"), { minLength: 64, maxLength: 64, pattern: HASH_PATTERN }),
      installationId: expectString(record.installationId, context.at("installationId"), { minLength: 2, maxLength: 63, pattern: INSTALLATION_PATTERN }),
      sinkId: expectString(record.sinkId, context.at("sinkId"), { minLength: 2, maxLength: 63, pattern: SINK_ID_PATTERN }),
      sinkReceiptHash: expectString(record.sinkReceiptHash, context.at("sinkReceiptHash"), { minLength: 64, maxLength: 64, pattern: HASH_PATTERN }),
      deliveredAt: expectIsoDate(record.deliveredAt, context.at("deliveredAt")),
    };
  },
});

export interface AlertSink {
  readonly id: string;
  deliver(event: Readonly<AlertDeliveryEvent>): Promise<{ receiptId: string }>;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function alertFingerprint(alert: OperationalAlert | null) {
  return sha256(alert === null
    ? "resolved"
    : JSON.stringify([alert.code, alert.severity, alert.threshold]));
}

function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return Boolean(
    error && typeof error === "object" && "code" in error
    && (code === undefined || (error as NodeJS.ErrnoException).code === code),
  );
}

async function readOptional<T>(filePath: string, schema: { name: string; parse(value: unknown, source?: string): T }) {
  try {
    return await readValidatedJson(filePath, schema);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

function failureCode(error: unknown): AlertDeliveryFailureCode {
  return error instanceof AlertSinkError ? error.code : "unknown";
}

export type FileAlertDeliveryServiceOptions = {
  installationId: string;
  stateRoot: string;
  maximumPending?: number;
  maximumAttempts?: number;
  now?: () => number;
};

export type AlertDeliveryStatus = Readonly<{
  pending: number;
  retryable: number;
  deferred: number;
  exhausted: number;
  oldestCreatedAt: string | null;
  nextAttemptAt: string | null;
  lastFailureCounts: Readonly<Record<AlertDeliveryFailureCode, number>>;
}>;

function earlierIsoDate(current: string | null, candidate: string) {
  return current === null || candidate < current ? candidate : current;
}

export class FileAlertDeliveryService {
  readonly #installationId: string;
  readonly #stateRoot: string;
  readonly #maximumPending: number;
  readonly #maximumAttempts: number;
  readonly #now: () => number;
  readonly #locks: ResourceLockManager;

  constructor(options: FileAlertDeliveryServiceOptions) {
    if (!INSTALLATION_PATTERN.test(options.installationId) || !path.isAbsolute(options.stateRoot)) {
      throw new AlertDeliveryError("ALERT_DELIVERY_CONFIG_INVALID", "Alert delivery configuration is invalid.");
    }
    const maximumPending = options.maximumPending ?? 1_000;
    if (!Number.isSafeInteger(maximumPending) || maximumPending < 1 || maximumPending > 100_000) {
      throw new AlertDeliveryError("ALERT_DELIVERY_CONFIG_INVALID", "maximumPending is invalid.");
    }
    const maximumAttempts = options.maximumAttempts ?? 8;
    if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 100) {
      throw new AlertDeliveryError("ALERT_DELIVERY_CONFIG_INVALID", "maximumAttempts is invalid.");
    }
    this.#installationId = options.installationId;
    this.#stateRoot = path.resolve(options.stateRoot);
    this.#maximumPending = maximumPending;
    this.#maximumAttempts = maximumAttempts;
    this.#now = options.now ?? Date.now;
    this.#locks = new ResourceLockManager({ rootDirectory: path.join(this.#stateRoot, "locks") });
  }

  async reconcile(evaluation: OperationalAlertEvaluation) {
    if (evaluation.schemaVersion !== 1 || !Number.isFinite(Date.parse(evaluation.evaluatedAt))) {
      throw new AlertDeliveryError("ALERT_EVALUATION_INVALID", "Alert evaluation is invalid.");
    }
    const desired = new Map(evaluation.alerts.map((alert) => [alert.code, alert]));
    if (desired.size !== evaluation.alerts.length
      || evaluation.alerts.some((alert) => !ALERT_CODES.includes(alert.code))) {
      throw new AlertDeliveryError("ALERT_EVALUATION_INVALID", "Alert evaluation contains duplicate or unknown codes.");
    }
    return this.#locks.withLock(`alert-reconcile:${this.#installationId}`, async () => {
      const pending = await this.#pendingCount();
      const transitions: Array<{
        code: OperationalAlertCode;
        statePath: string;
        previous: AlertState;
        alert: OperationalAlert | null;
        fingerprint: string;
      }> = [];
      for (const code of ALERT_CODES) {
        const statePath = this.#statePath(code);
        const previous: AlertState = await readOptional(statePath, alertStateSchema) ?? {
          schemaVersion: 1 as const,
          installationId: this.#installationId,
          code,
          active: false,
          severity: "warning" as const,
          value: null,
          threshold: null,
          generation: 0,
          fingerprint: alertFingerprint(null),
          updatedAt: evaluation.evaluatedAt,
        };
        if (previous.installationId !== this.#installationId || previous.code !== code) {
          throw new AlertDeliveryError("ALERT_STATE_CONFLICT", "Alert state belongs to another installation or code.");
        }
        const alert = desired.get(code) ?? null;
        const fingerprint = alertFingerprint(alert);
        if ((alert === null && !previous.active)
          || (alert !== null && previous.active && previous.fingerprint === fingerprint)) continue;
        transitions.push({ code, statePath, previous, alert, fingerprint });
      }
      if (pending + transitions.length > this.#maximumPending) {
        throw new AlertDeliveryError("ALERT_DELIVERY_BACKPRESSURE", "Alert outbox reached its safety limit.");
      }
      const queued: AlertDeliveryEvent[] = [];
      for (const { code, statePath, previous, alert, fingerprint } of transitions) {
        const generation = previous.generation + 1;
        const eventType: AlertDeliveryEventType = alert === null
          ? "resolved"
          : previous.active ? "updated" : "raised";
        const eventId = sha256([
          this.#installationId,
          code,
          String(generation),
          previous.fingerprint,
          fingerprint,
        ].join("\0"));
        const event = alertDeliveryEventSchema.parse({
          schemaVersion: 1,
          eventId,
          installationId: this.#installationId,
          code,
          eventType,
          severity: alert?.severity ?? previous.severity,
          value: alert?.value ?? previous.value,
          threshold: alert?.threshold ?? previous.threshold,
          generation,
          evaluatedAt: evaluation.evaluatedAt,
          createdAt: new Date(this.#now()).toISOString(),
        });
        const receipt = await readOptional(this.#receiptPath(eventId), alertDeliveryReceiptSchema);
        const existing = await readOptional(this.#outboxPath(eventId), alertDeliveryJobSchema);
        if (!receipt && !existing) {
          await atomicWriteJson(this.#outboxPath(eventId), {
            schemaVersion: 1,
            event,
            attempts: 0,
            nextAttemptAt: event.createdAt,
            lastFailure: null,
          }, alertDeliveryJobSchema, { mode: 0o600 });
        }
        await atomicWriteJson(statePath, {
          schemaVersion: 1,
          installationId: this.#installationId,
          code,
          active: alert !== null,
          severity: alert?.severity ?? previous.severity,
          value: alert?.value ?? previous.value,
          threshold: alert?.threshold ?? previous.threshold,
          generation,
          fingerprint,
          updatedAt: evaluation.evaluatedAt,
        }, alertStateSchema, { mode: 0o600 });
        queued.push(event);
      }
      return Object.freeze(queued);
    });
  }

  async dispatch(sink: AlertSink, limit = 100) {
    if (!SINK_ID_PATTERN.test(sink.id) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new AlertDeliveryError("ALERT_DELIVERY_CONFIG_INVALID", "Alert sink or dispatch limit is invalid.");
    }
    await mkdir(path.join(this.#stateRoot, "outbox"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.#stateRoot, "failed"), { recursive: true, mode: 0o700 });
    const names = (await readdir(path.join(this.#stateRoot, "outbox")))
      .filter((name) => /^[0-9a-f]{64}\.json$/u.test(name))
      .sort();
    const receipts: AlertDeliveryReceipt[] = [];
    let attempted = 0;
    for (const name of names) {
      const eventId = name.slice(0, -5);
      const receipt = await this.#locks.withLock(`alert-dispatch:${this.#installationId}:${eventId}`, async () => {
        const existingReceipt = await readOptional(this.#receiptPath(eventId), alertDeliveryReceiptSchema);
        if (existingReceipt) {
          await rm(this.#outboxPath(eventId), { force: true });
          return existingReceipt;
        }
        const job = await readOptional(this.#outboxPath(eventId), alertDeliveryJobSchema);
        if (!job) return null;
        if (job.event.installationId !== this.#installationId || job.event.eventId !== eventId) {
          throw new AlertDeliveryError("ALERT_JOB_CONFLICT", "Alert job identity is invalid.");
        }
        if (job.attempts >= this.#maximumAttempts) {
          await this.#archiveExhausted(eventId, job);
          return null;
        }
        if (Date.parse(job.nextAttemptAt) > this.#now() || attempted >= limit) return null;
        attempted += 1;
        try {
          const delivered = await sink.deliver(Object.freeze(job.event));
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(delivered.receiptId)) {
            throw new AlertSinkError("rejected", "Alert sink returned an invalid receipt.");
          }
          const completed = alertDeliveryReceiptSchema.parse({
            schemaVersion: 1,
            eventId,
            installationId: this.#installationId,
            sinkId: sink.id,
            sinkReceiptHash: sha256(delivered.receiptId),
            deliveredAt: new Date(this.#now()).toISOString(),
          });
          await atomicWriteJson(this.#receiptPath(eventId), completed, alertDeliveryReceiptSchema, { mode: 0o600 });
          await rm(this.#outboxPath(eventId), { force: true });
          return completed;
        } catch (error) {
          const lastFailure = failureCode(error);
          const attempts = lastFailure === "rejected"
            ? this.#maximumAttempts
            : Math.min(job.attempts + 1, this.#maximumAttempts);
          const delayMs = Math.min(5 * 60 * 1_000, 1_000 * (2 ** Math.min(attempts - 1, 8)));
          await atomicWriteJson(this.#outboxPath(eventId), {
            ...job,
            attempts,
            nextAttemptAt: new Date(this.#now() + delayMs).toISOString(),
            lastFailure,
          }, alertDeliveryJobSchema, { mode: 0o600 });
          if (attempts >= this.#maximumAttempts) {
            await this.#archiveExhausted(eventId, { ...job, attempts, lastFailure });
          }
          return null;
        }
      });
      if (receipt) receipts.push(receipt);
    }
    return Object.freeze(receipts);
  }

  async status(): Promise<AlertDeliveryStatus> {
    await mkdir(path.join(this.#stateRoot, "outbox"), { recursive: true, mode: 0o700 });
    const names = (await readdir(path.join(this.#stateRoot, "outbox")))
      .filter((name) => /^[0-9a-f]{64}\.json$/u.test(name))
      .sort();
    const failedNames = await this.#failedNames();
    const counts: Record<AlertDeliveryFailureCode, number> = {
      timeout: 0,
      rejected: 0,
      unavailable: 0,
      unknown: 0,
    };
    let retryable = 0;
    let deferred = 0;
    let exhausted = 0;
    let oldestCreatedAt: string | null = null;
    let nextAttemptAt: string | null = null;
    for (const name of names) {
      const eventId = name.slice(0, -5);
      const job = await readOptional(this.#outboxPath(eventId), alertDeliveryJobSchema);
      if (!job) continue;
      if (job.event.installationId !== this.#installationId || job.event.eventId !== eventId) {
        throw new AlertDeliveryError("ALERT_JOB_CONFLICT", "Alert job identity is invalid.");
      }
      if (job.lastFailure) counts[job.lastFailure] += 1;
      oldestCreatedAt = earlierIsoDate(oldestCreatedAt, job.event.createdAt);
      if (job.attempts >= this.#maximumAttempts) exhausted += 1;
      else if (Date.parse(job.nextAttemptAt) <= this.#now()) retryable += 1;
      else {
        deferred += 1;
        nextAttemptAt = earlierIsoDate(nextAttemptAt, job.nextAttemptAt);
      }
    }
    for (const name of failedNames) {
      const eventId = name.slice(0, -5);
      const job = await readOptional(this.#failedPath(eventId), alertDeliveryJobSchema);
      if (!job) continue;
      if (job.event.installationId !== this.#installationId || job.event.eventId !== eventId
        || job.attempts < this.#maximumAttempts) {
        throw new AlertDeliveryError("ALERT_JOB_CONFLICT", "Exhausted alert job identity is invalid.");
      }
      exhausted += 1;
      if (job.lastFailure) counts[job.lastFailure] += 1;
    }
    return Object.freeze({
      pending: names.length,
      retryable,
      deferred,
      exhausted,
      oldestCreatedAt,
      nextAttemptAt,
      lastFailureCounts: Object.freeze(counts),
    });
  }

  async #pendingCount() {
    try {
      return (await readdir(path.join(this.#stateRoot, "outbox")))
        .filter((name) => /^[0-9a-f]{64}\.json$/u.test(name)).length;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return 0;
      throw error;
    }
  }

  async #failedNames() {
    try {
      return (await readdir(path.join(this.#stateRoot, "failed")))
        .filter((name) => /^[0-9a-f]{64}\.json$/u.test(name)).sort();
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
  }

  async #archiveExhausted(eventId: string, job: AlertDeliveryJob) {
    const existing = await readOptional(this.#failedPath(eventId), alertDeliveryJobSchema);
    if (existing) {
      if (existing.event.eventId !== job.event.eventId
        || existing.event.installationId !== job.event.installationId) {
        throw new AlertDeliveryError("ALERT_JOB_CONFLICT", "Exhausted alert job conflicts with existing evidence.");
      }
      await rm(this.#outboxPath(eventId), { force: true });
      return;
    }
    await rename(this.#outboxPath(eventId), this.#failedPath(eventId));
  }

  #statePath(code: OperationalAlertCode) {
    return path.join(this.#stateRoot, "state", `${code}.json`);
  }

  #outboxPath(eventId: string) {
    return path.join(this.#stateRoot, "outbox", `${eventId}.json`);
  }

  #receiptPath(eventId: string) {
    return path.join(this.#stateRoot, "receipts", `${eventId}.json`);
  }

  #failedPath(eventId: string) {
    return path.join(this.#stateRoot, "failed", `${eventId}.json`);
  }
}

export class FileAlertSink implements AlertSink {
  readonly id: string;
  readonly #deliveryRoot: string;

  constructor(deliveryRoot: string, id = "local-audit") {
    if (!path.isAbsolute(deliveryRoot) || !SINK_ID_PATTERN.test(id)) {
      throw new AlertDeliveryError("ALERT_DELIVERY_CONFIG_INVALID", "File alert sink configuration is invalid.");
    }
    this.id = id;
    this.#deliveryRoot = path.resolve(deliveryRoot);
  }

  async deliver(event: Readonly<AlertDeliveryEvent>) {
    await atomicWriteJson(
      path.join(this.#deliveryRoot, `${event.eventId}.json`),
      event,
      alertDeliveryEventSchema,
      { mode: 0o600 },
    );
    return { receiptId: `file:${event.eventId}` };
  }
}

export type WebhookAlertSinkOptions = {
  endpoint: string;
  bearerToken?: string;
  id?: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
};

export class WebhookAlertSink implements AlertSink {
  readonly id: string;
  readonly #endpoint: string;
  readonly #bearerToken: string | null;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: WebhookAlertSinkOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch (error) {
      throw new AlertDeliveryError("ALERT_DELIVERY_CONFIG_INVALID", "Alert webhook URL is invalid.", { cause: error });
    }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
      throw new AlertDeliveryError("ALERT_DELIVERY_CONFIG_INVALID", "Alert webhook must be a credential-free HTTPS URL.");
    }
    const id = options.id ?? "webhook";
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!SINK_ID_PATTERN.test(id) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
      throw new AlertDeliveryError("ALERT_DELIVERY_CONFIG_INVALID", "Alert webhook options are invalid.");
    }
    const token = options.bearerToken ?? null;
    if (token !== null && (!token || token.length > 4_096 || /[\0\r\n]/u.test(token))) {
      throw new AlertDeliveryError("ALERT_DELIVERY_CONFIG_INVALID", "Alert webhook token is invalid.");
    }
    this.id = id;
    this.#endpoint = endpoint.toString();
    this.#bearerToken = token;
    this.#timeoutMs = timeoutMs;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async deliver(event: Readonly<AlertDeliveryEvent>) {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": event.eventId,
          ...(this.#bearerToken ? { Authorization: `Bearer ${this.#bearerToken}` } : {}),
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new AlertSinkError(
        error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "unavailable",
        "Alert webhook is unavailable.",
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new AlertSinkError(
        response.status === 408 || response.status === 429 || response.status >= 500
          ? "unavailable"
          : "rejected",
        "Alert webhook rejected the delivery.",
      );
    }
    const requestId = response.headers.get("x-request-id");
    return {
      receiptId: requestId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(requestId)
        ? requestId
        : `http:${response.status}:${event.eventId}`,
    };
  }
}
