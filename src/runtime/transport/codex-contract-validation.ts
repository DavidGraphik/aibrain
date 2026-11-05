import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import clientNotificationSchema from "../../../contracts/codex/0.162.1/schema/ClientNotification.json";
import clientRequestSchema from "../../../contracts/codex/0.162.1/schema/ClientRequest.json";
import serverNotificationSchema from "../../../contracts/codex/0.162.1/schema/ServerNotification.json";
import serverRequestSchema from "../../../contracts/codex/0.162.1/schema/ServerRequest.json";

export class CodexContractValidationError extends Error {
  readonly code = "TRANSPORT_CODEX_CONTRACT_INVALID";
}

const validator = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

const clientRequest = validator.compile(clientRequestSchema);
const clientNotification = validator.compile(clientNotificationSchema);
const serverRequest = validator.compile(serverRequestSchema);
const serverNotification = validator.compile(serverNotificationSchema);

function summarize(errors: ErrorObject[] | null | undefined) {
  return (errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath || "$"} ${error.message ?? error.keyword}`)
    .join("; ");
}

function assertContract(
  validate: ValidateFunction,
  value: unknown,
  contractName: string,
): void {
  if (!validate(value)) {
    throw new CodexContractValidationError(
      `${contractName} violates the pinned Codex 0.162.1 schema: ${summarize(validate.errors)}`,
    );
  }
}

export function assertCodexClientRequest(value: unknown) {
  assertContract(clientRequest, value, "ClientRequest");
}

export function assertCodexClientNotification(value: unknown) {
  assertContract(clientNotification, value, "ClientNotification");
}

export function assertCodexServerRequest(value: unknown) {
  assertContract(serverRequest, value, "ServerRequest");
}

export function assertCodexServerNotification(value: unknown) {
  assertContract(serverNotification, value, "ServerNotification");
}
