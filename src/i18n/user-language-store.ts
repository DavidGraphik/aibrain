import "server-only";
import path from "node:path";
import { lstat, mkdir } from "node:fs/promises";
import { readRegularFileWithin } from "@/security/safe-file";
import { atomicWriteJson } from "@/storage/atomic-file";
import { ResourceLockManager } from "@/storage/resource-lock";
import { defineVersionedSchema, expectOneOf, expectString } from "@/storage/schema";
import { UI_LOCALES, isUiLocale, type UiLocale } from "./locale";

type LanguageRecord = { schemaVersion: 1; installationId: string; userId: string; locale: UiLocale };
const schema = defineVersionedSchema<LanguageRecord>({
  name: "UserInterfaceLanguage", schemaVersion: 1, keys: ["installationId", "userId", "locale"],
  parse(record, context) { return {
    schemaVersion: 1,
    installationId: expectString(record.installationId, context.at("installationId"), { minLength: 2, maxLength: 63 }),
    userId: expectString(record.userId, context.at("userId"), { minLength: 1, maxLength: 128 }),
    locale: expectOneOf(record.locale, UI_LOCALES, context.at("locale")),
  }; },
});

/** The caller supplies the authenticated identity, never an identity from request data. */
export class FileUserLanguageStore {
  private readonly locks: ResourceLockManager;
  constructor(private readonly installationId: string, private readonly dataRoot: string) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(installationId) || !path.isAbsolute(dataRoot)) throw new Error("Invalid language settings boundary.");
    this.locks = new ResourceLockManager({ rootDirectory: path.join(dataRoot, "settings", "user-language-locks") });
  }
  private relativePath(userId: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(userId)) throw new Error("Invalid language user identity.");
    return `settings/user-languages/${userId}.json`;
  }
  private async validateDirectories(create: boolean) {
    for (const directory of [this.dataRoot, path.join(this.dataRoot, "settings"), path.join(this.dataRoot, "settings", "user-languages"), path.join(this.dataRoot, "settings", "user-language-locks")]) {
      if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe language settings directory.");
      } catch (error) {
        if (!create && error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
    }
  }
  async read(userId: string): Promise<UiLocale | null> {
    const relative = this.relativePath(userId);
    await this.validateDirectories(false);
    try {
      const raw = await readRegularFileWithin(this.dataRoot, relative, 4096);
      const record = schema.parse(JSON.parse(raw.toString("utf8")));
      if (record.installationId !== this.installationId || record.userId !== userId) throw new Error("Language record belongs to another identity.");
      return record.locale;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }
  async write(userId: string, locale: UiLocale) {
    const relative = this.relativePath(userId);
    if (!isUiLocale(locale)) throw new Error("Unsupported interface language.");
    await this.validateDirectories(true);
    return this.locks.withLock(`user-language:${this.installationId}:${userId}`, async () => {
      await this.read(userId);
      await atomicWriteJson(path.join(this.dataRoot, relative), { schemaVersion: 1, installationId: this.installationId, userId, locale }, schema, { mode: 0o600 });
      return locale;
    });
  }
}
