import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileAuthRateLimiter,
  AUTH_RATE_LIMIT_POLICIES,
  authClientIdentifier,
  authRateLimitSubject,
  type AuthRateLimitPolicy,
} from "@/auth/rate-limit";

const roots: string[] = [];
const SECRET = "test-auth-rate-limit-secret-with-32-bytes-minimum";

async function fixture(now = Date.parse("2026-08-27T10:00:00.000Z")) {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-auth-rate-limit-"));
  roots.push(root);
  let currentTime = now;
  const options = {
    rootDirectory: path.join(root, "auth-rate-limits"),
    installationId: "rate-limit-qa",
    secret: SECRET,
    now: () => currentTime,
  };
  return {
    root,
    options,
    limiter: new FileAuthRateLimiter(options),
    advance(milliseconds: number) { currentTime += milliseconds; },
  };
}

function policy(overrides: Partial<AuthRateLimitPolicy> = {}): AuthRateLimitPolicy {
  return {
    operation: "login",
    clientLimit: 2,
    subjectLimit: 2,
    windowMs: 60_000,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileAuthRateLimiter", () => {
  it("keeps the closed auth policy limits explicit", () => {
    expect(AUTH_RATE_LIMIT_POLICIES).toMatchObject({
      login: { clientLimit: 30, subjectLimit: 10, windowMs: 15 * 60_000 },
      "password-reset-request": { clientLimit: 10, subjectLimit: 3, windowMs: 60 * 60_000 },
      "password-recovery-complete": { clientLimit: 20, subjectLimit: 10, windowMs: 60 * 60_000 },
      "initial-password-change": { clientLimit: 20, subjectLimit: 10, windowMs: 60 * 60_000 },
    });
  });

  it("enforces deterministic fixed windows and survives service restart", async () => {
    const { options, limiter, advance } = await fixture();
    const identifiers = { client: "ip:192.0.2.10", subject: "email:person@example.test" };
    expect((await limiter.consume(identifiers, policy())).allowed).toBe(true);
    expect((await new FileAuthRateLimiter(options).consume(identifiers, policy())).allowed).toBe(true);
    const limited = await limiter.consume(identifiers, policy());
    expect(limited.allowed).toBe(false);
    expect(limited.retryAfterSeconds).toBe(60);

    advance(60_000);
    expect((await new FileAuthRateLimiter(options).consume(identifiers, policy())).allowed).toBe(true);
  });

  it("always combines client and subject buckets so spoofing either dimension cannot bypass both", async () => {
    const { limiter } = await fixture();
    const subjectPolicy = policy({ clientLimit: 20, subjectLimit: 1 });
    expect((await limiter.consume({ client: "ip:192.0.2.1", subject: "email:a@example.test" }, subjectPolicy)).allowed)
      .toBe(true);
    expect((await limiter.consume({ client: "ip:192.0.2.2", subject: "email:a@example.test" }, subjectPolicy)).allowed)
      .toBe(false);

    const clientPolicy = policy({ operation: "password-reset-request", clientLimit: 1, subjectLimit: 20 });
    expect((await limiter.consume({ client: "ip:198.51.100.1", subject: "email:b@example.test" }, clientPolicy)).allowed)
      .toBe(true);
    expect((await limiter.consume({ client: "ip:198.51.100.1", subject: "email:c@example.test" }, clientPolicy)).allowed)
      .toBe(false);
  });

  it("serializes concurrent multi-instance attempts without exceeding the configured allowance", async () => {
    const { options } = await fixture();
    const attempts = await Promise.all(Array.from({ length: 30 }, () => (
      new FileAuthRateLimiter(options).consume(
        { client: "ip:203.0.113.7", subject: "token:shared-proof" },
        policy({ clientLimit: 5, subjectLimit: 5 }),
      )
    )));
    expect(attempts.filter(({ allowed }) => allowed)).toHaveLength(5);
  }, 20_000);

  it("stores only HMAC keys and fails closed persistently on corruption", async () => {
    const { options, limiter } = await fixture();
    const rawIp = "203.0.113.44";
    const rawEmail = "private.person@example.test";
    const rawToken = "secret-recovery-token-value";
    await limiter.consume(
      { client: `ip:${rawIp}`, subject: `email:${rawEmail}` },
      policy(),
    );
    await limiter.consume(
      { client: `ip:${rawIp}`, subject: `token:${rawToken}` },
      policy(),
    );
    const filePath = path.join(options.rootDirectory, "login.json");
    const persisted = await readFile(filePath, "utf8");
    expect(persisted).not.toContain(rawIp);
    expect(persisted).not.toContain(rawEmail);
    expect(persisted).not.toContain(rawToken);
    const decoded = JSON.parse(persisted) as { buckets: Array<{ key: string }> };
    expect(decoded.buckets.every(({ key }) => /^[0-9a-f]{64}$/.test(key))).toBe(true);

    await writeFile(filePath, "{not valid json\n");
    await expect(limiter.consume(
      { client: `ip:${rawIp}`, subject: `email:${rawEmail}` },
      policy(),
    )).rejects.toMatchObject({ code: "AUTH_RATE_LIMIT_STORAGE_UNAVAILABLE" });
    await expect(new FileAuthRateLimiter(options).consume(
      { client: "ip:198.51.100.9", subject: "email:other@example.test" },
      policy(),
    )).rejects.toMatchObject({ code: "AUTH_RATE_LIMIT_STORAGE_UNAVAILABLE" });
    expect(await readFile(filePath, "utf8")).toBe("{not valid json\n");
  });

  it("validates proxy IP headers and uses a stable opaque fallback", () => {
    expect(authClientIdentifier(new Request("https://brain.example.test", {
      headers: { "x-real-ip": "192.0.2.7", "x-forwarded-for": "198.51.100.2" },
    }))).toBe("ip:192.0.2.7");
    expect(authClientIdentifier(new Request("https://brain.example.test", {
      headers: { "x-real-ip": "not-an-ip", "x-forwarded-for": "203.0.113.8, 10.0.0.1" },
    }))).toBe("ip:203.0.113.8");
    expect(authClientIdentifier(new Request("https://brain.example.test", {
      headers: { "x-real-ip": "not-an-ip", "x-forwarded-for": "also-invalid" },
    }))).toBe("opaque:unresolved-client-v1");
    expect(authRateLimitSubject("email", " Person@Example.TEST ")).toBe("email:person@example.test");
    expect(authRateLimitSubject("token", undefined)).toBe("token:opaque-missing-v1");
  });

  it("fails closed when its configured root is replaced by a symlink", async () => {
    const { root, options, limiter } = await fixture();
    await limiter.consume(
      { client: "ip:192.0.2.9", subject: "email:person@example.test" },
      policy(),
    );
    await rm(options.rootDirectory, { recursive: true });
    const outside = path.join(root, "outside-rate-state");
    await mkdir(outside);
    await symlink(outside, options.rootDirectory);
    await expect(limiter.consume(
      { client: "ip:192.0.2.9", subject: "email:person@example.test" },
      policy(),
    )).rejects.toMatchObject({ code: "AUTH_RATE_LIMIT_STORAGE_UNAVAILABLE" });
  });
});
