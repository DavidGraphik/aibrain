import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "@/storage/atomic-file";
import { ResourceLockManager } from "@/storage/resource-lock";
import {
  defineVersionedSchema,
  expectBoolean,
  expectStrictRecord,
} from "@/storage/schema";
import {
  CONTROLLABLE_APP_IDS,
  type ControllableAppId,
  type NotificationSettings,
} from "@/settings/contracts";

type AppSwitches = Record<ControllableAppId, boolean>;

export type UserSettingsRecord = {
  schemaVersion: 1;
  apps: AppSwitches;
  notifications: NotificationSettings;
};

export type InstallationAppPolicy = {
  schemaVersion: 1;
  apps: AppSwitches;
};

const defaultSwitches = (): AppSwitches => ({
  "web-search": true,
  "image-generation": true,
  skills: true,
  "managed-browser": true,
});

export const defaultUserSettings = (): UserSettingsRecord => ({
  schemaVersion: 1,
  apps: defaultSwitches(),
  notifications: {
    backgroundTurns: true,
    approvals: true,
    failures: true,
    sound: false,
  },
});

export const defaultInstallationAppPolicy = (): InstallationAppPolicy => ({
  schemaVersion: 1,
  apps: defaultSwitches(),
});

function parseSwitches(value: unknown, context: Parameters<typeof expectStrictRecord>[2]) {
  const record = expectStrictRecord(value, CONTROLLABLE_APP_IDS, context);
  return Object.fromEntries(CONTROLLABLE_APP_IDS.map((id) => [
    id,
    expectBoolean(record[id], context.at(id)),
  ])) as AppSwitches;
}

const userSettingsSchema = defineVersionedSchema<UserSettingsRecord>({
  name: "UserSettings",
  schemaVersion: 1,
  keys: ["apps", "notifications"],
  parse(record, context) {
    const notificationRecord = expectStrictRecord(record.notifications, [
      "backgroundTurns", "approvals", "failures", "sound",
    ], context.at("notifications"));
    return {
      schemaVersion: 1,
      apps: parseSwitches(record.apps, context.at("apps")),
      notifications: {
        backgroundTurns: expectBoolean(notificationRecord.backgroundTurns, context.at("notifications").at("backgroundTurns")),
        approvals: expectBoolean(notificationRecord.approvals, context.at("notifications").at("approvals")),
        failures: expectBoolean(notificationRecord.failures, context.at("notifications").at("failures")),
        sound: expectBoolean(notificationRecord.sound, context.at("notifications").at("sound")),
      },
    };
  },
});

const installationPolicySchema = defineVersionedSchema<InstallationAppPolicy>({
  name: "InstallationAppPolicy",
  schemaVersion: 1,
  keys: ["apps"],
  parse(record, context) {
    return { schemaVersion: 1, apps: parseSwitches(record.apps, context.at("apps")) };
  },
});

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function readOrDefault<T>(filePath: string, schema: { parse(value: unknown, source?: string): T }, fallback: () => T) {
  try {
    return schema.parse(JSON.parse(await readFile(filePath, "utf8")) as unknown, filePath);
  } catch (error) {
    if (isMissing(error)) return fallback();
    throw error;
  }
}

export class FileSettingsStore {
  private readonly locks: ResourceLockManager;

  constructor(
    private readonly dataRoot: string,
    private readonly usersRoot: string,
  ) {
    if (!path.isAbsolute(dataRoot) || !path.isAbsolute(usersRoot)) {
      throw new Error("Settings roots must be absolute.");
    }
    this.locks = new ResourceLockManager({
      rootDirectory: path.join(dataRoot, "settings", "locks"),
      defaultTimeoutMs: 5_000,
    });
  }

  private userPath(userId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(userId)) {
      throw new Error("Settings user id is invalid.");
    }
    return path.join(this.usersRoot, userId, "settings.json");
  }

  private installationPath() {
    return path.join(this.dataRoot, "settings", "apps.json");
  }

  readUser(userId: string) {
    return readOrDefault(this.userPath(userId), userSettingsSchema, defaultUserSettings);
  }

  readInstallation() {
    return readOrDefault(this.installationPath(), installationPolicySchema, defaultInstallationAppPolicy);
  }

  async updateUser(userId: string, update: (current: UserSettingsRecord) => UserSettingsRecord) {
    return this.locks.withLock(`settings:user:${userId}`, async () => {
      const next = userSettingsSchema.parse(update(await this.readUser(userId)));
      await atomicWriteJson(this.userPath(userId), next, userSettingsSchema, { mode: 0o600 });
      return next;
    });
  }

  async updateInstallation(update: (current: InstallationAppPolicy) => InstallationAppPolicy) {
    return this.locks.withLock("settings:installation-apps", async () => {
      const next = installationPolicySchema.parse(update(await this.readInstallation()));
      await atomicWriteJson(this.installationPath(), next, installationPolicySchema, { mode: 0o600 });
      return next;
    });
  }
}
