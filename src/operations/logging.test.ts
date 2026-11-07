import { describe, expect, it } from "vitest";
import {
  createOperationalLogger,
  jsonLineOperationalLogSink,
  redactOperationalAttributes,
  type OperationalLogRecord,
} from "@/operations/logging";

describe("operational structured logging", () => {
  it.each([
    "https://brain.example.test/auth/recover?code=one-time-secret&type=recovery",
    "https://brain.example.test/auth/recover?token_hash=one-time-secret&type=recovery",
    "https://brain.example.test/#access_token=one-time-secret&expires_in=3600",
    "/auth/recover?type=recovery&refresh_token=one-time-secret",
    "https://brain.example.test/auth/recover?TOKEN_HASH=one-time-secret",
    "https://brain.example.test/auth/recover?type=recovery&amp;code=one-time-secret",
    "https://brain.example.test/auth/recover?code_verifier=one-time-secret",
    "https://brain.example.test/auth/recover?code_challenge=one-time-secret",
  ])("redacts recovery credentials from URLs while preserving diagnostics: %s", (url) => {
    const attributes = redactOperationalAttributes({ url, status: 400, code: "INVALID_RECOVERY" });
    expect(JSON.stringify(attributes)).not.toContain("one-time-secret");
    expect(attributes).toMatchObject({ status: 400, code: "INVALID_RECOVERY" });
    expect(attributes.url).toContain("[REDACTED]");
  });

  it("redacts structured recovery proofs without treating diagnostic codes as credentials", () => {
    expect(redactOperationalAttributes({
      recoveryId: "private-recovery-id",
      code_verifier: "private-verifier",
      codeChallenge: "private-challenge",
      code: "INVALID_RECOVERY",
    })).toEqual({
      recoveryId: "[REDACTED]",
      code_verifier: "[REDACTED]",
      codeChallenge: "[REDACTED]",
      code: "INVALID_RECOVERY",
    });
  });

  it("recursively redacts credentials, paths, tokens in strings, and error stacks", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const attributes = redactOperationalAttributes({
      authorization: "Bearer direct-secret",
      workspacePath: "/private/company/user",
      nested: {
        password: "hunter2",
        message: "failed with Bearer bearer-secret and token=query-secret",
        url: "https://example.test/?access_token=url-secret&safe=yes",
        proxy: "http://aibrain:proxy-password@egress-gateway:8080/",
      },
      error: Object.assign(new Error("token=error-secret"), { code: "EFAIL" }),
      circular,
    });

    const serialized = JSON.stringify(attributes);
    expect(serialized).not.toContain("direct-secret");
    expect(serialized).not.toContain("/private/company/user");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("bearer-secret");
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("url-secret");
    expect(serialized).not.toContain("proxy-password");
    expect(serialized).not.toContain("error-secret");
    expect(serialized).not.toContain("logging.test.ts");
    expect(attributes).toMatchObject({
      authorization: "[REDACTED]",
      workspacePath: "[PATH_REDACTED]",
      error: { name: "Error", message: "[REDACTED]", code: "EFAIL" },
      circular: { self: "[CIRCULAR]" },
    });
  });

  it("emits a bounded versioned JSON record and rejects unsafe event names", () => {
    const records: OperationalLogRecord[] = [];
    const logger = createOperationalLogger({
      sink: (record) => records.push(record),
      now: () => Date.parse("2026-08-27T10:00:00.000Z"),
      baseAttributes: { installationId: "company-qa" },
    });
    logger.info("soak.started", { concurrency: 4, secret: "hidden" });
    expect(records).toEqual([{
      schemaVersion: 1,
      timestamp: "2026-08-27T10:00:00.000Z",
      level: "info",
      event: "soak.started",
      attributes: { installationId: "company-qa", concurrency: 4, secret: "[REDACTED]" },
    }]);
    expect(() => logger.info("Unsafe event with spaces")).toThrow("lowercase dotted identifiers");
  });

  it("writes exactly one JSON line per record", () => {
    let output = "";
    const sink = jsonLineOperationalLogSink({ write: (value) => { output += String(value); return true; } });
    sink({
      schemaVersion: 1,
      timestamp: "2026-08-27T10:00:00.000Z",
      level: "warn",
      event: "storage.degraded",
      attributes: { code: "DISK_LOW" },
    });
    expect(output.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output)).toMatchObject({ event: "storage.degraded" });
  });
});
