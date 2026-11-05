import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalPermissionJson, permissionFingerprint } from "@/permissions/canonical-json";
import { PermissionResolutionError } from "@/permissions/errors";
import { fingerprintJson } from "@/storage/regenerable-index";
import { StorageError } from "@/storage/errors";

const shared = { z: 2, a: 1 };
const nullPrototype = Object.assign(Object.create(null), { z: 2, a: "private" });
const symbolProperty = { visible: true, [Symbol("hidden")]: "ignored" };
const sparse = new Array(3);
sparse[1] = "middle";

// Expected byte strings are compatibility fixtures, not an alternative serializer.
// Sparse-array holes and ignored symbol keys deliberately retain the old format.
const fixtures: [string, unknown, string][] = [
  ["null", null, "null"],
  ["boolean", false, "false"],
  ["unicode and escaping", "á\n\"\\", '"á\\n\\"\\\\"'],
  ["negative zero", -0, "0"],
  ["finite number", 1.25, "1.25"],
  ["empty array", [], "[]"],
  ["empty object", {}, "{}"],
  ["nested key order", { z: 3, a: { y: true, x: "value" } }, '{"a":{"x":"value","y":true},"z":3}'],
  ["numeric-looking keys use lexical order", { 2: "two", 10: "ten", 1: "one" }, '{"1":"one","10":"ten","2":"two"}'],
  ["array order", [2, 1, null], "[2,1,null]"],
  ["shared references are not cycles", [shared, shared], '[{"a":1,"z":2},{"a":1,"z":2}]'],
  ["null-prototype object", nullPrototype, '{"a":"private","z":2}'],
  ["symbol property", symbolProperty, '{"visible":true}'],
  ["sparse array", sparse, '[,"middle",]'],
  ["single sparse hole", new Array(1), "[]"],
];

const consumers = [
  { name: "permissions", fingerprint: permissionFingerprint, errorType: PermissionResolutionError, code: "PERMISSION_POLICY_INVALID", prefix: "Canonical permission data" },
  { name: "storage", fingerprint: fingerprintJson, errorType: StorageError, code: "STORAGE_FINGERPRINT_INVALID", prefix: "Fingerprint input" },
] as const;

describe("canonical JSON compatibility", () => {
  it.each(fixtures)("preserves exact permission bytes for %s", (_name, value, expected) => {
    expect(canonicalPermissionJson(value)).toBe(expected);
  });

  describe.each(consumers)("$name fingerprints", consumer => {
    it.each(fixtures)("preserves the SHA256 fingerprint for %s", (_name, value, expected) => {
      expect(consumer.fingerprint(value)).toBe(createHash("sha256").update(expected).digest("hex"));
    });

    it.each([
      ["NaN", (): unknown => Number.NaN, "contains a non-finite number."],
      ["positive infinity", () => Number.POSITIVE_INFINITY, "contains a non-finite number."],
      ["negative infinity", () => Number.NEGATIVE_INFINITY, "contains a non-finite number."],
      ["undefined", (): unknown => undefined, "contains unsupported undefined."],
      ["nested undefined", () => ({ missing: undefined }), "contains unsupported undefined."],
      ["explicit undefined array item", () => [undefined], "contains unsupported undefined."],
      ["function", () => (() => 1), "contains unsupported function."],
      ["bigint", (): unknown => 1n, "contains unsupported bigint."],
      ["symbol", () => Symbol("value"), "contains unsupported symbol."],
      ["Date", () => new Date(0), "must contain only plain objects."],
      ["custom prototype", () => Object.create({ inherited: true }), "must contain only plain objects."],
      ["cyclic object", () => { const value: { self?: unknown } = {}; value.self = value; return value; }, "is cyclic."],
      ["cyclic array", () => { const value: unknown[] = []; value.push(value); return value; }, "is cyclic."],
    ] as const)("preserves the exact domain error for %s", (_name, makeValue, detail) => {
      let error: unknown;
      try { consumer.fingerprint(makeValue()); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(consumer.errorType);
      expect((error as Error).constructor).toBe(consumer.errorType);
      expect(error).toMatchObject({ name: consumer.errorType.name, code: consumer.code, message: `${consumer.prefix} ${detail}` });
    });

    it("preserves exceptions from an input getter without translating them", () => {
      const originalError = new Error("Getter is unavailable");
      const value = { get field() { throw originalError; } };
      let error: unknown;
      try { consumer.fingerprint(value); } catch (caught) { error = caught; }
      expect(error).toBe(originalError);
    });

    it("does not mutate shared input or retain traversal state after failure", () => {
      const nested = Object.freeze({ z: 1, a: 2 });
      const value = Object.freeze([nested, nested]);
      expect(() => consumer.fingerprint({ invalid: undefined })).toThrow();
      const expected = createHash("sha256").update('[{"a":2,"z":1},{"a":2,"z":1}]').digest("hex");
      expect(consumer.fingerprint(value)).toBe(expected);
      expect(consumer.fingerprint(value)).toBe(expected);
      expect(Object.keys(nested)).toEqual(["z", "a"]);
    });
  });
});
