// Rules every style follows (design-styles.md, "Rules for every style"), measured on the
// laid-out page. Each style also has its own test for the rules in its table.

import { afterAll, describe, expect, it } from 'vitest';
import type { RenderRequest } from '../../../contracts/providers/renderer.js';
import { createSharpImages } from '../adapters/sharp-images.js';
import { contrastRatio, MIN_CONTRAST, MIN_GRAPHIC_CONTRAST } from '../color.js';
import { createDesignEngine } from '../engine.js';
import { fixtureAssetLoader, fixtureBusiness, fixtureOverlayText, fixtureUrls, memoryFileStore } from '../fixtures/fixture.js';
import { CANVAS, hex, probingRasterizer, type Rect } from '../fixtures/probe.js';
import { styles } from './index.js';

type Graphic = { background: string; panel: string | null; edge: string | null; overPhoto: boolean };
type Measured = {
  overlay: Rect & {
    color: string;
    panel: string | null;
    letterSpacing: string;
    whiteSpace: string;
    fontSize: number;
    lineHeight: number;
    lines: number;
  };
  graphics: Graphic[];
};

// The panel of an element is the background of its nearest ancestor (or itself) with an
// opaque background color; a graphic over the photo reports its box-shadow edge color.
const PROBE = `<script>
window.__layout = window.__layout.then((report) => {
  const cs = (n) => getComputedStyle(n);
  const opaque = (c) => c !== 'transparent' && !/rgba\\(.*,\\s*0\\)$/.test(c);
  const panel = (n) => { for (let e = n.parentElement; e && e !== document.body; e = e.parentElement) {
    if (opaque(cs(e).backgroundColor)) return cs(e).backgroundColor; } return null; };
  const o = document.querySelector('[data-overlay]');
  const r = o.getBoundingClientRect();
  const shadow = (n) => { const m = cs(n).boxShadow.match(/rgba?\\([^)]*\\)/); return m ? m[0] : null; };
  return { ...report, rules: {
    overlay: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, color: cs(o).color, panel: panel(o),
      letterSpacing: cs(o).letterSpacing, whiteSpace: cs(o).whiteSpace, fontSize: parseFloat(cs(o).fontSize),
      lineHeight: parseFloat(cs(o).lineHeight), lines: Math.round(o.offsetHeight / parseFloat(cs(o).lineHeight)) },
    graphics: [...document.querySelectorAll('[data-graphic]')].map((n) => ({ background: cs(n).backgroundColor,
      panel: panel(n), edge: shadow(n), overPhoto: n.dataset.graphic === 'over-photo' })),
  } };
});
</script>`;

const rasterizer = probingRasterizer(PROBE, (layout) => (layout as { rules: Measured }).rules);
const engine = createDesignEngine({
  rasterizer,
  images: createSharpImages(),
  assets: fixtureAssetLoader(),
  store: memoryFileStore(),
  styles,
});
afterAll(() => engine.close(), 60_000);

const STYLES = ['clean', 'warm', 'dynamic'] as const;
/** Pale brand colors: the case that made graphic elements faint before the 3:1 rule. */
const PALE_BRAND = ['#E8B4C8', '#F5E6A8'];

async function cover(style: (typeof STYLES)[number], overrides: Partial<RenderRequest> = {}): Promise<Measured> {
  const before = rasterizer.slides.length;
  await engine.forBusiness(fixtureBusiness).render({
    style,
    format: 'single',
    photoUrls: [fixtureUrls.landscape],
    overlayText: fixtureOverlayText,
    logoUrl: fixtureUrls.logo,
    brandColors: [],
    networks: ['instagram'],
    ...overrides,
  });
  return rasterizer.slides[before]!;
}

function expectEveryRule(m: Measured) {
  const o = m.overlay;
  // Text sits on a solid panel, never directly on the photo, at 4.5:1.
  expect(o.panel).not.toBeNull();
  expect(contrastRatio(hex(o.color), hex(o.panel!))).toBeGreaterThanOrEqual(MIN_CONTRAST);
  // Text box at most 20% of the canvas.
  const area = (o.right - o.left) * (o.bottom - o.top);
  expect(area / (CANVAS.width * CANVAS.height)).toBeLessThanOrEqual(0.2);
  // Mobile legibility: at least 48 px, which is about 17 pt on a phone 390 pt wide.
  expect(o.fontSize).toBeGreaterThanOrEqual(48);
  // Hebrew typography: no tracking, line height at least 1.1, explicit breaks kept.
  expect(o.letterSpacing).toBe('normal');
  expect(o.lineHeight / o.fontSize).toBeGreaterThanOrEqual(1.1 - 0.01);
  expect(o.whiteSpace).toBe('pre-line');
  // Graphic elements reach 3:1 against what they sit on (WCAG 1.4.11).
  expect(m.graphics.length).toBeGreaterThan(0);
  for (const g of m.graphics) {
    const against = g.overPhoto ? g.edge : g.panel;
    expect(against, 'a graphic needs a panel or, over the photo, an edge').not.toBeNull();
    expect(contrastRatio(hex(g.background), hex(against!))).toBeGreaterThanOrEqual(MIN_GRAPHIC_CONTRAST);
  }
}

describe('rules for every style', { timeout: 60_000 }, () => {
  it.each(STYLES)('%s: declares a minimum overlay size of at least 48 px', (style) => {
    expect(styles[style].overlay.minSize).toBeGreaterThanOrEqual(48);
  });

  it.each(STYLES)('%s: a default cover follows every rule', async (style) => {
    expectEveryRule(await cover(style));
  });

  it.each(STYLES)('%s: pale brand colors keep graphic elements at 3:1', async (style) => {
    expectEveryRule(await cover(style, { brandColors: PALE_BRAND }));
  });

  it.each(STYLES)('%s: a dark brand accent keeps graphic elements at 3:1', async (style) => {
    expectEveryRule(await cover(style, { brandColors: ['#1F3A5F', '#14141F'] }));
  });

  it.each(STYLES)('%s: keeps an explicit line break', async (style) => {
    const m = await cover(style, { overlayText: 'סביח\nחדש' });
    expect(m.overlay.lines).toBe(2);
    expectEveryRule(m);
  });
});
