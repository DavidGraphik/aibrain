import type { AuthSession } from "@/auth/types";
import { FileLocalUserStore } from "@/auth/local-user-store";
import type { InstallationConfig } from "@/config/installation-schema";

/** Server-side worker identity, resolved from the current provisioned employee.
 * This is not a login/session cookie and must never be exposed as HTTP authentication.
 */
export async function provisionedAutomationPrincipal(installation: Readonly<InstallationConfig>, userId: string): Promise<AuthSession> {
  const user = await new FileLocalUserStore(installation.paths.usersRoot).read(userId);
  if (!user?.enabled) throw Error("AUTOMATION_MEMBER_NOT_FOUND");
  return { provider: "local", user: { id: user.userId, name: user.displayName, email: user.email },
    tenant: { id: installation.installationId, name: installation.companyName },
    expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
}
