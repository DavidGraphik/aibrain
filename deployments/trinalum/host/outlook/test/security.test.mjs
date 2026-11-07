import test from "node:test";
import assert from "node:assert/strict";
import { notificationId, validateNotification } from "../lib/security.mjs";

const sample = {
  subscriptionId: "subscription-1",
  changeType: "created",
  resource: "Users/example/Messages/message-1",
  resourceData: { id: "message-1" },
  clientState: "01234567890123456789012345678901",
};

test("validates the notification client state", () => {
  const result = validateNotification(sample, sample.clientState);
  assert.equal(result.ok, true);
  assert.equal(result.notification.id, notificationId(sample));
});

test("rejects a mismatched client state", () => {
  const result = validateNotification(sample, "different-client-state-value-000");
  assert.deepEqual(result, { ok: false, reason: "invalid_client_state" });
});
