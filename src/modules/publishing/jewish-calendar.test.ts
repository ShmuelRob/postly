import { describe, expect, it } from 'vitest';
import { candleLighting, havdalah, holidayInWeek, JERUSALEM, lookupCity, restPeriods, roshHashana, yomTovDays } from './jewish-calendar.js';

// Cross-checks against published Israeli calendars (the values were taken from hebcal.com for
// these cities; a one-minute difference is allowed for rounding of the solar equations).

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const nearMinute = (actual: Date, expected: string) => expect(Math.abs(actual.getTime() - new Date(expected).getTime())).toBeLessThanOrEqual(60_000);

describe('yom tov dates (Israel)', () => {
  it.each([
    [5786, '2025-09-23', '2025-10-02', '2025-10-07', '2025-10-14', '2026-04-02', '2026-04-08', '2026-05-22'],
    [5787, '2026-09-12', '2026-09-21', '2026-09-26', '2026-10-03', '2027-04-22', '2027-04-28', '2027-06-11'],
    [5788, '2027-10-02', '2027-10-11', '2027-10-16', '2027-10-23', '2028-04-11', '2028-04-17', '2028-05-31'],
    [5789, '2028-09-21', '2028-09-30', '2028-10-05', '2028-10-12', '2029-03-31', '2029-04-06', '2029-05-20'],
    [5790, '2029-09-10', '2029-09-19', '2029-09-24', '2029-10-01', '2030-04-18', '2030-04-24', '2030-06-07'],
  ])('%i', (year, rh, yk, sukkot, atzeret, pesach, pesach7, shavuot) => {
    const days = Object.fromEntries(yomTovDays(year).map((d) => [d.name, iso(d.date)]));
    const rh2 = iso(new Date(day(rh).getTime() + 86_400_000));
    expect(days).toEqual({
      'Rosh Hashana I': rh,
      'Rosh Hashana II': rh2,
      'Yom Kippur': yk,
      'Sukkot I': sukkot,
      'Shmini Atzeret': atzeret,
      'Pesach I': pesach,
      'Pesach VII': pesach7,
      Shavuot: shavuot,
    });
  });

  it('Rosh Hashana never falls on Sunday, Wednesday or Friday', () => {
    for (let y = 5700; y < 5900; y++) expect([0, 3, 5]).not.toContain(roshHashana(y).getUTCDay());
  });
});

describe('candle lighting and havdalah', () => {
  it.each([
    ['Jerusalem', '2026-11-06', '2026-11-06T14:05:00Z', '2026-11-07', '2026-11-07T15:23:00Z'],
    ['Haifa', '2027-06-25', '2027-06-25T16:21:00Z', '2027-06-26', '2027-06-26T17:35:00Z'],
    ['Eilat', '2027-01-15', '2027-01-15T14:43:00Z', '2027-01-16', '2027-01-16T15:42:00Z'],
    ['Jerusalem', '2027-10-22', '2027-10-22T14:19:00Z', '2027-10-23', '2027-10-23T15:35:00Z'],
  ])('%s %s', (name, eve, candles, end, out) => {
    const c = lookupCity(name);
    nearMinute(candleLighting(day(eve), c), candles);
    nearMinute(havdalah(day(end), c), out);
  });

  it('merges Rosh Hashana next to Shabbat into one period (Tel Aviv, 5787)', () => {
    const periods = restPeriods(day('2026-09-10'), day('2026-09-14'), lookupCity('תל אביב'));
    const rh = periods.find((p) => iso(p.havdalah) === '2026-09-13')!;
    nearMinute(rh.candleLighting, '2026-09-11T15:32:00Z');
    nearMinute(rh.havdalah, '2026-09-13T16:26:00Z');
  });
});

describe('lookupCity', () => {
  it('knows Hebrew and English names, with spacing and punctuation ignored', () => {
    expect(lookupCity('חיפה').name).toBe('Haifa');
    expect(lookupCity('Haifa').name).toBe('Haifa');
    expect(lookupCity('באר שבע').name).toBe('Beer Sheva');
    expect(lookupCity("Be'er Sheva").name).toBe('Beer Sheva');
    expect(lookupCity('תל-אביב יפו').name).toBe('Tel Aviv');
    expect(lookupCity('כפר סבא').name).toBe('Kfar Saba');
    expect(lookupCity('זכרון יעקב').candleLightingMinutes).toBe(30);
  });

  it('falls back to Jerusalem', () => {
    expect(lookupCity(undefined)).toBe(JERUSALEM);
    expect(lookupCity('Springfield')).toBe(JERUSALEM);
    expect(JERUSALEM.candleLightingMinutes).toBe(40);
  });
});

describe('holidayInWeek (the holiday badge, agent.md Badge element)', () => {
  it('is true for the Sunday-to-Saturday week that holds a yom tov day, whichever day it falls on', () => {
    for (const { date } of [...yomTovDays(5787), ...yomTovDays(5788)]) {
      const sunday = new Date(date.getTime() - date.getUTCDay() * 86_400_000);
      expect(holidayInWeek(sunday), iso(date)).toBe(true);
    }
  });

  it('is false for the weeks next to it and for an ordinary week', () => {
    const rh = yomTovDays(5787)[7]!.date; // Shavuot: no other yom tov within a week
    const sunday = new Date(rh.getTime() - rh.getUTCDay() * 86_400_000);
    expect(holidayInWeek(new Date(sunday.getTime() - 7 * 86_400_000))).toBe(false);
    expect(holidayInWeek(new Date(sunday.getTime() + 7 * 86_400_000))).toBe(false);
    expect(holidayInWeek(day('2026-11-01'))).toBe(false);
  });
});
