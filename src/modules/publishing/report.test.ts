import { describe, expect, it } from 'vitest';
import { previousMonth } from './report.js';

// The monthly report's month is the business's calendar month (review of PR #54, item 4).
describe('previousMonth', () => {
  it('is local midnight to local midnight in Israel (winter, UTC+2)', () => {
    expect(previousMonth(new Date('2026-12-01T06:00:00Z'), 'Asia/Jerusalem')).toEqual({
      from: new Date('2026-10-31T22:00:00Z'),
      to: new Date('2026-11-30T22:00:00Z'),
    });
  });

  it('follows the clock change inside the month (October: summer start, winter end)', () => {
    expect(previousMonth(new Date('2026-11-01T06:00:00Z'), 'Asia/Jerusalem')).toEqual({
      from: new Date('2026-09-30T21:00:00Z'),
      to: new Date('2026-10-31T22:00:00Z'),
    });
  });

  it('uses the local month at the run time: just after local midnight on the 1st is already the new month', () => {
    // 2026-11-30T22:30Z is 00:30 on December 1st in Israel, so November is the previous month.
    expect(previousMonth(new Date('2026-11-30T22:30:00Z'), 'Asia/Jerusalem').from).toEqual(new Date('2026-10-31T22:00:00Z'));
  });

  it('crosses the year', () => {
    expect(previousMonth(new Date('2027-01-01T06:00:00Z'), 'UTC')).toEqual({ from: new Date('2026-12-01T00:00:00Z'), to: new Date('2027-01-01T00:00:00Z') });
  });
});
