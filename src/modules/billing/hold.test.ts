import { describe, expect, it } from 'vitest';
import { holdOn, holdStep } from './hold.js';

const START = new Date('2026-11-03T08:00:00.000Z');
const day = (n: number, extraMs = 0) => new Date(START.getTime() + n * 86_400_000 + extraMs);
const step = (n: number, remindersSent = 0, heldAt: Date | null = null) => holdStep({ graceStartedAt: START, remindersSent, heldAt }, day(n, 1));

describe('holdStep (technical-design.md, Billing hold)', () => {
  it('sends reminders on days 1, 3 and 6, one per due day', () => {
    expect(step(0)).toEqual({ kind: 'none' });
    expect(step(1)).toEqual({ kind: 'remind', remindersSent: 1 });
    expect(step(2, 1)).toEqual({ kind: 'none' });
    expect(step(3, 1)).toEqual({ kind: 'remind', remindersSent: 2 });
    expect(step(5, 2)).toEqual({ kind: 'none' });
    expect(step(6, 2)).toEqual({ kind: 'remind', remindersSent: 3 });
  });

  it('after missed ticks sends only the latest due reminder', () => {
    expect(step(4, 0)).toEqual({ kind: 'remind', remindersSent: 2 });
  });

  it('holds from day 7, once', () => {
    expect(step(7, 3)).toEqual({ kind: 'hold' });
    expect(step(9, 1)).toEqual({ kind: 'hold' });
    expect(step(7, 3, day(7))).toEqual({ kind: 'none' });
  });

  it('does nothing without a grace period', () => {
    expect(holdStep({ graceStartedAt: null, remindersSent: 0, heldAt: null }, day(30))).toEqual({ kind: 'none' });
  });

  it('names the hold day in the business time zone', () => {
    expect(holdOn(START, 'Asia/Jerusalem')).toBe('10.11.2026');
  }, 30_000);
});
