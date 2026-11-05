// Rasterizer on headless Chromium through Playwright. Each page runs in a fresh,
// offline context with every request aborted, so a template can never reach the network.

import { chromium, type Browser } from 'playwright';
import type { Rasterizer } from '../engine.js';
import { NetworkAccessError } from '../errors.js';

// Hinting off keeps glyph outlines closer across operating systems, for stable snapshots.
const LAUNCH_ARGS = ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb'];
// Resolves on the second animation frame, once the page has produced a compositor frame.
const FIRST_FRAME = 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))';

export function createPlaywrightRasterizer(): Rasterizer {
  let browser: Promise<Browser> | undefined;

  return {
    async rasterize({ html, width, height }) {
      browser ??= chromium.launch({ args: LAUNCH_ARGS });
      const context = await (await browser).newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
        offline: true,
      });
      const blocked: string[] = [];
      await context.route('**/*', (route) => {
        blocked.push(route.request().url());
        return route.abort('blockedbyclient');
      });
      try {
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: 'load' });
        const layout: unknown = await page.evaluate('window.__layout');
        if (blocked.length > 0) throw new NetworkAccessError(blocked);
        // Page.captureScreenshot copies the page's last compositor frame. Every render is a fresh
        // page, and `load` does not wait for a frame: under CPU load (two browsers on a CI runner)
        // the first frame can still be pending, and Chromium fails with "Unable to capture
        // screenshot". By the second animation frame callback the first frame has been produced.
        await page.evaluate(FIRST_FRAME);
        const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
        return { png, layout };
      } finally {
        await context.close();
      }
    },

    async close() {
      if (browser) await (await browser).close();
      browser = undefined;
    },
  };
}
