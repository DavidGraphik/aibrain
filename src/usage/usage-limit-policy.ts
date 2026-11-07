import type { InstallationConfig } from "@/config/installation-schema";

export function usageLimitIsUnlimited(
  limits: InstallationConfig["usageLimits"],
  at: number = Date.now(),
) {
  if (!limits?.unlimitedUntil || !Number.isFinite(at)) return false;
  return at < Date.parse(limits.unlimitedUntil);
}
