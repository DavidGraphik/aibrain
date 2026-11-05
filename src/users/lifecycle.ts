import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import { FileLocalSessionStore } from "@/auth/local-session-store";
import { FileLocalUserStore, localUserSchema } from "@/auth/local-user-store";
import { readRegularFileWithin } from "@/security/safe-file";
import { atomicWriteFile, atomicWriteJson } from "@/storage/atomic-file";
import { FileJournal } from "@/storage/journal";
import { ResourceLockManager } from "@/storage/resource-lock";
import {
  defineVersionedSchema,
  expectBoolean,
  expectInteger,
  expectIsoDate,
  expectOneOf,
  expectString,
  parseJson,
} from "@/storage/schema";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTALLATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RECEIPT_MAX_BYTES = 32 * 1024;

export type UserLifecycleAction = "disable" | "enable" | "recover";

export type UserLifecycleCommand = {
  schemaVersion: 1;
  requestId: string;
  action: UserLifecycleAction;
  userId: string;
};

export type UserLifecycleReceipt = {
  schemaVersion: 1;
  installationId: string;
  requestId: string;
  action: UserLifecycleAction;
  userId: string;
  changed: boolean;
  enabled: boolean;
  sessionsRevoked: number;
  passwordChangeRequired: boolean;
  workerStopped: boolean;
  browserStopped: boolean;
  completedAt: string;
};

export type UserLifecycleResult = UserLifecycleReceipt & { replayed: boolean };

export class UserLifecycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "UserLifecycleError";
  }
}

export const userLifecycleCommandSchema = defineVersionedSchema<UserLifecycleCommand>({
  name: "UserLifecycleCommand",
  schemaVersion: 1,
  keys: ["requestId", "action", "userId"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      requestId: expectString(record.requestId, context.at("requestId"), {
        minLength: 36,
        maxLength: 36,
        pattern: UUID_PATTERN,
      }),
      action: expectOneOf(record.action, ["disable", "enable", "recover"] as const, context.at("action")),
      userId: expectString(record.userId, context.at("userId"), {
        minLength: 36,
        maxLength: 36,
        pattern: UUID_PATTERN,
      }),
    };
  },
});

export const userLifecycleReceiptSchema = defineVersionedSchema<UserLifecycleReceipt>({
  name: "UserLifecycleReceipt",
  schemaVersion: 1,
  keys: [
    "installationId",
    "requestId",
    "action",
    "userId",
    "changed",
    "enabled",
    "sessionsRevoked",
    "passwordChangeRequired",
    "workerStopped",
    "browserStopped",
    "completedAt",
  ],
  parse(record, context) {
    return {
      schemaVersion: 1,
      installationId: expectString(record.installationId, context.at("installationId"), {
        minLength: 2,
        maxLength: 63,
        pattern: INSTALLATION_ID_PATTERN,
      }),
      requestId: expectString(record.requestId, context.at("requestId"), {
        minLength: 36,
        maxLength: 36,
        pattern: UUID_PATTERN,
      }),
      action: expectOneOf(record.action, ["disable", "enable", "recover"] as const, context.at("action")),
      userId: expectString(record.userId, context.at("userId"), {
        minLength: 36,
        maxLength: 36,
        pattern: UUID_PATTERN,
      }),
      changed: expectBoolean(record.changed, context.at("changed")),
      enabled: expectBoolean(record.enabled, context.at("enabled")),
      sessionsRevoked: expectInteger(record.sessionsRevoked, context.at("sessionsRevoked"), { minimum: 0 }),
      passwordChangeRequired: expectBoolean(record.passwordChangeRequired, context.at("passwordChangeRequired")),
      workerStopped: expectBoolean(record.workerStopped, context.at("workerStopped")),
      browserStopped: expectBoolean(record.browserStopped, context.at("browserStopped")),
      completedAt: expectIsoDate(record.completedAt, context.at("completedAt")),
    };
  },
});

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function ensurePrivateDirectory(directory: string) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new UserLifecycleError("USER_LIFECYCLE_PATH_UNSAFE", "Lifecycle path must be a real directory.", 500);
  }
  await chmod(directory, 0o700);
}

export class UserLifecycleService {
  private readonly users: FileLocalUserStore;
  private readonly sessions: FileLocalSessionStore;
  private readonly lockManager: ResourceLockManager;
  private readonly receiptsRoot: string;
  private readonly audit: FileJournal<UserLifecycleReceipt>;

