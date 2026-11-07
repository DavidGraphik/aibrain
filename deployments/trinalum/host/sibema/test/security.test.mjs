import test from "node:test";
import assert from "node:assert/strict";
import { signBody, verifySignature } from "../lib/security.mjs";

test("signs and verifies the raw request body", () => {
  const body = Buffer.from('{"event_id":"evt-1"}');
  const secret = "a".repeat(64);
  const signature = signBody(body, secret);
  assert.equal(verifySignature(body, signature, secret), true);
  assert.equal(verifySignature(Buffer.from('{"event_id":"evt-2"}'), signature, secret), false);
});

test("rejects malformed signatures", () => {
  const body = Buffer.from("{}");
  const secret = "b".repeat(64);
  assert.equal(verifySignature(body, "invalid", secret), false);
  assert.equal(verifySignature(body, "sha256=1234", secret), false);
});
