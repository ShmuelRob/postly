import { describe, expect, it } from 'vitest';
import { noPublishingWindows, NoTimeAvailableError, proposeTimes } from './times.js';

// Wednesday 2026-11-04 09:00 in Israel (UTC+2 in November).
const NOW = new Date('2026-11-04T07:00:00.000Z');
const TZ = 'Asia/Jerusalem';
const none = { publishOnShabbatAndHolidays: false, days: [], hours: [] };

const local = (d: Date) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.weekday}, ${p.day}/${p.month}, ${p.hour}:${p.minute}`;
};

describe('proposeTimes (technical-design.md, Scheduling and publishing flow)', () => {
  it('defaults to Sunday to Thursday at 10:00, one post per day, from today when an hour away', () => {
    const times = proposeTimes({ count: 3, rules: none, timezone: TZ, city: 'חיפה', now: NOW });
    expect(times.map(local)).toEqual(['Wed, 04/11, 10:00', 'Thu, 05/11, 10:00', 'Sun, 08/11, 10:00']);
  });

  it('starts tomorrow when today’s hour is less than an hour away', () => {
    const times = proposeTimes({ count: 1, rules: none, timezone: TZ, city: undefined, now: new Date('2026-11-04T07:30:00.000Z') });
    expect(times.map(local)).toEqual(['Thu, 05/11, 10:00']);
  });

  it('uses the profile days and hours in turn', () => {
    const rules = { publishOnShabbatAndHolidays: false, days: [1, 3], hours: ['18:30', '12:00'] };
    const times = proposeTimes({ count: 3, rules, timezone: TZ, city: undefined, now: NOW });
    expect(times.map(local)).toEqual(['Wed, 04/11, 18:30', 'Mon, 09/11, 12:00', 'Wed, 11/11, 18:30']);
  });

  it('never proposes a time inside Shabbat unless the profile allows it', () => {
    const friday = { publishOnShabbatAndHolidays: false, days: [5, 6], hours: ['15:45', '20:00'] };
    // Friday 15:45 is past candle lighting minus 30 minutes in November; Saturday 20:00 is past havdalah plus 30.
    expect(proposeTimes({ count: 2, rules: friday, timezone: TZ, city: undefined, now: NOW }).map(local)).toEqual(['Sat, 07/11, 20:00', 'Sat, 14/11, 20:00']);
    const allowed = proposeTimes({ count: 2, rules: { ...friday, publishOnShabbatAndHolidays: true }, timezone: TZ, city: undefined, now: NOW });
    expect(allowed.map(local)).toEqual(['Fri, 06/11, 15:45', 'Sat, 07/11, 20:00']);
  });

  it('a Friday time before the window is allowed', () => {
    const rules = { publishOnShabbatAndHolidays: false, days: [5], hours: ['09:00'] };
    expect(proposeTimes({ count: 1, rules, timezone: TZ, city: undefined, now: NOW }).map(local)).toEqual(['Fri, 06/11, 09:00']);
  });

  it('skips a yom tov day', () => {
    // The first day of Pesach 5787 is Thursday 2027-04-22.
    const now = new Date('2027-04-20T05:00:00.000Z');
    const rules = { publishOnShabbatAndHolidays: false, days: [4], hours: ['12:00'] };
    expect(proposeTimes({ count: 1, rules, timezone: TZ, city: undefined, now }).map(local)).toEqual(['Thu, 29/04, 12:00']);
  });

  it('fails when no time fits in 21 days', () => {
    const rules = { publishOnShabbatAndHolidays: false, days: [6], hours: ['12:00'] };
    expect(() => proposeTimes({ count: 1, rules, timezone: TZ, city: undefined, now: NOW })).toThrow(NoTimeAvailableError);
  });

  it('computes the window from 30 minutes before candle lighting to 30 minutes after havdalah, by the city when known', () => {
    const [jerusalem] = noPublishingWindows(NOW, new Date('2026-11-08T00:00:00.000Z'), undefined);
    const [haifa] = noPublishingWindows(NOW, new Date('2026-11-08T00:00:00.000Z'), 'Haifa');
    expect(jerusalem).toEqual({ from: new Date('2026-11-06T13:35:00.000Z'), to: new Date('2026-11-07T15:53:00.000Z') });
    expect(haifa?.from.getTime()).not.toBe(jerusalem?.from.getTime());
  });
});
