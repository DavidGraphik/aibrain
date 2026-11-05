import {
  operatorDashboardCountingStart,
  operatorDashboardLocalDay,
} from "@/usage/operator-dashboard-period";
import { describe, expect, it } from "vitest";

describe("operator usage dashboard period", () => {
  it("counts each member from the same explicit start as the shared budget", () => {
    expect(operatorDashboardCountingStart(
      "2026-09-20T22:00:00.000Z",
      "2026-09-24T10:23:14.266Z",
    )).toBe(Date.parse("2026-09-24T10:23:14.266Z"));
  });

  it("groups daily usage by Madrid calendar day", () => {
    expect(operatorDashboardLocalDay("2026-09-24T22:30:00.000Z")).toBe("2026-09-25");
  });
});
