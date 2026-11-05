import test from "node:test";
import assert from "node:assert/strict";
import { decryptToken, encryptToken } from "../lib/token-crypto.mjs";

test("encrypts and decrypts refresh tokens", () => {
  const key = "b".repeat(64);
  const encrypted = encryptToken("refresh-token-value", key);
  assert.notEqual(encrypted, "refresh-token-value");
  assert.equal(decryptToken(encrypted, key), "refresh-token-value");
});

test("rejects an invalid encryption key", () => {
  assert.throws(
    () => encryptToken("refresh-token-value", "too-short"),
    /exactly 32 bytes/,
  );
});
