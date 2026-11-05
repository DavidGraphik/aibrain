import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function encryptToken(value, encodedKey) {
  if (!value) throw new Error("A token value is required");
  const key = decodeKey(encodedKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptToken(payload, encodedKey) {
  const [version, ivValue, tagValue, ciphertextValue, extra] =
    String(payload ?? "").split(".");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue || extra) {
    throw new Error("Invalid encrypted token payload");
  }
  const key = decodeKey(encodedKey);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function decodeKey(value) {
  const text = String(value ?? "").trim();
  const key = /^[a-f0-9]{64}$/i.test(text)
    ? Buffer.from(text, "hex")
    : Buffer.from(text, "base64");
  if (key.length !== 32) {
    throw new Error("OUTLOOK_TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes");
  }
  return key;
}
