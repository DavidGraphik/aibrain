import { SchemaValidationError } from "@/storage/errors";

export type UnknownRecord = Readonly<Record<string, unknown>>;

export type StorageSchema<T> = {
  readonly name: string;
  parse(value: unknown, source?: string): T;
};

export type VersionedRecord<Version extends number = number> = {
  schemaVersion: Version;
};

type VersionedSchemaDefinition<T extends VersionedRecord> = {
  readonly name: string;
  readonly schemaVersion: T["schemaVersion"];
  readonly keys: readonly (Exclude<keyof T, "schemaVersion"> & string)[];
  readonly parse: (record: UnknownRecord, context: ValidationContext) => T;
};

export class ValidationContext {
  readonly schemaName: string;
  readonly source: string;
  readonly path: string;

  constructor(schemaName: string, source: string, path = "$") {
    this.schemaName = schemaName;
    this.source = source;
    this.path = path;
  }

  at(property: string | number) {
    const suffix = typeof property === "number"
      ? `[${property}]`
      : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)
        ? `.${property}`
        : `[${JSON.stringify(property)}]`;
    return new ValidationContext(this.schemaName, this.source, `${this.path}${suffix}`);
  }

  fail(message: string, cause?: unknown): never {
    const detail = this.source === this.schemaName
      ? message
      : `${message} (source: ${this.source})`;
    throw new SchemaValidationError(this.schemaName, this.path, detail, { cause });
  }
}

export function defineVersionedSchema<T extends VersionedRecord>(
  definition: VersionedSchemaDefinition<T>,
): StorageSchema<T> & { readonly schemaVersion: T["schemaVersion"] } {
  const allowedKeys = ["schemaVersion", ...definition.keys];
  if (new Set(allowedKeys).size !== allowedKeys.length) {
    throw new Error(`${definition.name} declares duplicate schema keys.`);
  }

  return Object.freeze({
    name: definition.name,
    schemaVersion: definition.schemaVersion,
    parse(value: unknown, source = definition.name) {
      const context = new ValidationContext(definition.name, source);
      const record = expectStrictRecord(value, allowedKeys, context);
      expectLiteral(record.schemaVersion, definition.schemaVersion, context.at("schemaVersion"));
      const decoded = definition.parse(record, context);
      if (decoded.schemaVersion !== definition.schemaVersion) {
        context.at("schemaVersion").fail(
          `schema parser returned ${String(decoded.schemaVersion)}, expected ${String(definition.schemaVersion)}`,
        );
      }
      return decoded;
    },
  });
}

export function parseJson<T>(schema: StorageSchema<T>, json: string, source = schema.name): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json) as unknown;
  } catch (error) {
    throw new SchemaValidationError(schema.name, "$", `invalid JSON (source: ${source})`, {
      cause: error,
    });
  }
  return schema.parse(decoded, source);
}

export function expectStrictRecord(
  value: unknown,
  allowedKeys: readonly string[],
  context: ValidationContext,
): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    context.fail("expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    context.fail("expected a plain object");
  }

  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record);
  const allowed = new Set(allowedKeys);
  const unexpected = actualKeys.filter((key) => !allowed.has(key));
  const missing = allowedKeys.filter((key) => !Object.hasOwn(record, key));
  if (unexpected.length > 0) {
    context.fail(`unexpected properties: ${unexpected.sort().join(", ")}`);
  }
  if (missing.length > 0) {
    context.fail(`missing properties: ${missing.join(", ")}`);
  }
  return record;
}

export function expectString(
  value: unknown,
  context: ValidationContext,
  options: { minLength?: number; maxLength?: number; pattern?: RegExp } = {},
): string {
  if (typeof value !== "string") context.fail("expected a string");
  if (options.minLength !== undefined && value.length < options.minLength) {
    context.fail(`expected at least ${options.minLength} characters`);
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    context.fail(`expected at most ${options.maxLength} characters`);
  }
  if (options.pattern && !options.pattern.test(value)) {
    context.fail(`string does not match ${options.pattern}`);
  }
  return value;
}

export function expectBoolean(value: unknown, context: ValidationContext): boolean {
  if (typeof value !== "boolean") context.fail("expected a boolean");
  return value;
}

export function expectInteger(
  value: unknown,
  context: ValidationContext,
  options: { minimum?: number; maximum?: number } = {},
): number {
  if (!Number.isSafeInteger(value)) context.fail("expected a safe integer");
  const integer = value as number;
  if (options.minimum !== undefined && integer < options.minimum) {
    context.fail(`expected a value >= ${options.minimum}`);
  }
  if (options.maximum !== undefined && integer > options.maximum) {
    context.fail(`expected a value <= ${options.maximum}`);
  }
  return integer;
}

export function expectFiniteNumber(
  value: unknown,
  context: ValidationContext,
  options: { minimum?: number; maximum?: number } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    context.fail("expected a finite number");
  }
  if (options.minimum !== undefined && value < options.minimum) {
    context.fail(`expected a value >= ${options.minimum}`);
  }
  if (options.maximum !== undefined && value > options.maximum) {
    context.fail(`expected a value <= ${options.maximum}`);
  }
  return value;
}

export function expectLiteral<const Value extends string | number | boolean | null>(
  value: unknown,
  expected: Value,
  context: ValidationContext,
): Value {
  if (value !== expected) context.fail(`expected literal ${JSON.stringify(expected)}`);
  return expected;
}

export function expectOneOf<const Value extends string | number>(
  value: unknown,
  expected: readonly Value[],
  context: ValidationContext,
): Value {
  if (!expected.includes(value as Value)) {
    context.fail(`expected one of ${expected.map(String).join(", ")}`);
  }
  return value as Value;
}

export function expectArray<T>(
  value: unknown,
  context: ValidationContext,
  parseItem: (item: unknown, context: ValidationContext) => T,
  options: { maxLength?: number } = {},
): T[] {
  if (!Array.isArray(value)) context.fail("expected an array");
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    context.fail(`expected at most ${options.maxLength} items`);
  }
  return value.map((item, index) => parseItem(item, context.at(index)));
}

export function expectIsoDate(value: unknown, context: ValidationContext): string {
  const text = expectString(value, context, { minLength: 20, maxLength: 35 });
  const parsed = new Date(text);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== text) {
    context.fail("expected a canonical UTC ISO-8601 timestamp");
  }
  return text;
}
