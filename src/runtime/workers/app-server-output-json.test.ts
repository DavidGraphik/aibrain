import { afterEach, describe, expect, it, vi } from "vitest";
import { appServerStdoutJsonDiagnostic, parseAppServerStdoutJson } from "./app-server-output-json";
import { gatewayFailureDiagnostic } from "./gateway-failure-diagnostics";

afterEach(() => vi.restoreAllMocks());

function rejected(line: string) {
  try { parseAppServerStdoutJson(line); }
  catch (error) { return error; }
  throw new Error("Expected malformed stdout to remain rejected.");
}

describe("stdout JSON structural diagnostics", () => {
  it.each([
    ["", "empty"], [" \t\r", "empty"],
    ['{"token":"Bearer private-provider-secret",}', "jsonobject"],
    ["[private-provider-secret]", "array"],
    ['"private-provider-secret', "primitive"], ["true-private-provider-secret", "primitive"],
    ["private-provider-secret", "nonjson"], ["\uFEFFprivate-provider-secret", "nonjson"],
  ] as const)("rejects malformed input with only bounded structure (%j)", (line, prefixClass) => {
    const error = rejected(line);
    expect(error).toBeInstanceOf(SyntaxError);
    expect(appServerStdoutJsonDiagnostic(error)).toMatchObject({
      byteCount: Buffer.byteLength(line, "utf8"), prefixClass,
    });
    const receipt = gatewayFailureDiagnostic("stdout-processing", error, 0);
    expect(receipt).toMatchObject({ stage: "stdout-processing", errorType: "SyntaxError", stdoutJson: { prefixClass } });
    expect(JSON.stringify(receipt)).not.toMatch(/private|Bearer|provider-secret|token/);
    expect((error as Error).message).toBe("Worker stdout JSON decoding failed.");
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify(receipt).length).toBeLessThan(512);
  });

  it("passes valid JSON through unchanged, including sensitive-looking payload strings", () => {
    for (const value of [{ id: "reply", result: { accessToken: "Bearer private-provider-secret" } },
      [1, "private-provider-secret"], "private-provider-secret", null, 42, true]) {
      expect(parseAppServerStdoutJson(JSON.stringify(value))).toEqual(value);
      expect(appServerStdoutJsonDiagnostic(value)).toBeUndefined();
    }
  });

  it("extracts only a numeric parser position and discards the native message", () => {
    vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw new SyntaxError('private-provider-secret at position 3 (line 1 column 4)');
    });
    const error = rejected("{bad}");
    expect(appServerStdoutJsonDiagnostic(error)).toEqual({ byteCount: 5, prefixClass: "jsonobject", parsePosition: 3 });
    expect(JSON.stringify(gatewayFailureDiagnostic("stdout-processing", error, 0))).not.toContain("private-provider-secret");
  });

  it("does not mistake digits quoted from input for a native parser position", () => {
    vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw new SyntaxError('Unexpected token, "private at position 3" is not valid JSON');
    });
    expect(appServerStdoutJsonDiagnostic(rejected("{bad}"))?.parsePosition).toBeNull();
  });

  it.each(["9007199254740992", "999999999999999999999999999999", "200"])(
    "does not retain out-of-range parser positions (%s)", position => {
      vi.spyOn(JSON, "parse").mockImplementationOnce(() => { throw new SyntaxError(`at position ${position}`); });
      expect(appServerStdoutJsonDiagnostic(rejected("{bad}"))?.parsePosition).toBeNull();
    },
  );

  it("caps byte counts without retaining a content hash or mutable metadata", () => {
    vi.spyOn(Buffer, "byteLength").mockReturnValueOnce(2 ** 40);
    const diagnostic = appServerStdoutJsonDiagnostic(rejected("{bad}"))!;
    expect(diagnostic.byteCount).toBe(32 * 1024 * 1024);
    expect(Object.keys(diagnostic).sort()).toEqual(["byteCount", "parsePosition", "prefixClass"]);
    expect(Object.isFrozen(diagnostic)).toBe(true);
  });

  it("keeps downstream SyntaxErrors distinguishable and refuses forged decode metadata", () => {
    const error = Object.assign(new SyntaxError("private-provider-secret"), {
      stdoutJson: { byteCount: 1, prefixClass: "private-provider-secret", parsePosition: 0 },
    });
    expect(appServerStdoutJsonDiagnostic(error)).toBeUndefined();
    const receipt = gatewayFailureDiagnostic("stdout-processing", error, 0);
    expect(receipt).not.toHaveProperty("stdoutJson");
    expect(receipt).toMatchObject({ stage: "stdout-processing", errorType: "SyntaxError" });
    expect(JSON.stringify(receipt)).not.toContain("private-provider-secret");
    expect(gatewayFailureDiagnostic("event-delivery", rejected("{bad}"), 0)).not.toHaveProperty("stdoutJson");
  });

  it("does not relabel unexpected non-syntax parser exceptions", () => {
    const error = new TypeError("synthetic parser failure");
    vi.spyOn(JSON, "parse").mockImplementationOnce(() => { throw error; });
    expect(() => parseAppServerStdoutJson("{}")).toThrow(error);
    expect(appServerStdoutJsonDiagnostic(error)).toBeUndefined();
  });
});
