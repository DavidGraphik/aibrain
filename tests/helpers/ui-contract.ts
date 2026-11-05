import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

type ContractBundle = {
  $id: string;
  $defs: Record<string, unknown>;
  "x-examples": Array<{ schema: string; value: unknown }>;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const contractPath = path.join(
  repositoryRoot,
  "contracts",
  "aibrain",
  "v1",
  "ui-backend.schema.json",
);

export const uiContract = JSON.parse(readFileSync(contractPath, "utf8")) as ContractBundle;

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
ajv.addKeyword({ keyword: "x-examples", schemaType: "array", valid: true });
ajv.addSchema(uiContract);

const validators = new Map<string, ValidateFunction>();

function validatorFor(schemaName: string) {
  if (!Object.hasOwn(uiContract.$defs, schemaName)) {
    throw new Error(`Unknown AiBrain UI contract schema: ${schemaName}`);
  }
  const existing = validators.get(schemaName);
  if (existing) return existing;
  const validator = ajv.compile({ $ref: `${uiContract.$id}#/$defs/${schemaName}` });
  validators.set(schemaName, validator);
  return validator;
}

export function uiContractErrors(schemaName: string, value: unknown): ErrorObject[] | null {
  const validator = validatorFor(schemaName);
  return validator(value) ? null : (validator.errors ?? []);
}

export function assertUiContract(schemaName: string, value: unknown): void {
  const errors = uiContractErrors(schemaName, value);
  if (errors) {
    throw new Error(
      `AiBrain UI contract ${schemaName} rejected the value:\n${JSON.stringify(errors, null, 2)}`,
    );
  }
}
