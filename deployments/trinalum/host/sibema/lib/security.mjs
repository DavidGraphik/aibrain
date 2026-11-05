import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";

export function signBody(body, secret) {
  return `${SIGNATURE_PREFIX}${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifySignature(body, signature, secret) {
  if (!Buffer.isBuffer(body) || !secret || typeof signature !== "string") {
    return false;
  }

  const normalized = signature.trim().toLowerCase();
  if (!normalized.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const receivedHex = normalized.slice(SIGNATURE_PREFIX.length);
  if (!/^[a-f0-9]{64}$/.test(receivedHex)) {
    return false;
  }

  const expected = Buffer.from(signBody(body, secret).slice(SIGNATURE_PREFIX.length), "hex");
  const received = Buffer.from(receivedHex, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
