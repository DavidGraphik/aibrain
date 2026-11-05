import { appServerStdoutJsonDiagnostic } from "./app-server-output-json";

/** Structural diagnostics only: no error messages, paths, provider bodies,
 * prompts, stdout, stderr or credentials may enter this durable receipt. */
export type GatewayFailureStage = "child-error" | "child-exit" | "stdout-limit" | "stdout-processing" | "auth-refresh" | "event-delivery";
const ERROR_NAMES = new Set(["Error", "SyntaxError", "TypeError", "StorageError", "StorageCorruptionError", "SchemaValidationError", "ResourceLockTimeoutError", "ResourceLockOwnershipLostError", "TransportProtocolError"]);
const ERROR_CODES = new Set(["EACCES", "EPERM", "ENOENT", "ENOSPC", "EIO", "EMFILE", "ENFILE", "EPIPE", "EBADF", "EEXIST", "EROFS", "ERR_STREAM_DESTROYED", "ERR_STREAM_PREMATURE_CLOSE", "STORAGE_CORRUPT", "STORAGE_SCHEMA_INVALID", "STORAGE_LOCK_TIMEOUT", "STORAGE_LOCK_OWNERSHIP_LOST"]);
function code(error:unknown):string|null {
 const value = error && typeof error === "object" && "code" in error ? error.code : null;
 return typeof value === "string" && ERROR_CODES.has(value) ? value : null;
}
export function gatewayFailureDiagnostic(stage:GatewayFailureStage,error:unknown,now:number,exit?:{code:number|null;signal:NodeJS.Signals|null}) {
 const cause=error && typeof error === "object" && "cause" in error ? error.cause : null;
 const stdoutJson=stage === "stdout-processing" ? appServerStdoutJsonDiagnostic(error) : undefined;
 return {schemaVersion:1,occurredAt:new Date(now).toISOString(),stage,
  errorType:error instanceof Error && ERROR_NAMES.has(error.name)?error.name:"unknown",
  code:code(error),causeCode:code(cause),
  ...(stdoutJson ? {stdoutJson} : {}),
  ...(exit?{exitCode:Number.isSafeInteger(exit.code)?exit.code:null,signal:exit.signal && ["SIGKILL","SIGTERM","SIGABRT","SIGSEGV","SIGBUS","SIGILL","SIGFPE","SIGPIPE"].includes(exit.signal)?exit.signal:null}:{})};
}
