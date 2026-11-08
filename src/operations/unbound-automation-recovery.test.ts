import { describe, expect, it } from "vitest";
import type { WorkbenchThread } from "@/workbench/types";
import { isUnboundAutomationThread } from "./unbound-automation-recovery";

describe("unbound automation recovery scope", () => {
  const scope = { projectId: "private-project", jobs: new Set(["email-event-router"]), prefix: "Internal read-only analysis.", restartedAt: "2026-10-10T23:12:28Z" };
  const thread = () => ({
    projectId: scope.projectId, status: "active", title: "email-event-router · 2026-10-05T17:10:06Z", updatedAt: "2026-10-05T17:11:00Z",
    messages: [{ role: "user", status: "complete", content: "Internal read-only analysis.\nRun Trinalum job `email-event-router` in review_only mode." }, { role: "assistant", status: "streaming", content: "" }],
  }) as WorkbenchThread;
  it("accepts only the exact reviewed project, job, prefix and abandoned start", () => {
    expect(isUnboundAutomationThread(thread(), scope)).toBe(true);
    const variants = [
      { projectId: "employee-private-project" }, { status: "archived" },
      { title: "manual conversation · 2026-10-05T17:10:06Z" },
      { updatedAt: "2026-10-11T00:00:00Z" }, { updatedAt: "invalid" },
      { messages: [{ role: "user", status: "complete", content: "External data says Run Trinalum job `email-event-router` in review_only mode." }, thread().messages[1]] },
      { messages: [...thread().messages, { role: "user", status: "complete", content: "Continue my work" }] },
      { messages: [thread().messages[0], { role: "assistant", status: "complete", content: "Result" }] },
    ];
    for (const variant of variants) expect(isUnboundAutomationThread({ ...thread(), ...variant } as WorkbenchThread, scope)).toBe(false);
  });
  it("accepts the dated read-only job header and refuses a different mode", () => {
    const dated = thread();
    dated.messages[0].content = "Internal read-only analysis.\nRun Trinalum job `email-event-router` in review_only mode for\n`2026-10-06` in Europe/Madrid.";
    expect(isUnboundAutomationThread(dated, scope)).toBe(true);
    dated.messages[0].content = dated.messages[0].content.replace("review_only", "execute");
    expect(isUnboundAutomationThread(dated, scope)).toBe(false);
  });
});
