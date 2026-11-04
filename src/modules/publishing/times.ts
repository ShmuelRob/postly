import type { BusinessProfile } from '../../contracts/business-profile.js';
import { lookupCity, restPeriods } from './jewish-calendar.js';

// Time proposals (technical-design.md, Scheduling and publishing flow; Configuration defaults). Pure
// code: one time per post, each on a different day, by the profile's days and hours, never inside
// the no-publishing window of Shabbat and yom tov unless the profile allows it.

export type ScheduleRules = BusinessProfile['schedule'];

/** Sunday to Thursday, when the profile names no days. */
export const DEFAULT_DAYS = [0, 1, 2, 3, 4];
export const DEFAULT_HOUR = '10:00';
/** A proposed time is at least this far from now. */
export const MIN_LEAD_MS = 60 * 60 * 1000;
export const SEARCH_DAYS = 21;
/** Before candle lighting and after havdalah. */
export const WINDOW_MARGIN_MS = 30 * 60 * 1000;

export class NoTimeAvailableError extends Error {
  override name = 'NoTimeAvailableError';
}

export interface Window {
  from: Date;
  to: Date;
}

/**
 * Shabbat and Israeli yom tov between `start` and `end`: from 30 minutes before candle lighting to
 * 30 minutes after havdalah (`jewish-calendar.ts`), at `city` when we know its English or Hebrew name,
 * otherwise Jerusalem.
 */
export function noPublishingWindows(start: Date, end: Date, city: string | undefined): Window[] {
  const day = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return restPeriods(day(start), day(end), lookupCity(city))
    .map((p) => ({ from: new Date(p.candleLighting.getTime() - WINDOW_MARGIN_MS), to: new Date(p.havdalah.getTime() + WINDOW_MARGIN_MS) }))
    .filter((w) => w.to > start && w.from < end);
}

/** The local calendar date of `at` in `timezone`, as UTC midnight of that date. */
function localDate(at: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  return new Date(`${parts}T00:00:00.000Z`);
}

/** The offset of `timezone` from UTC at `at`, in milliseconds. */
function offsetMs(at: Date, timezone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(at)
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(at.getTime() / 1000) * 1000;
}

/** `hhmm` on `day` (UTC midnight of a local date) in `timezone`. */
export function zonedTime(day: Date, hhmm: string, timezone: string): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const wall = day.getTime() + (h * 60 + m) * 60_000;
  let guess = wall - offsetMs(new Date(wall), timezone);
  guess = wall - offsetMs(new Date(guess), timezone);
  return new Date(guess);
}

export function proposeTimes(options: { count: number; rules: ScheduleRules; timezone: string; city: string | undefined; now: Date }): Date[] {
  const { count, rules, timezone, now } = options;
  const days = rules.days.length > 0 ? rules.days : DEFAULT_DAYS;
  const hours = rules.hours.length > 0 ? rules.hours : [DEFAULT_HOUR];
  const first = localDate(now, timezone);
  const windows = rules.publishOnShabbatAndHolidays ? [] : noPublishingWindows(now, new Date(first.getTime() + (SEARCH_DAYS + 1) * 86_400_000), options.city);
  const blocked = (at: Date) => windows.some((w) => at >= w.from && at <= w.to);

  const times: Date[] = [];
  for (let d = 0; d < SEARCH_DAYS && times.length < count; d++) {
    const day = new Date(first.getTime() + d * 86_400_000);
    if (!days.includes(day.getUTCDay())) continue;
    // The hours in turn: this post starts from the next hour in the list, then tries the others.
    for (let i = 0; i < hours.length; i++) {
      const at = zonedTime(day, hours[(times.length + i) % hours.length]!, timezone);
      if (at.getTime() - now.getTime() < MIN_LEAD_MS || blocked(at)) continue;
      times.push(at);
      break;
    }
  }
  if (times.length < count) throw new NoTimeAvailableError(`only ${times.length} of ${count} times fit in ${SEARCH_DAYS} days`);
  return times;
}
