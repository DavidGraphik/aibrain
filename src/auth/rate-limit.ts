import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  defineVersionedSchema,
  expectArray,
  expectInteger,
  expectIsoDate,
  expectStrictRecord,
  expectString,
  readValidatedJson,
  ResourceLockManager,
  type ValidationContext,
} from "@/storage";

export type AuthRateLimitOperation =
  | "login"
  | "password-reset-request"
  | "password-recovery-complete"
  | "initial-password-change";

export type AuthRateLimitPolicy = {
  operation: AuthRateLimitOperation;
  clientLimit: number;
  subjectLimit: number;
  windowMs: number;
};

export const AUTH_RATE_LIMIT_POLICIES: Record<AuthRateLimitOperation, AuthRateLimitPolicy> = {
  login: {
    operation: "login",
    clientLimit: 30,
    subjectLimit: 10,
    windowMs: 15 * 60_000,
  },
  "password-reset-request": {
    operation: "password-reset-request",
    clientLimit: 10,
    subjectLimit: 3,
    windowMs: 60 * 60_000,
  },
  "password-recovery-complete": {
    operation: "password-recovery-complete",
    clientLimit: 20,
    subjectLimit: 10,
    windowMs: 60 * 60_000,
  },
  "initial-password-change": {
    operation: "initial-password-change",
    clientLimit: 20,
    subjectLimit: 10,
    windowMs: 60 * 60_000,
  },
};

type RateLimitBucket = {
  key: string;
  windowStartedAt: number;
  count: number;
};

type RateLimitState = {
  schemaVersion: 1;
  operation: AuthRateLimitOperation;
  windowMs: number;
  updatedAt: string;
  buckets: RateLimitBucket[];
};

export type AuthRateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export class AuthRateLimitError extends Error {
  constructor(readonly code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "AuthRateLimitError";
  }
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const OPERATION_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_BUCKETS_PER_OPERATION = 100_000;

function parseBucket(value: unknown, context: ValidationContext): RateLimitBucket {
  const record = expectStrictRecord(value, ["key", "windowStartedAt", "count"], context);
  return {
    key: expectString(record.key, context.at("key"), {
      minLength: 64,
      maxLength: 64,
      pattern: HASH_PATTERN,
    }),
    windowStartedAt: expectInteger(record.windowStartedAt, context.at("windowStartedAt"), {
      minimum: 0,
    }),
    count: expectInteger(record.count, context.at("count"), { minimum: 1, maximum: 1_000_000 }),
  };
}

const rateLimitStateSchema = defineVersionedSchema<RateLimitState>({
  name: "AuthRateLimitState",
  schemaVersion: 1,
  keys: ["operation", "windowMs", "updatedAt", "buckets"],
  parse(record, context) {
    const operation = expectString(record.operation, context.at("operation"), {
      minLength: 2,
      maxLength: 64,
      pattern: OPERATION_PATTERN,
    });
    if (!Object.hasOwn(AUTH_RATE_LIMIT_POLICIES, operation)) {
      context.at("operation").fail("unknown auth rate-limit operation");
    }
    const buckets = expectArray(record.buckets, context.at("buckets"), parseBucket, {
      maxLength: MAX_BUCKETS_PER_OPERATION,
    });
    if (new Set(buckets.map(({ key }) => key)).size !== buckets.length) {
      context.at("buckets").fail("bucket keys must be unique");
    }
    return {
      schemaVersion: 1,
      operation: operation as AuthRateLimitOperation,
      windowMs: expectInteger(record.windowMs, context.at("windowMs"), { minimum: 1_000 }),
      updatedAt: expectIsoDate(record.updatedAt, context.at("updatedAt")),
      buckets,
    };
  },
});

function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return Boolean(
    error && typeof error === "object" && "code" in error
    && (code === undefined || (error as NodeJS.ErrnoException).code === code),
  );
}

