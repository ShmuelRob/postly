// Rules every style follows (design-styles.md, "Rules for every style"), measured on the
// laid-out page. Each style also has its own test for the rules in its table.

import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { BADGE_KINDS, type BadgeKind } from '../../../contracts/design-spec.js';
import type { RenderRequest } from '../../../contracts/providers/renderer.js';
import { loadExampleSet } from '../../../example-set/index.js';
import { createSharpImages } from '../adapters/sharp-images.js';
import { contrastRatio, MIN_CONTRAST, MIN_GRAPHIC_CONTRAST } from '../color.js';
import { BADGE_SIZE, stickerText } from '../badge.js';
import { type AssetLoader, createDesignEngine } from '../engine.js';
import { fixtureAssetLoader, fixtureBusiness, fixtureOverlayText, fixtureUrls, memoryFileStore } from '../fixtures/fixture.js';
import { CANVAS, hex, inSafeArea, probingRasterizer, type Rect } from '../fixtures/probe.js';
import { matchImageSnapshot } from '../fixtures/snapshot.js';
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
  /** How many [data-badge] elements the page has, and the first one measured. */
  badges: number;
  badge: (Rect & {
    kind: string;
    text: string;
    fill: string;
    textColor: string;
    edge: string | null;
    width: number;
    height: number;
    textWidth: number;
    textLines: number;
    borderRadius: string;
  }) | null;
  logo: Rect | null;
  /** The solid panel behind the overlay text (the title panel). */
  panelRect: Rect | null;
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
  // A carousel's later slides have no overlay: only the badge count matters there.
  if (!o) return { ...report, rules: { badges: document.querySelectorAll('[data-badge]').length, badge: null, logo: null, panelRect: null, overlay: null, graphics: [] } };
  const r = o.getBoundingClientRect();
  const rect = (n) => { const b = n.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; };
  const panelNode = (n) => { for (let e = n.parentElement; e && e !== document.body; e = e.parentElement) {
    if (opaque(cs(e).backgroundColor)) return e; } return null; };
  const badgeNode = document.querySelector('[data-badge]');
  const badgeText = badgeNode && badgeNode.querySelector('span');
  const logoNode = document.querySelector('[data-safe="logo"]');
  const shadow = (n) => { const m = cs(n).boxShadow.match(/rgba?\\([^)]*\\)/); return m ? m[0] : null; };
  return { ...report, rules: {
    badges: document.querySelectorAll('[data-badge]').length,
    badge: badgeNode && { ...rect(badgeNode), kind: badgeNode.dataset.badge, text: badgeText.textContent,
      fill: cs(badgeNode).backgroundColor, textColor: cs(badgeText).color, edge: shadow(badgeNode),
      width: badgeNode.offsetWidth, height: badgeNode.offsetHeight, textWidth: badgeText.offsetWidth,
      textLines: Math.round(badgeText.offsetHeight / parseFloat(cs(badgeText).lineHeight)), borderRadius: cs(badgeNode).borderTopLeftRadius },
    logo: logoNode && rect(logoNode),
    panelRect: panelNode(o) && rect(panelNode(o)),
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

// The badge (design-styles.md, "Photo edits and badge"): the same rules in every style, for every
// kind, measured on the laid-out page.

const FACT_TEXT: Record<'discount' | 'price', string> = { discount: '-15%', price: '₪29.90' };

function badgeFor(kind: BadgeKind, language = 'he'): { kind: BadgeKind; text: string } {
  return { kind, text: kind === 'discount' || kind === 'price' ? FACT_TEXT[kind] : stickerText(kind, language as 'he') };
}

/** Every badge rule on a cover that carries one. */
function expectBadgeRules(m: Measured, expected: { kind: BadgeKind; text: string }) {
  expect(m.badges, 'at most one badge per post').toBe(1);
  const b = m.badge!;
  expect(b.kind).toBe(expected.kind);
  expect(b.text).toBe(expected.text);
  // Size: a 220 px circle or an equivalent box (a rotated one measures a little wider).
  const area = b.width * b.height;
  expect(area).toBeGreaterThanOrEqual(BADGE_SIZE * BADGE_SIZE * 0.7);
  expect(area).toBeLessThanOrEqual(BADGE_SIZE * BADGE_SIZE * 1.3);
  // Placement: inside the safe area, in a top corner, never over the title panel or the logo.
  expect(inSafeArea(b)).toBe(true);
  expect(b.bottom).toBeLessThanOrEqual(CANVAS.height * 0.4);
  const overlaps = (a: Rect, c: Rect) => a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom;
  expect(overlaps(b, m.panelRect!), 'badge over the title panel').toBe(false);
  expect(overlaps(b, m.overlay), 'badge over the title').toBe(false);
  if (m.logo) expect(overlaps(b, m.logo), 'badge over the logo').toBe(false);
  // The corner opposite the logo: on the other half of the canvas from the logo's centre.
  if (m.logo && m.logo.top < CANVAS.height * 0.4) {
    const mid = (r: Rect) => (r.left + r.right) / 2;
    expect(mid(b) < CANVAS.width / 2).toBe(mid(m.logo) >= CANVAS.width / 2);
  }
  // A corner: close to a side edge.
  expect(Math.min(b.left, CANVAS.width - b.right)).toBeLessThanOrEqual(110);
  // Text: one line, inside the badge, 4.5:1 against the badge; the badge 3:1 against its edge.
  expect(b.textLines).toBe(1);
  expect(b.textWidth).toBeLessThanOrEqual(b.width * 0.9);
  expect(contrastRatio(hex(b.textColor), hex(b.fill))).toBeGreaterThanOrEqual(MIN_CONTRAST);
  expect(b.edge, 'a badge over the photo needs an edge').not.toBeNull();
  expect(contrastRatio(hex(b.fill), hex(b.edge!))).toBeGreaterThanOrEqual(MIN_GRAPHIC_CONTRAST);
  // Text area: the title text and the badge together stay within 20% of the canvas.
  const o = m.overlay;
  const overlayArea = (o.right - o.left) * (o.bottom - o.top);
  expect((overlayArea + b.width * b.height) / (CANVAS.width * CANVAS.height)).toBeLessThanOrEqual(0.2);
}

describe('the badge in every style', { timeout: 120_000 }, () => {
  for (const style of STYLES) {
    for (const kind of BADGE_KINDS) {
      it(`${style}: a ${kind} badge follows every rule`, async () => {
        const badge = badgeFor(kind);
        const m = await cover(style, { badge });
        expectEveryRule(m);
        expectBadgeRules(m, badge);
      });
    }

    it(`${style}: no badge, no element`, async () => {
      const m = await cover(style);
      expect(m.badges).toBe(0);
    });

    it(`${style}: the longest text fits on one line`, async () => {
      const badge = { kind: 'price' as const, text: '₪1299.90' };
      const m = await cover(style, { badge });
      expectBadgeRules(m, badge);
    });

    it(`${style}: pale and dark brand colors keep the badge readable`, async () => {
      for (const brandColors of [PALE_BRAND, ['#1F3A5F', '#14141F'], ['#FFFF00', '#FFFFFF']]) {
        const badge = badgeFor('discount');
        const m = await cover(style, { badge, brandColors });
        expectEveryRule(m);
        expectBadgeRules(m, badge);
      }
    });

    it(`${style}: left to right, and with an English sticker`, async () => {
      const badge = badgeFor('sale', 'en');
      const before = rasterizer.slides.length;
      await engine.forBusiness({ ...fixtureBusiness, languages: ['en'] }).render({
        style,
        format: 'single',
        photoUrls: [fixtureUrls.landscape],
        overlayText: 'Weekend sale',
        logoUrl: fixtureUrls.logo,
        brandColors: [],
        networks: ['instagram'],
        badge,
      });
      expectBadgeRules(rasterizer.slides[before]!, badge);
    });

    it(`${style}: only the cover of a carousel carries the badge`, async () => {
      const before = rasterizer.slides.length;
      await engine.forBusiness(fixtureBusiness).render({
        style,
        format: 'carousel',
        photoUrls: [fixtureUrls.landscape, fixtureUrls.portrait, fixtureUrls.square],
        overlayText: fixtureOverlayText,
        logoUrl: fixtureUrls.logo,
        brandColors: [],
        networks: ['instagram'],
        badge: badgeFor('new'),
      });
      const slides = rasterizer.slides.slice(before);
      expect(slides.map((s) => s.badges)).toEqual([1, 0, 0]);
    });
  }
});

describe('the badge on the example set', { timeout: 600_000 }, async () => {
  const entries = await loadExampleSet();
  const photos = new Map<string, string>();
  const assets: AssetLoader = {
    async load(url) {
      const path = photos.get(url);
      return path === undefined ? fixtureAssetLoader().load(url) : new Uint8Array(await readFile(path));
    },
  };
  const files = memoryFileStore();
  const exampleRasterizer = probingRasterizer(PROBE, (layout) => (layout as { rules: Measured }).rules);
  const exampleEngine = createDesignEngine({ rasterizer: exampleRasterizer, images: createSharpImages(), assets, store: files, styles });
  afterAll(() => exampleEngine.close(), 60_000);

  it('has the six example businesses', () => {
    expect(entries).toHaveLength(6);
  });

  for (const style of STYLES) {
    for (const entry of entries) {
      it(`${style}, ${entry.id}: every badge kind follows the rules`, async () => {
        const url = `https://example-set.postly.test/${entry.id}/1.svg`;
        photos.set(url, entry.photos[0]!.path);
        const business = { businessName: entry.profile.name, languages: entry.profile.languages, storagePrefix: `example/${entry.id}` };
        for (const kind of BADGE_KINDS) {
          const badge = badgeFor(kind, entry.profile.languages[0]);
          const before = exampleRasterizer.slides.length;
          const result = await exampleEngine.forBusiness(business).render({
            style,
            format: 'single',
            photoUrls: [url],
            overlayText: entry.expected.overlayTexts[0]!,
            brandColors: entry.profile.brand.colors,
            networks: ['instagram'],
            badge,
          });
          const m = exampleRasterizer.slides[before]!;
          expectEveryRule(m);
          expectBadgeRules(m, badge);
          if (entry.id === entries[0]!.id) {
            const jpeg = files.files.get(result.instagram![0]!.storagePath)!.bytes;
            expect(await matchImageSnapshot(`badge-${style}-${kind}`, jpeg)).toEqual({ ok: true });
          }
        }
      });
    }
  }
});
