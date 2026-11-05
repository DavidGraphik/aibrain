import { describe, expect, it } from 'vitest';
import { isAutomationSchedule, type AutomationSchedule } from './contracts';
import { describeSchedule, nextAfterOccurrence, nextScheduledInstant } from './schedule';

describe('calendar reminders requested by Trinalum employees', () => {
  it('continues monthly beyond a finite year and keeps Madrid wall-clock time across DST', () => {
    const schedule: AutomationSchedule = { kind: 'monthly', months: [1,2,3,4,5,6,7,8,9,10,11,12], day: 2, hour: 9, minute: 0 };
    expect(isAutomationSchedule(schedule)).toBe(true);
    expect(nextScheduledInstant(schedule, 'Europe/Madrid', new Date('2026-10-26T10:00:00Z'))).toBe('2026-11-02T08:00:00.000Z');
    expect(nextAfterOccurrence(schedule, 'Europe/Madrid', '2027-03-02T08:00:00.000Z')).toBe('2027-04-02T07:00:00.000Z');
    expect(nextAfterOccurrence(schedule, 'Europe/Madrid', '2027-10-02T07:00:00.000Z')).toBe('2027-11-02T08:00:00.000Z');
    expect(nextAfterOccurrence(schedule, 'Europe/Madrid', '2027-12-02T08:00:00.000Z')).toBe('2028-01-02T08:00:00.000Z');
    expect(describeSchedule(schedule, 'Europe/Madrid')).toContain('cada mes');
  });
  it('continues a quarterly CBAM request with its exact requested months', () => {
    const schedule: AutomationSchedule = { kind: 'monthly', months: [2,5,8,11], day: 1, hour: 9, minute: 0 };
    expect(nextAfterOccurrence(schedule, 'Europe/Madrid', '2027-11-01T08:00:00.000Z')).toBe('2028-02-01T08:00:00.000Z');
    expect(nextAfterOccurrence(schedule, 'Europe/Madrid', '2028-02-01T08:00:00.000Z')).toBe('2028-05-01T07:00:00.000Z');
  });
  it('does not move an explicitly requested day 31 to a different day', () => {
    const schedule: AutomationSchedule = { kind: 'monthly', months: [1,2,3,4,5,6,7,8,9,10,11,12], day: 31, hour: 9, minute: 0 };
    expect(nextAfterOccurrence(schedule, 'Europe/Madrid', '2027-01-31T08:00:00.000Z')).toBe('2027-03-31T07:00:00.000Z');
    expect(isAutomationSchedule({...schedule, months: [2,2]})).toBe(false);
    expect(isAutomationSchedule({...schedule, months: [0]})).toBe(false);
    expect(isAutomationSchedule({...schedule, day: 32})).toBe(false);
  });
  it('does not run a half-hour mailbox reminder at night or over the weekend', () => {
    const schedule: AutomationSchedule = { kind: 'interval', minutes: 30, anchorAt: '2026-10-22T06:00:00.000Z', window: { weekdays: [1,2,3,4,5], startHour: 8, endHour: 18 } };
    expect(isAutomationSchedule(schedule)).toBe(true);
    expect(nextScheduledInstant(schedule, 'Europe/Madrid', new Date('2026-10-23T15:30:00Z'))).toBe('2026-10-26T07:00:00.000Z');
    expect(nextAfterOccurrence(schedule, 'Europe/Madrid', '2026-10-26T07:00:00.000Z')).toBe('2026-10-26T07:30:00.000Z');
    expect(isAutomationSchedule({...schedule, window:{...schedule.window!,endHour:8}})).toBe(false);
  });
});

it('starts a quarterly calendar on the requested first February, without a November no-op, and preserves DST',()=>{
 const schedule:AutomationSchedule={kind:'monthly',months:[2,5,8,11],day:1,hour:9,minute:0,startAt:'2027-02-01T08:00:00.000Z'};
 expect(isAutomationSchedule(schedule)).toBe(true);
 expect(nextScheduledInstant(schedule,'Europe/Madrid',new Date('2026-10-26T11:00:00Z'))).toBe('2027-02-01T08:00:00.000Z');
 expect(nextAfterOccurrence(schedule,'Europe/Madrid','2027-02-01T08:00:00.000Z')).toBe('2027-05-01T07:00:00.000Z');
 expect(nextAfterOccurrence(schedule,'Europe/Madrid','2027-08-01T07:00:00.000Z')).toBe('2027-11-01T08:00:00.000Z');
 expect(nextScheduledInstant({...schedule,startAt:'2027-02-01T08:00:00.001Z'},'Europe/Madrid',new Date('2026-10-26T11:00:00Z'))).toBe('2027-05-01T07:00:00.000Z');
 expect(isAutomationSchedule({...schedule,startAt:'2027-02-30T08:00:00.000Z'})).toBe(false);
});
