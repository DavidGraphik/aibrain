import "server-only";
import { loadInstallationConfig } from "@/config/installation";
import type { InstallationConfig } from "@/config/installation-schema";
import type { AuthSession } from "@/auth/types";
import { FileUserLanguageStore } from "./user-language-store";
import { FileInstallationLanguageStore } from "./installation-language-store";
export async function installationUiLocale() {
  const installation = await loadInstallationConfig();
  return new FileInstallationLanguageStore(installation.installationId, installation.paths.dataRoot).read();
}

/** Personal UI preference is read only within the authenticated installation. */
export async function userUiLocale(session: AuthSession | null) {
  const installation = await loadInstallationConfig();
  return userUiLocaleForInstallation(installation, session);
}

/** Also used by background turns with their already-validated installation. */
export async function userUiLocaleForInstallation(installation: Readonly<InstallationConfig>, session: AuthSession | null) {
  if (session && session.tenant.id === installation.installationId) {
    const personal = await new FileUserLanguageStore(installation.installationId, installation.paths.dataRoot).read(session.user.id);
    if (personal) return personal;
  }
  return new FileInstallationLanguageStore(installation.installationId, installation.paths.dataRoot).read();
}
