/** Stable fingerprint bytes. Keep domain errors at the caller and preserve the
 * existing sparse-array and plain-object behavior: this is not JSON.stringify. */
export function canonicalJson(value: unknown, invalid: (detail: string) => Error): string {
  const ancestors = new Set<object>();
  function encode(value: unknown): string {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return JSON.stringify(value);
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw invalid("contains a non-finite number.");
      }
      return JSON.stringify(value);
    }
    if (typeof value !== "object") {
      throw invalid(`contains unsupported ${typeof value}.`);
    }
    if (ancestors.has(value)) {
      throw invalid("is cyclic.");
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return `[${value.map((item) => encode(item)).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw invalid("must contain only plain objects.");
      }
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
        .join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  return encode(value);
}
