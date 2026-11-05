import { createHash, timingSafeEqual } from "node:crypto";
export function isUsageDashboardAuthorized(request: Request) {
  const secret = (process.env.AIBRAIN_USAGE_DASHBOARD_SECRET ?? "").trim();
  const match = /^Bearer ([^\s]+)$/u.exec(request.headers.get("authorization") ?? "");
  if (secret.length < 32 || secret.length > 512 || /\s/u.test(secret) || !match) return false;
  return timingSafeEqual(createHash("sha256").update(secret).digest(), createHash("sha256").update(match[1]).digest());
}