  constructor(
    readonly config: Readonly<InstallationConfig>,
    private readonly runtime: {
      stopWorker?: (userId: string) => Promise<boolean>;
      stopBrowser?: (installationId: string, userId: string) => Promise<boolean>;
    } = {},
    private readonly now: () => number = Date.now,
  ) {
    this.users = new FileLocalUserStore(config.paths.usersRoot);
    this.sessions = new FileLocalSessionStore({
      rootDirectory: path.join(config.paths.dataRoot, "sessions"),
    });
    const operationsRoot = path.join(config.paths.dataRoot, "operations", "user-lifecycle");
    this.receiptsRoot = path.join(operationsRoot, "receipts");
    this.lockManager = new ResourceLockManager({
      rootDirectory: path.join(config.paths.dataRoot, "locks", "user-provisioning"),
    });
    this.audit = new FileJournal({
      filePath: path.join(operationsRoot, "audit.jsonl"),
      lockManager: new ResourceLockManager({
        rootDirectory: path.join(operationsRoot, "locks"),
      }),
      payloadSchema: userLifecycleReceiptSchema,
      now,
    });
  }

  private async ensureRoots() {
    await ensurePrivateDirectory(this.config.paths.dataRoot);
    await ensurePrivateDirectory(path.join(this.config.paths.dataRoot, "operations"));
    await ensurePrivateDirectory(path.join(this.config.paths.dataRoot, "operations", "user-lifecycle"));
    await ensurePrivateDirectory(this.receiptsRoot);
  }

  private async readReceipt(requestId: string) {
    try {
      const data = await readRegularFileWithin(this.receiptsRoot, `${requestId}.json`, RECEIPT_MAX_BYTES);
      return parseJson(userLifecycleReceiptSchema, data.toString("utf8"), `${requestId}.json`);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async requireCompatibleReceipt(command: UserLifecycleCommand) {
    const receipt = await this.readReceipt(command.requestId);
    if (!receipt) return null;
    if (receipt.action !== command.action || receipt.userId !== command.userId) {
      throw new UserLifecycleError(
        "USER_LIFECYCLE_IDEMPOTENCY_CONFLICT",
        "requestId already belongs to another lifecycle command.",
        409,
      );
    }
    return receipt;
  }

  async execute(input: UserLifecycleCommand): Promise<UserLifecycleResult> {
    const command = userLifecycleCommandSchema.parse(input, "user lifecycle command");
    await this.ensureRoots();
    return this.lockManager.withLock(
      `user-provision:${this.config.installationId}:${command.userId}`,
      async () => {
        const replay = await this.requireCompatibleReceipt(command);
        if (replay) return { ...replay, replayed: true };

        const user = await this.users.read(command.userId);
        if (!user) {
          throw new UserLifecycleError("USER_NOT_FOUND", "Provisioned local user was not found.", 404);
        }
        const enabled = command.action !== "disable";
        const changed = user.enabled !== enabled;
        if (changed) {
          await atomicWriteJson(
            path.join(this.config.paths.usersRoot, command.userId, "user.json"),
            { ...user, enabled },
            localUserSchema,
            { mode: 0o600 },
          );
        }

        let passwordChangeRequired = await this.users.hasInitialPasswordMarker(command.userId);
        if (command.action === "recover" && !passwordChangeRequired) {
          await atomicWriteFile(
            path.join(this.config.paths.usersRoot, command.userId, "password-change-required"),
            `${randomUUID()}\n`,
            { mode: 0o600 },
          );
          passwordChangeRequired = true;
        }

        const revokeAccess = command.action === "disable" || command.action === "recover";
        const sessionsRevoked = revokeAccess
          ? await this.sessions.revokeUser(this.config.installationId, command.userId)
          : 0;
        const [workerStopped, browserStopped] = revokeAccess
          ? await Promise.all([
              this.runtime.stopWorker?.(command.userId) ?? false,
              this.runtime.stopBrowser?.(this.config.installationId, command.userId) ?? false,
            ])
          : [false, false];

        const receipt = userLifecycleReceiptSchema.parse({
          schemaVersion: 1,
          installationId: this.config.installationId,
          requestId: command.requestId,
          action: command.action,
          userId: command.userId,
          changed,
          enabled,
          sessionsRevoked,
          passwordChangeRequired,
          workerStopped,
          browserStopped,
          completedAt: new Date(this.now()).toISOString(),
        });
        await this.audit.appendIf(
          receipt,
          (entries) => !entries.some(({ payload }) => payload.requestId === command.requestId),
        );
        await atomicWriteJson(
          path.join(this.receiptsRoot, `${command.requestId}.json`),
          receipt,
          userLifecycleReceiptSchema,
          { mode: 0o600 },
        );
        return { ...receipt, replayed: false };
      },
    );
  }
}
