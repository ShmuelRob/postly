import { describe, expect, it } from 'vitest';
import { localWeek } from './week.js';

// The business week (technical-design.md, Operational defaults): Sunday 00:00 to Saturday 23:59 in
// the business's timezone.

describe('localWeek', () => {
  it('starts the week on the local Sunday', () => {
    // Tuesday 2026-11-03 09:30 in Jerusalem (UTC+2).
    expect(localWeek(new Date('2026-11-03T07:30:00Z'), 'Asia/Jerusalem')).toEqual({
      weekStart: '2026-11-01',
      nextWeekStart: '2026-11-08',
      day: 2,
      minutes: 9 * 60 + 30,
    });
  });

  it('uses the local date, not the UTC date, around midnight', () => {
    // Saturday 23:30 UTC is already Sunday 01:30 in Jerusalem: a new week.
    expect(localWeek(new Date('2026-11-07T23:30:00Z'), 'Asia/Jerusalem')).toMatchObject({ weekStart: '2026-11-08', day: 0, minutes: 90 });
    expect(localWeek(new Date('2026-11-07T23:30:00Z'), 'UTC')).toMatchObject({ weekStart: '2026-11-01', day: 6 });
  });

  it('crosses month and year ends', () => {
    expect(localWeek(new Date('2027-01-01T12:00:00Z'), 'Asia/Jerusalem')).toMatchObject({ weekStart: '2026-12-27', nextWeekStart: '2027-01-03', day: 5 });
  });
});
