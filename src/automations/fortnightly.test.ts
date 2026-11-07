import { describe, expect, it } from 'vitest';
import { isAutomationSchedule } from './contracts';
import { nextScheduledInstant, describeSchedule } from './schedule';
const schedule={kind:'weekly' as const,weekdays:[1],hour:9,minute:0,intervalWeeks:2 as const,anchorDate:'2026-10-05'};
describe('Fortnightly schedules',()=>{
 it('keeps alternate calendar weeks across Madrid DST',()=>{expect(nextScheduledInstant(schedule,'Europe/Madrid',new Date('2026-10-05T07:00:00Z'))).toBe('2026-10-19T07:00:00.000Z');expect(nextScheduledInstant(schedule,'Europe/Madrid',new Date('2026-10-19T07:00:00Z'))).toBe('2026-11-02T08:00:00.000Z');});
 it('validates anchor and interval together and preserves weekly defaults',()=>{expect(isAutomationSchedule(schedule)).toBe(true);expect(isAutomationSchedule({...schedule,anchorDate:'2026-02-30'})).toBe(false);expect(isAutomationSchedule({...schedule,intervalWeeks:3})).toBe(false);expect(isAutomationSchedule({kind:'weekly',weekdays:[1],hour:9,minute:0})).toBe(true);expect(describeSchedule(schedule,'Europe/Madrid','ca')).toContain('Cada dues setmanes');});
});
