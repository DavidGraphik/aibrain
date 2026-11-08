/** Structural evidence for the stdout JSON boundary only. Never retain the
 * original line, the native parser's message/cause, or a content-derived hash. */
export type AppServerStdoutJsonDiagnostic = Readonly<{
  byteCount: number;
  prefixClass: "empty" | "jsonobject" | "array" | "primitive" | "nonjson";
  parsePosition: number | null;
}>;

const MAX_DIAGNOSTIC_BYTES = 32 * 1024 * 1024;
const stdoutJsonFailures = new WeakMap<Error, AppServerStdoutJsonDiagnostic>();

function prefixClass(line: string): AppServerStdoutJsonDiagnostic["prefixClass"] {
  // Use JSON whitespace, not trimStart(): a BOM is itself invalid JSON input.
  const first = line.replace(/^[\x20\t\r\n]*/u, "")[0];
  if (first === undefined) return "empty";
  if (first === "{") return "jsonobject";
  if (first === "[") return "array";
  return /["0-9tfn-]/u.test(first) ? "primitive" : "nonjson";
}

export function parseAppServerStdoutJson(line: string) {
  try {
    return JSON.parse(line);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // V8 may quote input in its error message. Extract only a bounded numeric
    // position and replace the error rather than retaining that message/cause.
    const position = /\bat position (\d+)(?: \(line \d+ column \d+\))?$/u.exec(error.message)?.[1];
    const parsed = position === undefined ? NaN : Number(position);
    const failure = new SyntaxError("Worker stdout JSON decoding failed.");
    stdoutJsonFailures.set(failure, Object.freeze({
      byteCount: Math.min(Buffer.byteLength(line, "utf8"), MAX_DIAGNOSTIC_BYTES),
      prefixClass: prefixClass(line),
      parsePosition: Number.isSafeInteger(parsed) && parsed >= 0 &&
        parsed <= Math.min(line.length, MAX_DIAGNOSTIC_BYTES) ? parsed : null,
    }));
    throw failure;
  }
}

/** An unrelated SyntaxError cannot impersonate a stdout decoding failure. */
export function appServerStdoutJsonDiagnostic(error: unknown) {
  return error instanceof Error ? stdoutJsonFailures.get(error) : undefined;
}
