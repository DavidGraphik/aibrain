import { describe, expect, it } from "vitest";
import {
  forgetManagedAppAction,
  managedAppActionForApproval,
  rememberManagedAppAction,
} from "@/components/brain-app";
import type { ManagedAppActionDescriptor } from "@/ui/codex-managed-app-ui";

const descriptorA: ManagedAppActionDescriptor = {
  operation: "execute-allowlisted-action",
  locator: { threadId: "thread-a", turnId: "turn-a", itemId: "turn-a", approvalId: "approval-a" },
  authorizationFingerprint: "a".repeat(64),
  approval: {
    id: "approval-a", threadId: "thread-a", turnId: "turn-a", itemId: "turn-a",
    kind: "command", title: "Confirmar acción conectada", detail: "Acción conectada pendiente.", status: "pending",
  },
};

describe("BrainApp managed-app approval registry", () => {
  it("keeps thread A's connector descriptor while navigating A → B → A", () => {
    const beforeNavigation = rememberManagedAppAction({}, descriptorA);
    const activeThreadB = "thread-b";
    expect(activeThreadB).toBe("thread-b");
    expect(managedAppActionForApproval(beforeNavigation, descriptorA.approval)).toBe(descriptorA);

    const afterReturningToA = beforeNavigation;
    expect(managedAppActionForApproval(afterReturningToA, descriptorA.approval)).toBe(descriptorA);
  });

  it("removes a connector descriptor only after a terminal resolution", () => {
    const pending = rememberManagedAppAction({}, descriptorA);
    const retainedAfterRecoverableFailure = pending;
    expect(managedAppActionForApproval(retainedAfterRecoverableFailure, descriptorA.approval)).toBe(descriptorA);

    const resolved = forgetManagedAppAction(retainedAfterRecoverableFailure, descriptorA.approval);
    expect(managedAppActionForApproval(resolved, descriptorA.approval)).toBeNull();
  });
});
