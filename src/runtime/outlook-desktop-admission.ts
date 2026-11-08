import "server-only";
import type { AuthSession } from "@/auth/types";
import type { InstallationConfig } from "@/config/installation-schema";
import { readOutlookDesktopStatusForIdentity } from "@/connectors/outlook-desktop-service";

/** Installation enablement is not a paired employee desktop. Offline paired
 * devices remain admissible because their encrypted archive can be readable. */
export async function desktopOutlookAvailableForTurn(config: Readonly<InstallationConfig>, session?: AuthSession | null) {
  if (config.installationId !== "g03-production" || !config.connectors?.mail?.enabled
    || session?.provider !== "local" || session.tenant.id !== config.installationId
    || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) return false;
  try {
    const status = await readOutlookDesktopStatusForIdentity({ config, userId: session.user.id });
    return status.connected === true && "accountEmail" in status && status.accountEmail === session.user.email;
  } catch { return false; }
}
