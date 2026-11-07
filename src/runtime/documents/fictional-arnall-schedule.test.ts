import { describe, expect, it } from "vitest";
import type { ArnallSchedule } from "./arnall-schedule";
import { reviewFictionalArnallSchedule } from "./fictional-arnall-schedule";

const schedule = (): ArnallSchedule => ({ establishmentId: 1, establishmentName: "Botiga Demo", week: "2026-W40", people: [
  { id: 1, name: "Aina", section: "DEPENDIENTA", codeHours: { M: 5, T: 4, D: 9 }, days: [
    { code: "M", firstLine: "09:00–14:00", secondLine: "" },
    { code: "F", firstLine: "", secondLine: "" },
    { code: "M", firstLine: "09:00–14:00", secondLine: "" },
    { code: "F", firstLine: "", secondLine: "" },
    { code: "M", firstLine: "09:00–14:00", secondLine: "" },
    { code: "F", firstLine: "", secondLine: "" },
    { code: "F", firstLine: "", secondLine: "" },
  ] },
] });

describe("fictional Arnall schedule review", () => {
  it("counts the final grid and rejects missing days or mismatched durations", () => {
    const review = reviewFictionalArnallSchedule(schedule());
    expect(review.totalHours).toBe(15);
    expect(review.people).toEqual([{ name: "Aina", workDays: 3, shifts: { M: 3, T: 0, D: 0 }, hours: 15 }]);
    expect(review.coverage[0]).toEqual({ day: "Lunes", morning: 1, afternoon: 0 });
    const base = schedule();
    expect(() => reviewFictionalArnallSchedule({ ...base, people: [{ ...base.people[0], days: [null, ...base.people[0].days.slice(1)] }] }))
      .toThrow("días sin marcar");
    expect(() => reviewFictionalArnallSchedule({ ...base, people: [{ ...base.people[0], days: [
      { code: "M", firstLine: "09:00–13:00", secondLine: "" }, ...base.people[0].days.slice(1),
    ] }] })).toThrow("no coincide");
  });
});

it("rejects a final fictional grid above 40 or a reduced maximum", () => {
  const base = schedule(), person = base.people[0];
  const days = Array(7).fill({ code: "M", firstLine: "09:00–16:00", secondLine: "" });
  expect(() => reviewFictionalArnallSchedule({ ...base, people: [{ ...person, codeHours: { M: 7, T: 6, D: 10 }, days }] })).toThrow("supera el máximo");
  expect(() => reviewFictionalArnallSchedule({ ...base, people: [{ ...person, maxWeeklyHours: 10 }] })).toThrow("supera el máximo");
});
