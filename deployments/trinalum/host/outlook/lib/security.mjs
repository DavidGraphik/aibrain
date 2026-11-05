import { createHash, timingSafeEqual } from "node:crypto";

export function matchesClientState(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function notificationId(notification) {
  const stable = JSON.stringify({
    subscriptionId: notification.subscriptionId,
    changeType: notification.changeType,
    resource: notification.resource,
    resourceDataId: notification.resourceData?.id ?? null,
    tenantId: notification.tenantId ?? null,
  });
  return createHash("sha256").update(stable).digest("hex");
}

export function validateNotification(notification, clientState) {
  if (!notification || typeof notification !== "object") {
    return { ok: false, reason: "invalid_notification" };
  }
  if (!matchesClientState(notification.clientState, clientState)) {
    return { ok: false, reason: "invalid_client_state" };
  }
  if (
    typeof notification.subscriptionId !== "string" ||
    typeof notification.changeType !== "string" ||
    typeof notification.resource !== "string"
  ) {
    return { ok: false, reason: "missing_fields" };
  }
  return {
    ok: true,
    notification: {
      id: notificationId(notification),
      subscriptionId: notification.subscriptionId,
      changeType: notification.changeType,
      resource: notification.resource,
      resourceData: notification.resourceData ?? {},
      payload: notification,
    },
  };
}
