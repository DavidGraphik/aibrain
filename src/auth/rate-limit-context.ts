import "server-only";

import path from "node:path";
import {
  AUTH_RATE_LIMIT_POLICIES,
  FileAuthRateLimiter,
  authClientIdentifier,
  type AuthRateLimitOperation,
  type AuthRateLimitResult,
} from "@/auth/rate-limit";
import { getSigningSecret } from "@/auth/session";
import { loadInstallationConfig } from "@/config/installation";

export async function checkAuthRateLimit(
  request: Request,
  operation: AuthRateLimitOperation,
  subject: string,
): Promise<AuthRateLimitResult> {
  const installation = await loadInstallationConfig();
  const limiter = new FileAuthRateLimiter({
    rootDirectory: path.join(installation.paths.dataRoot, "auth-rate-limits"),
    installationId: installation.installationId,
    secret: getSigningSecret(),
  });
  return limiter.consume(
    { client: authClientIdentifier(request), subject },
    AUTH_RATE_LIMIT_POLICIES[operation],
  );
}
