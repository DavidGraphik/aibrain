import { createHash, timingSafeEqual } from "node:crypto";

const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_LENGTH = 512;

export function configuredOperatorSecret() {
  const secret = (
    process.env.AIBRAIN_OPERATOR_SECRET
    ?? process.env.AIBRAIN_MAINTENANCE_SECRET
    ?? ""
  ).trim();
  return secret.length >= MIN_SECRET_LENGTH
    && secret.length <= MAX_SECRET_LENGTH
    && !/\s/u.test(secret)
    ? secret
    : null;
}

function secureEqual(left: string, right: string) {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

/** Independent host-operator authentication; never accepts an employee session. */
export function isOperatorAuthorized(request: Request) {
  const secret = configuredOperatorSecret();
  if (!secret) return false;
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  return Boolean(match && secureEqual(match[1], secret));
}
