import { describe, expect, it } from 'vitest';
import { screenshot } from './playwright-rasterizer.js';

/** A page whose screenshot calls fail with the given errors first, then succeed. */
function fakePage(failures: Error[]) {
  const calls = { screenshot: 0, evaluate: 0 };
  const page = {
    async screenshot() {
      calls.screenshot++;
      const error = failures.shift();
      if (error) throw error;
      return Buffer.from('png');
    },
    async evaluate() {
      calls.evaluate++;
      return true;
    },
  };
  return { page: page as unknown as Parameters<typeof screenshot>[0], calls };
}

const NO_FRAME = new Error('page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot');

describe('screenshot capture', () => {
  it('captures once when the first capture works', async () => {
    const { page, calls } = fakePage([]);
    expect((await screenshot(page, 10, 10)).toString()).toBe('png');
    expect(calls).toEqual({ screenshot: 1, evaluate: 0 });
  });

  it('retries once, after another frame, when Chromium had no frame to copy', async () => {
    const { page, calls } = fakePage([NO_FRAME]);
    expect((await screenshot(page, 10, 10)).toString()).toBe('png');
    expect(calls).toEqual({ screenshot: 2, evaluate: 1 });
  });

  it('retries only once', async () => {
    const { page, calls } = fakePage([NO_FRAME, NO_FRAME]);
    await expect(screenshot(page, 10, 10)).rejects.toThrow('Unable to capture screenshot');
    expect(calls.screenshot).toBe(2);
  });

  it('never retries any other error', async () => {
    const { page, calls } = fakePage([new Error('Target page, context or browser has been closed')]);
    await expect(screenshot(page, 10, 10)).rejects.toThrow('has been closed');
    expect(calls.screenshot).toBe(1);
  });
});
