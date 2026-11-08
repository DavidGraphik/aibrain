import { describe, expect, it } from "vitest";
import { planThreadArchive } from "@/workbench/archive-planner";
import type { WorkbenchThread } from "@/workbench/types";

function thread(index: number, patch: Partial<WorkbenchThread> = {}): WorkbenchThread {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    projectId: "10000000-0000-4000-8000-000000000001",
    title: `QA test ${index}`,
    status: "active",
    pinned: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    messages: [],
    ...patch,
  };
}

describe("planThreadArchive", () => {
  it("approaches 90% while preserving pinned, recent and substantive conversations", () => {
    const values = Array.from({ length: 100 }, (_, index) => thread(index));
    values[0] = thread(0, { pinned: true });
    values[1] = thread(1, { updatedAt: "2026-09-04T00:00:00.000Z" });
    values[2] = thread(2, { title: "Cliente Arnall propuesta", messages: Array.from({ length: 6 }, (_, index) => ({ id: crypto.randomUUID(), role: index % 2 ? "assistant" : "user", content: "important", createdAt: "2026-01-01T00:00:00.000Z", status: "complete", activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [] })) });
    const plan = planThreadArchive(values, { now: Date.parse("2026-09-05T00:00:00.000Z") });
    expect(plan.totals.archive).toBe(90);
    expect(plan.items.slice(0, 3).every((item) => item.decision === "preserve")).toBe(true);
  });

  it("never exceeds the target even when a safe candidate exists", () => {
    const plan = planThreadArchive([thread(1, { title: "Quarterly strategy", messages: [] })], { now: Date.parse("2026-09-05T00:00:00.000Z") });
    expect(plan.totals.archive).toBe(0);
    expect(plan.items[0].reasons).toContain("target_limit");
  });

  it("rejects invalid planning thresholds instead of producing an unsafe plan", () => {
    expect(() => planThreadArchive([thread(1)], { targetArchiveRatio: 1.1 })).toThrow("between 0 and 1");
    expect(() => planThreadArchive([thread(1)], { recentDays: Number.NaN })).toThrow("non-negative");
  });
});
