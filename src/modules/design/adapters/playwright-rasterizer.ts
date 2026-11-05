// Rasterizer on headless Chromium through Playwright. Each page runs in a fresh,
// offline context with every request aborted, so a template can never reach the network.

import { chromium, type Browser, type Page } from 'playwright';
import type { Rasterizer } from '../engine.js';
import { NetworkAccessError } from '../errors.js';

// Hinting off keeps glyph outlines closer across operating systems, for stable snapshots.
const LAUNCH_ARGS = ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb'];
// Resolves on the second animation frame, once the page has produced a compositor frame.
const FIRST_FRAME = 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))';

/**
 * One retry, for exactly Chromium's "Unable to capture screenshot" (Page.captureScreenshot found
 * no frame to copy) and nothing else. Why a retry and not only a fix: CI run 42097000071 failed
 * this way on the first render after the browser launched, about once per 750 such renders in the
 * CI history, and 28,800 fresh-launch first renders on CI runners (idle and CPU-saturated, with and
 * without the frame wait above) never reproduced it, so its cause could not be proven. The page and
 * its layout are already final; the capture is repeated after another frame, never the render or
 * any check on its output.
 */
export async function screenshot(page: Pick<Page, 'screenshot' | 'evaluate'>, width: number, height: number): Promise<Buffer> {
  const capture = () => page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
  try {
    return await capture();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('Unable to capture screenshot')) throw error;
    await page.evaluate(FIRST_FRAME);
    return capture();
  }
}

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
        // page and `load` does not wait for a frame, so wait for one before the first capture.
        await page.evaluate(FIRST_FRAME);
        const png = await screenshot(page, width, height);
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