function validatePolicy(policy: AuthRateLimitPolicy) {
  if (AUTH_RATE_LIMIT_POLICIES[policy.operation] === undefined) {
    throw new AuthRateLimitError("AUTH_RATE_LIMIT_POLICY_INVALID", "Rate-limit operation is invalid.");
  }
  for (const [name, value] of Object.entries({
    clientLimit: policy.clientLimit,
    subjectLimit: policy.subjectLimit,
    windowMs: policy.windowMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new AuthRateLimitError("AUTH_RATE_LIMIT_POLICY_INVALID", `${name} must be a positive integer.`);
    }
  }
}

export function authClientIdentifier(request: Request) {
  const realIp = request.headers.get("x-real-ip")?.trim() ?? "";
  if (realIp.length <= 64 && isIP(realIp)) return `ip:${realIp.toLowerCase()}`;
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  if (forwarded.length <= 4_096) {
    const first = forwarded.split(",", 1)[0]?.trim() ?? "";
    if (first.length <= 64 && isIP(first)) return `ip:${first.toLowerCase()}`;
  }
  return "opaque:unresolved-client-v1";
}

export function authRateLimitSubject(
  kind: "email" | "code" | "token" | "challenge",
  value: string | undefined,
) {
  const normalized = kind === "email" ? value?.trim().toLowerCase() : value?.trim();
  if (!normalized) return `${kind}:opaque-missing-v1`;
  if (normalized.length > 4_096 || /\p{C}/u.test(normalized)) {
    return `${kind}:opaque-invalid-v1`;
  }
  return `${kind}:${normalized}`;
}

export class FileAuthRateLimiter {
  readonly rootDirectory: string;
  private readonly installationId: string;
  private readonly secret: string;
  private readonly now: () => number;
  private readonly locks: ResourceLockManager;

  constructor(options: {
    rootDirectory: string;
    installationId: string;
    secret: string;
    now?: () => number;
  }) {
    if (!path.isAbsolute(options.rootDirectory)) {
      throw new AuthRateLimitError("AUTH_RATE_LIMIT_CONFIG_INVALID", "rootDirectory must be absolute.");
    }
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(options.installationId)) {
      throw new AuthRateLimitError("AUTH_RATE_LIMIT_CONFIG_INVALID", "installationId is invalid.");
    }
    if (options.secret.length < 32) {
      throw new AuthRateLimitError("AUTH_RATE_LIMIT_CONFIG_INVALID", "Rate-limit HMAC secret is too short.");
    }
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.installationId = options.installationId;
    this.secret = options.secret;
    this.now = options.now ?? Date.now;
    this.locks = new ResourceLockManager({
      rootDirectory: path.join(this.rootDirectory, "locks"),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  private bucketKey(operation: string, scope: "client" | "subject", identifier: string) {
    return createHmac("sha256", this.secret)
      .update("aibrain-auth-rate-limit-v1\0")
      .update(this.installationId).update("\0")
      .update(operation).update("\0")
      .update(scope).update("\0")
      .update(identifier)
      .digest("hex");
  }

  private async prepareRoot() {
    try {
      const parent = path.dirname(this.rootDirectory);
      const parentMetadata = await lstat(parent);
      if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
        throw new AuthRateLimitError(
          "AUTH_RATE_LIMIT_STORAGE_UNAVAILABLE",
          "Rate-limit parent must be a real directory.",
        );
      }
      try {
        await mkdir(this.rootDirectory, { mode: 0o700 });
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
      const metadata = await lstat(this.rootDirectory);
      const [canonicalParent, canonicalRoot] = await Promise.all([
        realpath(parent),
        realpath(this.rootDirectory),
      ]);
      const relative = path.relative(canonicalParent, canonicalRoot);
      if (
        !metadata.isDirectory()
        || metadata.isSymbolicLink()
        || relative === ""
        || relative === ".."
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
      ) {
        throw new AuthRateLimitError(
          "AUTH_RATE_LIMIT_STORAGE_UNAVAILABLE",
          "Rate-limit root must be a real directory.",
        );
      }
      await chmod(this.rootDirectory, 0o700);
    } catch (error) {
      if (error instanceof AuthRateLimitError) throw error;
      throw new AuthRateLimitError(
        "AUTH_RATE_LIMIT_STORAGE_UNAVAILABLE",
        "Rate-limit root is unavailable.",
        { cause: error },
      );
    }
  }

  async consume(
    identifiers: { client: string; subject: string },
    policy: AuthRateLimitPolicy,
  ): Promise<AuthRateLimitResult> {
    validatePolicy(policy);
    if (!identifiers.client || !identifiers.subject) {
      throw new AuthRateLimitError(
        "AUTH_RATE_LIMIT_IDENTIFIERS_INVALID",
        "Both client and subject rate-limit identifiers are required.",
      );
    }
    await this.prepareRoot();
    const filePath = path.join(this.rootDirectory, `${policy.operation}.json`);
    try {
      return await this.locks.withLock(`auth-rate-limit:${this.installationId}:${policy.operation}`, async () => {
        let state: RateLimitState;
        try {
          const metadata = await lstat(filePath);
          if (!metadata.isFile() || metadata.isSymbolicLink()) {
            throw new AuthRateLimitError(
              "AUTH_RATE_LIMIT_STORAGE_UNAVAILABLE",
              "Rate-limit bucket file must be regular.",
            );
          }
          state = await readValidatedJson(filePath, rateLimitStateSchema);
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
          state = {
            schemaVersion: 1,
            operation: policy.operation,
            windowMs: policy.windowMs,
            updatedAt: new Date(this.now()).toISOString(),
            buckets: [],
          };
        }
        if (state.operation !== policy.operation || state.windowMs !== policy.windowMs) {
          throw new AuthRateLimitError(
            "AUTH_RATE_LIMIT_POLICY_MISMATCH",
            "Persisted bucket policy does not match the configured operation.",
          );
        }
        const now = this.now();
        if (!Number.isSafeInteger(now) || now < 0) {
          throw new AuthRateLimitError("AUTH_RATE_LIMIT_CLOCK_INVALID", "Rate-limit clock is invalid.");
        }
        const windowStartedAt = Math.floor(now / policy.windowMs) * policy.windowMs;
        const buckets = state.buckets.filter((bucket) => bucket.windowStartedAt === windowStartedAt);
        const clientKey = this.bucketKey(policy.operation, "client", identifiers.client);
        const subjectKey = this.bucketKey(policy.operation, "subject", identifiers.subject);
        const consumeBucket = (key: string, limit: number) => {
          let bucket = buckets.find((candidate) => candidate.key === key);
          if (!bucket) {
            if (buckets.length >= MAX_BUCKETS_PER_OPERATION) {
              throw new AuthRateLimitError(
                "AUTH_RATE_LIMIT_CAPACITY_EXCEEDED",
                "Rate-limit bucket capacity is exhausted.",
              );
            }
            bucket = { key, windowStartedAt, count: 0 };
            buckets.push(bucket);
          }
          bucket.count = Math.min(limit + 1, bucket.count + 1);
          return bucket.count <= limit;
        };
        const clientAllowed = consumeBucket(clientKey, policy.clientLimit);
        const subjectAllowed = consumeBucket(subjectKey, policy.subjectLimit);
        await atomicWriteJson(filePath, {
          schemaVersion: 1,
          operation: policy.operation,
          windowMs: policy.windowMs,
          updatedAt: new Date(now).toISOString(),
          buckets: buckets.sort((left, right) => left.key.localeCompare(right.key)),
        }, rateLimitStateSchema, { mode: 0o600 });
        return {
          allowed: clientAllowed && subjectAllowed,
          retryAfterSeconds: Math.max(1, Math.ceil((windowStartedAt + policy.windowMs - now) / 1_000)),
        };
      });
    } catch (error) {
      if (error instanceof AuthRateLimitError) throw error;
      throw new AuthRateLimitError(
        "AUTH_RATE_LIMIT_STORAGE_UNAVAILABLE",
        "Rate-limit state could not be verified or persisted.",
        { cause: error },
      );
    }
  }
}
