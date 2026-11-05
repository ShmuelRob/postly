import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter } from './rate-limit.js';

describe('FixedWindowLimiter (D12)', () => {
  it('allows up to the limit per window, then refuses until the next window', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 1000, now: () => now });
    expect([limiter.take(), limiter.take(), limiter.take()]).toEqual([true, true, false]);
    expect(limiter.retryAfterSeconds()).toBe(1);
    now = 1000;
    expect(limiter.take()).toBe(true);
  });
});
