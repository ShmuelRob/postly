/**
 * A fixed-window request counter for one route in one process (docs/security.md, D12). It bounds the
 * CPU a flood can cost (the HMAC check runs only for admitted requests); it is not per caller, because
 * the caller's IP is not authentication. Cloud Armor can replace it in front of web.
 */
export class FixedWindowLimiter {
  private windowStart = 0;
  private count = 0;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: { limit: number; windowMs?: number; now?: () => number }) {
    this.limit = options.limit;
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  /** Counts one request; false when the window's limit is already spent. */
  take(): boolean {
    const now = this.now();
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now - ((now - this.windowStart) % this.windowMs);
      this.count = 0;
    }
    if (this.count >= this.limit) return false;
    this.count++;
    return true;
  }

  /** Whole seconds until the current window ends (at least 1). */
  retryAfterSeconds(): number {
    return Math.max(1, Math.ceil((this.windowStart + this.windowMs - this.now()) / 1000));
  }
}

/** An `onRequest` hook that answers 429 with `Retry-After` once the limiter is spent. */
export function rateLimitHook(limiter: FixedWindowLimiter) {
  return async (_request: unknown, reply: { header(k: string, v: string): unknown; code(c: number): { send(b: unknown): unknown } }) => {
    if (limiter.take()) return;
    reply.header('retry-after', String(limiter.retryAfterSeconds()));
    return reply.code(429).send({ error: 'too many requests' });
  };
}
