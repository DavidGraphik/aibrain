import { describe, expect, it } from "vitest";
import { SchemaValidationError } from "@/storage/errors";
import {
  defineVersionedSchema,
  expectArray,
  expectInteger,
  expectStrictRecord,
  expectString,
  parseJson,
} from "@/storage/schema";

type TestDocument = {
  schemaVersion: 1;
  name: string;
  values: number[];
};

const testDocumentSchema = defineVersionedSchema<TestDocument>({
  name: "TestDocument",
  schemaVersion: 1,
  keys: ["name", "values"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      name: expectString(record.name, context.at("name"), { minLength: 1, maxLength: 20 }),
      values: expectArray(
        record.values,
        context.at("values"),
        (value, itemContext) => expectInteger(value, itemContext, { minimum: 0 }),
      ),
    };
  },
});

describe("versioned storage schemas", () => {
  it("parses an exact object and rejects unknown properties", () => {
    expect(testDocumentSchema.parse({ schemaVersion: 1, name: "alpha", values: [1, 2] }))
      .toEqual({ schemaVersion: 1, name: "alpha", values: [1, 2] });

    expect(() => testDocumentSchema.parse({
      schemaVersion: 1,
      name: "alpha",
      values: [],
      injected: true,
    })).toThrow(/unexpected properties: injected/);
  });

  it.each([
    [{ name: "alpha", values: [] }, /missing properties: schemaVersion/],
    [{ schemaVersion: 2, name: "alpha", values: [] }, /expected literal 1/],
    [{ schemaVersion: 1, name: "", values: [] }, /at least 1 characters/],
    [{ schemaVersion: 1, name: "alpha", values: [-1] }, /expected a value >= 0/],
  ])("fails closed for invalid versioned values", (value, message) => {
    expect(() => testDocumentSchema.parse(value)).toThrow(message);
  });

  it("includes the nested validation path and source", () => {
    try {
      testDocumentSchema.parse(
        { schemaVersion: 1, name: "alpha", values: [1, "bad"] },
        "/var/lib/aibrain/test.json",
      );
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect(error).toMatchObject({
        code: "STORAGE_SCHEMA_INVALID",
        schemaName: "TestDocument",
        validationPath: "$.values[1]",
      });
      expect((error as Error).message).toContain("/var/lib/aibrain/test.json");
    }
  });

  it("rejects invalid JSON and non-plain objects", () => {
    expect(() => parseJson(testDocumentSchema, "{broken", "broken.json"))
      .toThrow(/invalid JSON/);

    class DocumentClass {
      schemaVersion = 1;
      name = "alpha";
      values: number[] = [];
    }
    expect(() => testDocumentSchema.parse(new DocumentClass())).toThrow(/plain object/);
  });

  it("rejects duplicate schema declarations at construction time", () => {
    expect(() => defineVersionedSchema<TestDocument>({
      name: "DuplicateKeys",
      schemaVersion: 1,
      keys: ["name", "name", "values"],
      parse(record, context) {
        const exact = expectStrictRecord(record, ["schemaVersion", "name", "values"], context);
        return {
          schemaVersion: 1,
          name: String(exact.name),
          values: [],
        };
      },
    })).toThrow(/duplicate schema keys/);
  });
});
