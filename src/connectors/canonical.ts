import { createHash } from "node:crypto";
import { ConnectorError } from "@/connectors/contracts";

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ConnectorError("CONNECTOR_CANONICAL_INVALID", "Canonical connector data contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new ConnectorError("CONNECTOR_CANONICAL_INVALID", "Canonical connector data contains an unsupported value.");
  }
  if (ancestors.has(value)) {
    throw new ConnectorError("CONNECTOR_CANONICAL_INVALID", "Canonical connector data is cyclic.");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ConnectorError("CONNECTOR_CANONICAL_INVALID", "Canonical connector data must use plain objects.");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalConnectorJson(value: unknown) {
  return canonicalJson(value, new Set());
}

export function connectorFingerprint(value: unknown) {
  return createHash("sha256").update(canonicalConnectorJson(value)).digest("hex");
}
