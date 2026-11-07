export type OperationalLogLevel = "debug" | "info" | "warn" | "error";

export type OperationalLogPrimitive = boolean | number | string | null;
export type OperationalLogValue =
  | OperationalLogPrimitive
  | OperationalLogArray
  | OperationalLogObject;
export interface OperationalLogArray extends ReadonlyArray<OperationalLogValue> {}
export interface OperationalLogObject {
  readonly [key: string]: OperationalLogValue;
}

export type OperationalLogRecord = Readonly<{
  schemaVersion: 1;
  timestamp: string;
  level: OperationalLogLevel;
  event: string;
  attributes: Readonly<Record<string, OperationalLogValue>>;
}>;

export type OperationalLogSink = (record: OperationalLogRecord) => void;

export type OperationalLogger = Readonly<{
  debug(event: string, attributes?: Readonly<Record<string, unknown>>): void;
  info(event: string, attributes?: Readonly<Record<string, unknown>>): void;
  warn(event: string, attributes?: Readonly<Record<string, unknown>>): void;
  error(event: string, attributes?: Readonly<Record<string, unknown>>): void;
}>;

export type OperationalLoggerOptions = {
  sink: OperationalLogSink;
  now?: () => number;
  baseAttributes?: Readonly<Record<string, unknown>>;
};

const REDACTED = "[REDACTED]";
const PATH_REDACTED = "[PATH_REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const SENSITIVE_KEY = /(?:authorization|body|content|cookie|credential|email|excerpt|message|password|prompt|secret|session|token|api[-_]?key|recovery[-_]?id|code[-_]?(?:verifier|challenge))/iu;
const PATH_KEY = /(?:^|[-_])(?:file|path|root|directory|cwd)(?:$|[-_])|(?:file|path|root|directory|cwd)$/iu;
const SAFE_EVENT = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 64;
const MAX_STRING_LENGTH = 512;

function sanitizeString(value: string) {
  const bounded = value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}${TRUNCATED}`
    : value;
  return bounded
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, `$1${REDACTED}@`)
    .replace(/aibrain\.auth\.[^.\s]+\.[^\s,;]+/giu, "aibrain.auth.[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]{12,})?\b/gu, REDACTED)
    .replace(/([?&#](?:amp;)?(?:access_token|refresh_token|token_hash|api_key|key|password|secret|token|code|code_verifier|code_challenge)=)[^&#\s"'<>]+/giu, `$1${REDACTED}`)
    .replace(/\b(password|secret|token)=([^\s,;]+)/giu, `$1=${REDACTED}`);
}

function sanitizeNumber(value: number): number | string {
  return Number.isFinite(value) ? value : String(value);
}

function sanitizeValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): OperationalLogValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number") return sanitizeNumber(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[UNDEFINED]";
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";
  if (value instanceof Error) {
    const nodeCode = "code" in value && typeof value.code === "string" ? value.code : null;
    return Object.freeze({
      name: sanitizeString(value.name),
      message: REDACTED,
      ...(nodeCode ? { code: sanitizeString(nodeCode) } : {}),
    });
  }
  if (typeof value !== "object") return "[UNSUPPORTED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const output = value.slice(0, MAX_ARRAY_ITEMS)
        .map((entry) => sanitizeValue(entry, seen, depth + 1));
      if (value.length > MAX_ARRAY_ITEMS) output.push(TRUNCATED);
      return Object.freeze(output);
    }
    const output: Record<string, OperationalLogValue> = {};
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    for (const [key, entry] of entries) {
      if (SENSITIVE_KEY.test(key)) output[key] = REDACTED;
      else if (PATH_KEY.test(key)) output[key] = PATH_REDACTED;
      else output[key] = sanitizeValue(entry, seen, depth + 1);
    }
    if (Object.keys(value).length > MAX_OBJECT_KEYS) output._truncated = true;
    return Object.freeze(output);
  } finally {
    seen.delete(value);
  }
}

export function redactOperationalAttributes(
  attributes: Readonly<Record<string, unknown>>,
): Readonly<Record<string, OperationalLogValue>> {
  return sanitizeValue(attributes, new WeakSet(), 0) as Readonly<Record<string, OperationalLogValue>>;
}

function validateEvent(event: string) {
  if (!SAFE_EVENT.test(event) || event.length > 96) {
    throw new Error("Operational log events must be lowercase dotted identifiers up to 96 characters.");
  }
  return event;
}

export function createOperationalLogger(options: OperationalLoggerOptions): OperationalLogger {
  const now = options.now ?? Date.now;
  const base = options.baseAttributes ?? {};
  const write = (
    level: OperationalLogLevel,
    event: string,
    attributes: Readonly<Record<string, unknown>> = {},
  ) => {
    const timestamp = new Date(now()).toISOString();
    const merged = { ...base, ...attributes };
    options.sink(Object.freeze({
      schemaVersion: 1,
      timestamp,
      level,
      event: validateEvent(event),
      attributes: redactOperationalAttributes(merged),
    }));
  };
  return Object.freeze({
    debug: (event, attributes) => write("debug", event, attributes),
    info: (event, attributes) => write("info", event, attributes),
    warn: (event, attributes) => write("warn", event, attributes),
    error: (event, attributes) => write("error", event, attributes),
  });
}

export function jsonLineOperationalLogSink(stream: Pick<NodeJS.WritableStream, "write">): OperationalLogSink {
  return (record) => {
    stream.write(`${JSON.stringify(record)}\n`);
  };
}
