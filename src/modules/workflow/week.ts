// The business week (technical-design.md, Operational defaults): Sunday 00:00 to Saturday 23:59
// in the business's timezone.

export interface LocalWeek {
  /** The local Sunday, YYYY-MM-DD (`weekly_update.week_start`). */
  weekStart: string;
  nextWeekStart: string;
  /** Local weekday, 0 is Sunday. */
  day: number;
  /** Local minutes since midnight. */
  minutes: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localWeek(now: Date, timeZone: string): LocalWeek {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const day = WEEKDAYS.indexOf(parts.weekday!);
  const localDate = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const sunday = localDate - day * 86_400_000;
  return { weekStart: isoDay(sunday), nextWeekStart: isoDay(sunday + 7 * 86_400_000), day, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
