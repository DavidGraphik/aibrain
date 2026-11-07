import { describe, expect, it } from "vitest";
import { isAutomationSchedule, parseAutomationPatch, type AutomationSchedule } from "./contracts";
import { describeSchedule, nextAfterOccurrence, nextScheduledInstant } from "./schedule";

const zone = "Europe/Madrid";
const now = new Date("2026-11-04T17:00:00Z");
const startAt = "2026-11-09T08:00:00.000Z";
const weekly: AutomationSchedule = {kind: "weekly", weekdays: [1,2,3,4,5], hour: 9, minute: 0, startAt};

describe("inclusive start for recurring automations", () => {
  it("honors Nerea's first Monday with no Thursday, Friday or weekend occurrence", () => {
    expect(nextScheduledInstant(weekly, zone, now)).toBe(startAt);
    for (const date of ["2026-11-05T08:00:00Z", "2026-11-06T08:00:00Z", "2026-11-07T08:00:00Z", "2026-11-08T08:00:00Z"]) {
      expect(nextScheduledInstant(weekly, zone, new Date(date))).toBe(startAt);
    }
    expect(nextScheduledInstant({...weekly, startAt: "2026-11-07T00:00:00.000Z"}, zone, now)).toBe(startAt);
    expect(nextAfterOccurrence(weekly, zone, startAt)).toBe("2026-11-10T08:00:00.000Z");
    expect(nextScheduledInstant({...weekly, startAt: "2026-11-09T08:00:00.001Z"}, zone, now)).toBe("2026-11-10T08:00:00.000Z");
    expect(describeSchedule(weekly, zone)).toContain("Desde");
    const fortnightly: AutomationSchedule = {...weekly, weekdays:[1], intervalWeeks:2, anchorDate:"2026-11-02"};
    expect(nextScheduledInstant(fortnightly, zone, now)).toBe("2026-11-16T08:00:00.000Z");
  });
  it("preserves Madrid daily and weekly wall time over both DST transitions", () => {
    const daily: AutomationSchedule = {kind: "daily", hour: 9, minute: 0, startAt: "2027-03-27T08:00:00.000Z"};
    expect(nextScheduledInstant(daily, zone, now)).toBe(daily.startAt);
    expect(nextAfterOccurrence(daily, zone, daily.startAt!)).toBe("2027-03-28T07:00:00.000Z");
    const autumn = {...weekly, startAt: "2027-10-29T07:00:00.000Z"};
    expect(nextScheduledInstant(autumn, zone, now)).toBe(autumn.startAt);
    expect(nextAfterOccurrence(autumn, zone, autumn.startAt)).toBe("2027-11-01T08:00:00.000Z");
    const gap: AutomationSchedule = {kind: "daily", hour: 2, minute: 30, startAt: "2027-03-28T01:00:00.000Z"};
    expect(nextScheduledInstant(gap, zone, now)).toBe(gap.startAt);
    const overlap: AutomationSchedule = {kind: "daily", hour: 2, minute: 30, startAt: "2027-10-31T01:00:00.000Z"};
    // The standard first-overlap policy does not invent a second occurrence.
    expect(nextScheduledInstant(overlap, zone, now)).toBe("2027-11-01T01:30:00.000Z");
  });
  it("keeps interval phase, future anchor and work window while enforcing startAt", () => {
    const interval: AutomationSchedule = {kind: "interval", minutes: 120, anchorAt: "2026-11-04T08:15:00.000Z", startAt};
    expect(nextScheduledInstant(interval, zone, now)).toBe("2026-11-09T08:15:00.000Z");
    expect(nextScheduledInstant({...interval, startAt: "2026-11-08T08:15:00.000Z", window: {weekdays: [1,2,3,4,5], startHour: 9, endHour: 18}}, zone, now)).toBe("2026-11-09T08:15:00.000Z");
    expect(nextScheduledInstant({...interval, anchorAt: "2026-11-10T08:15:00.000Z"}, zone, now)).toBe("2026-11-10T08:15:00.000Z");
    expect(nextScheduledInstant({...interval, startAt: interval.anchorAt}, zone, now)).toBe("2026-11-04T18:15:00.000Z");
  });
  it.each<AutomationSchedule>([weekly, {kind: "daily", hour: 9, minute: 0, startAt}, {kind: "interval", minutes: 60, anchorAt: startAt, startAt}])("validates startAt strictly and retains legacy schedules: $kind", schedule => {
    expect(isAutomationSchedule(schedule)).toBe(true);
    expect(parseAutomationPatch({schedule})).toEqual({schedule});
    expect(isAutomationSchedule({...schedule, startAt: "2026-02-30T08:00:00.000Z"})).toBe(false);
    expect(isAutomationSchedule({...schedule, startAt: "2026-11-09"})).toBe(false);
    expect(isAutomationSchedule({...schedule, startAt: undefined})).toBe(false);
    expect(isAutomationSchedule({...schedule, unrelated: true})).toBe(false);
    const legacy: Record<string, unknown> = {...schedule}; delete legacy.startAt;
    expect(isAutomationSchedule(legacy)).toBe(true);
  });
});
