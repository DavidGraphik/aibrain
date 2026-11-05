import { lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { validatedAvatarUrl } from "@/auth/avatar-url";
import { readRegularFileWithin, UnsafeFilePathError } from "@/security/safe-file";
import { atomicWriteJson } from "@/storage/atomic-file";
import {
  defineVersionedSchema,
  expectBoolean,
  expectString,
  parseJson,
} from "@/storage/schema";

export type LocalUser = {
  schemaVersion: 1;
  userId: string;
  email: string;
  displayName: string;
  enabled: boolean;
  workerId: string;
};

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_FILE_MAX_BYTES = 32 * 1024;

type IdentityProfile = { schemaVersion: 1; avatarUrl: string };
const identityProfileSchema = defineVersionedSchema<IdentityProfile>({
  name: "IdentityProfile", schemaVersion: 1, keys: ["avatarUrl"],
  parse(record, context) {
    const avatarUrl = validatedAvatarUrl(record.avatarUrl);
    if (!avatarUrl) context.at("avatarUrl").fail("expected a safe HTTPS avatar URL");
    return { schemaVersion: 1, avatarUrl: avatarUrl as string };
  },
});

export const localUserSchema = defineVersionedSchema<LocalUser>({
  name: "LocalUser",
  schemaVersion: 1,
  keys: ["userId", "email", "displayName", "enabled", "workerId"],
  parse(record, context) {
    const email = expectString(record.email, context.at("email"), {
      minLength: 3,
      maxLength: 320,
      pattern: EMAIL_PATTERN,
    });
    if (email !== email.trim().toLowerCase()) {
      context.at("email").fail("expected a normalized lowercase email address");
    }
    return {
      schemaVersion: 1,
      userId: expectString(record.userId, context.at("userId"), {
        minLength: 36,
        maxLength: 36,
        pattern: USER_ID_PATTERN,
      }),
      email,
      displayName: expectString(record.displayName, context.at("displayName"), {
        minLength: 1,
        maxLength: 120,
      }),
      enabled: expectBoolean(record.enabled, context.at("enabled")),
      workerId: expectString(record.workerId, context.at("workerId"), {
        minLength: 2,
        maxLength: 63,
        pattern: WORKER_ID_PATTERN,
      }),
    };
  },
});

function assertUserId(userId: string) {
  if (!USER_ID_PATTERN.test(userId)) throw new Error("Local user id is invalid.");
}

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export class FileLocalUserStore {
  readonly usersRoot: string;

  constructor(usersRoot: string) {
    if (!path.isAbsolute(usersRoot)) throw new Error("Local users root must be absolute.");
    this.usersRoot = path.resolve(usersRoot);
  }

  private relativeUserPath(userId: string, fileName: string) {
    assertUserId(userId);
    return path.join(userId, fileName);
  }

  async read(userId: string): Promise<LocalUser | null> {
    const relativePath = this.relativeUserPath(userId, "user.json");
    try {
      const contents = await readRegularFileWithin(
        this.usersRoot,
        relativePath,
        USER_FILE_MAX_BYTES,
      );
      const user = parseJson(localUserSchema, contents.toString("utf8"), relativePath);
      if (user.userId !== userId) throw new Error("Local user file does not match its directory.");
      return user;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async readAvatarUrl(userId: string): Promise<string | null> {
    const relativePath = this.relativeUserPath(userId, "identity-profile.json");
    try {
      const contents = await readRegularFileWithin(this.usersRoot, relativePath, 4 * 1024);
      return parseJson(identityProfileSchema, contents.toString("utf8"), relativePath).avatarUrl;
    } catch (error) { if (isMissing(error)) return null; throw error; }
  }

  async saveAvatarUrl(userId: string, avatarUrl: string | null) {
    const safeUrl = validatedAvatarUrl(avatarUrl);
    if (!safeUrl || !await this.read(userId)) return false;
    const root = path.join(this.usersRoot, userId);
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new UnsafeFilePathError("Identity profile directory must be a real directory.");
    await atomicWriteJson(path.join(root, "identity-profile.json"), { schemaVersion: 1, avatarUrl: safeUrl }, identityProfileSchema, { mode: 0o600 });
    return true;
  }

  async hasInitialPasswordMarker(userId: string) {
    const relativePath = this.relativeUserPath(userId, "password-change-required");
    try {
      await readRegularFileWithin(this.usersRoot, relativePath, 1024);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async clearInitialPasswordMarker(userId: string) {
    const relativePath = this.relativeUserPath(userId, "password-change-required");
    const target = path.join(this.usersRoot, relativePath);
    try {
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new UnsafeFilePathError("Password-change marker must be a regular file.");
      }
      await unlink(target);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
}
