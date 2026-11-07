import path from "node:path";
import { lstat, mkdir } from "node:fs/promises";
import { readRegularFileWithin } from "@/security/safe-file";
import { atomicWriteJson } from "@/storage/atomic-file";
import { ResourceLockManager } from "@/storage/resource-lock";
import { defineVersionedSchema, expectOneOf, expectString } from "@/storage/schema";
import { DEFAULT_UI_LOCALE, UI_LOCALES, isUiLocale, type UiLocale } from "./locale";

type LanguageRecord = { schemaVersion: 1; installationId: string; locale: UiLocale; updatedBy: string };
const schema = defineVersionedSchema<LanguageRecord>({
  name: "InstallationLanguage", schemaVersion: 1, keys: ["installationId", "locale", "updatedBy"],
  parse(record, context) { return {
    schemaVersion: 1,
    installationId: expectString(record.installationId, context.at("installationId"), { minLength: 2, maxLength: 63 }),
    locale: expectOneOf(record.locale, UI_LOCALES, context.at("locale")),
    updatedBy: expectString(record.updatedBy, context.at("updatedBy"), { minLength: 1, maxLength: 128 }),
  }; },
});

/** Public presentation preference. The write caller must authorize the administrator. */
export class FileInstallationLanguageStore {
  private readonly locks: ResourceLockManager;
  constructor(private readonly installationId: string, private readonly dataRoot: string) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(installationId) || !path.isAbsolute(dataRoot)) throw new Error("Invalid installation language boundary.");
    this.locks = new ResourceLockManager({ rootDirectory: path.join(dataRoot, "settings", "language-locks") });
  }
  private async validateDirectories(create: boolean) {
    for (const directory of [this.dataRoot, path.join(this.dataRoot, "settings"), path.join(this.dataRoot, "settings", "language-locks")]) {
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
  async read(): Promise<UiLocale> {
    await this.validateDirectories(false);
    try {
      const raw = await readRegularFileWithin(this.dataRoot, "settings/language.json", 4096);
      const record = schema.parse(JSON.parse(raw.toString("utf8")));
      if (record.installationId !== this.installationId) throw new Error("Language record belongs to another installation.");
      return record.locale;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return DEFAULT_UI_LOCALE;
      throw error;
    }
  }
  async write(locale: UiLocale, actorUserId: string) {
    if (!isUiLocale(locale)) throw new Error("Unsupported interface language.");
    await this.validateDirectories(true);
    return this.locks.withLock(`language:${this.installationId}`, async () => {
      await this.read();
      await atomicWriteJson(path.join(this.dataRoot, "settings", "language.json"), {
        schemaVersion: 1, installationId: this.installationId, locale, updatedBy: actorUserId,
      }, schema, { mode: 0o600 });
      return locale;
    });
  }
}
