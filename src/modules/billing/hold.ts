/**
 * The billing hold (T16; technical-design.md, Billing): an unpaid `pending` or `past_due` subscription
 * gets 7 days of grace from `grace_started_at`, with reminders on days 1, 3 and 6, then the business
 * is paused through the existing business pause. Nothing is cancelled or deleted.
 */

export const GRACE_DAYS = 7;
export const REMINDER_DAYS = [1, 3, 6] as const;
const DAY_MS = 24 * 60 * 60_000;

/** Template names and copy (whatsapp-templates.md). Provisional (H6). */
export const holdCopy = {
  /** Days 1, 3 and 6 of an unpaid `pending` subscription, with a fresh payment link. */
  REMINDER_TEMPLATE: 'payment_reminder',
  /** Days 1, 3 and 6 of a `past_due` subscription. */
  FAILED_TEMPLATE: 'payment_failed',
  /** Day 7: publishing paused. */
  HOLD_TEMPLATE: 'publishing_on_hold',
} as const;

export interface HoldState {
  graceStartedAt: Date | null;
  remindersSent: number;
  heldAt: Date | null;
}

export type HoldStep = { kind: 'none' } | { kind: 'remind'; remindersSent: number } | { kind: 'hold' };

/** What the daily tick does now; a missed tick sends only the latest due reminder. */
export function holdStep(state: HoldState, now: Date): HoldStep {
  if (!state.graceStartedAt) return { kind: 'none' };
  const day = Math.floor((now.getTime() - state.graceStartedAt.getTime()) / DAY_MS);
  if (day >= GRACE_DAYS) return state.heldAt ? { kind: 'none' } : { kind: 'hold' };
  const due = REMINDER_DAYS.filter((d) => day >= d).length;
  return due > state.remindersSent ? { kind: 'remind', remindersSent: due } : { kind: 'none' };
}

/** The day publishing pauses, as the owner reads it ("10.11.2026"). */
export function holdOn(graceStartedAt: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(
    new Date(graceStartedAt.getTime() + GRACE_DAYS * DAY_MS),
  );
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('day')}.${part('month')}.${part('year')}`;
}
