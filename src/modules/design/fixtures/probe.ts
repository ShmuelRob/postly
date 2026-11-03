// Shared helpers for the style tests: a rasterizer that adds a probe script to each page
// and keeps what it reports, plus color and safe-area helpers for the measured values.

import { createPlaywrightRasterizer } from '../adapters/playwright-rasterizer.js';
import type { Rasterizer } from '../engine.js';
import { SAFE_AREA } from '../layout.js';

export const CANVAS = { width: 1080, height: 1350 };

export type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * Wraps the Playwright rasterizer. `probeScript` runs after the engine's fit script and
 * extends `window.__layout`; `pick` takes this test's measurements from the layout report.
 * Every slide's measurements are kept, in order.
 */
export function probingRasterizer<T>(probeScript: string, pick: (layout: unknown) => T): Rasterizer & { slides: T[] } {
  const inner = createPlaywrightRasterizer();
  const slides: T[] = [];
  return {
    slides,
    async rasterize(page) {
      const out = await inner.rasterize({ ...page, html: page.html.replace('</body>', `${probeScript}</body>`) });
      slides.push(pick(out.layout));
      return out;
    },
    close: () => inner.close(),
  };
}

/** `rgb(r, g, b)` or `rgba(...)` from getComputedStyle to `#RRGGBB`. */
export function hex(rgb: string): string {
  const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
  return `#${[r, g, b].map((c) => Math.round(c ?? 0).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

export function inSafeArea(r: Rect, safe = SAFE_AREA): boolean {
  return (
    r.left >= safe - 0.5 &&
    r.top >= safe - 0.5 &&
    r.right <= CANVAS.width - safe + 0.5 &&
    r.bottom <= CANVAS.height - safe + 0.5
  );
}
