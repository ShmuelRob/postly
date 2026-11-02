// Warm rules from design-styles.md, checked in a real browser. A probe script added to
// each page reports the geometry and colors of the Warm elements next to the engine's
// own layout report, so the tests assert on what was drawn, not on CSS strings.

import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Network } from '../../../contracts/common.js';
import type { RenderRequest } from '../../../contracts/providers/renderer.js';
import { type ExampleEntry, loadExampleSet } from '../../../example-set/index.js';
import { createPlaywrightRasterizer } from '../adapters/playwright-rasterizer.js';
import { createSharpImages } from '../adapters/sharp-images.js';
import { contrastRatio, MIN_CONTRAST } from '../color.js';
import { type AssetLoader, type BusinessRenderContext, createDesignEngine, type DesignEngine } from '../engine.js';
import { OverlayTextError } from '../errors.js';
import {
  fixtureAssetLoader,
  fixtureBusiness,
  fixtureOverlayText,
  fixtureUrls,
  memoryFileStore,
} from '../fixtures/fixture.js';
import { matchImageSnapshot } from '../fixtures/snapshot.js';
import { styles } from './index.js';

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type Probe = {
  dir: string;
  bodyBackground: string;
  bodyBackgroundImage: string;
  photo: Rect & { radius: string };
  card: (Rect & { background: string; backgroundImage: string }) | null;
  overlay: (Rect & { color: string; fontFamily: string; fontWeight: string; fontSize: number; textAlign: string }) | null;
  logoCircle: Rect & { background: string; radius: string };
  logo: Rect & { tag: string; color: string; fontFamily: string; fontWeight: string };
};
type Slide = { fontsLoaded: boolean; safeAreaViolations: string[]; probe: Probe };

const PROBE = `<script>
window.__layout = window.__layout.then((report) => {
  const rect = (el) => { const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const css = (el) => getComputedStyle(el);
  const q = (s) => document.querySelector(s);
  const card = q('.card'), overlay = q('[data-overlay]'), logo = q('[data-safe="logo"]'), circle = q('.logo-circle'), photo = q('.photo');
  return { ...report, probe: {
    dir: document.documentElement.dir,
    bodyBackground: css(document.body).backgroundColor,
    bodyBackgroundImage: css(document.body).backgroundImage,
    photo: { ...rect(photo), radius: css(photo).borderTopLeftRadius },
    card: card && { ...rect(card), background: css(card).backgroundColor, backgroundImage: css(card).backgroundImage },
    overlay: overlay && { ...rect(overlay), color: css(overlay).color, fontFamily: css(overlay).fontFamily,
      fontWeight: css(overlay).fontWeight, fontSize: parseFloat(css(overlay).fontSize), textAlign: css(overlay).textAlign },
    logoCircle: { ...rect(circle), background: css(circle).backgroundColor, radius: css(circle).borderTopLeftRadius },
    logo: { ...rect(logo), tag: logo.tagName, color: css(logo).color, fontFamily: css(logo).fontFamily, fontWeight: css(logo).fontWeight },
  } };
});
</script>`;

const W = 1080;
const H = 1350;
const NETWORKS: Network[] = ['instagram', 'facebook'];

const images = createSharpImages();
const store = memoryFileStore();
const slides: Slide[] = [];
let engine: DesignEngine;

/** Assets: the renderer fixture by URL, anything else read from disk (the example set). */
const EXAMPLE_ORIGIN = 'https://example-set.postly.test';
const examplePaths = new Map<string, string>();
const assets: AssetLoader = {
  async load(url) {
    const path = examplePaths.get(url);
    return path === undefined ? fixtureAssetLoader().load(url) : new Uint8Array(await readFile(path));
  },
};

beforeAll(() => {
  const real = createPlaywrightRasterizer();
  engine = createDesignEngine({
    assets,
    store,
    images,
    styles,
    rasterizer: {
      async rasterize(page) {
        const result = await real.rasterize({ ...page, html: page.html.replace('</body>', `${PROBE}</body>`) });
        slides.push(result.layout as Slide);
        return result;
      },
      close: () => real.close(),
    },
  });
});

afterAll(async () => {
  await engine.close();
});

function request(overrides: Partial<RenderRequest> = {}): RenderRequest {
  return {
    style: 'warm',
    format: 'single',
    photoUrls: [fixtureUrls.landscape],
    overlayText: fixtureOverlayText,
    logoUrl: fixtureUrls.logo,
    brandColors: [],
    networks: ['instagram'],
    ...overrides,
  };
}

/** Renders and returns the probe of each slide drawn by this call. */
async function render(req: RenderRequest, business: BusinessRenderContext = fixtureBusiness) {
  const from = slides.length;
  const result = await engine.forBusiness(business).render(req);
  return { result, probes: slides.slice(from).map((s) => s.probe), reports: slides.slice(from) };
}

/** `rgb(r, g, b)` from getComputedStyle to `#RRGGBB`. */
function hex(rgb: string): string {
  const [r, g, b] = rgb.match(/\d+/g)!.slice(0, 3).map(Number);
  return `#${[r, g, b].map((c) => c!.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

const inside = (inner: Rect, outer: Rect) =>
  inner.left >= outer.left - 0.5 &&
  inner.top >= outer.top - 0.5 &&
  inner.right <= outer.right + 0.5 &&
  inner.bottom <= outer.bottom + 0.5;
const safe: Rect = { left: 64, top: 64, right: W - 64, bottom: H - 64, width: W - 128, height: H - 128 };

/** Every Warm rule that holds on any slide. */
function expectWarmSlide(probe: Probe, kind: 'cover' | 'photo', dir: 'rtl' | 'ltr') {
  expect(probe.dir).toBe(dir);
  // Frame: a 32 px background-colored margin, 24 px rounded photo corners.
  expect(probe.photo.left).toBe(32);
  expect(probe.photo.top).toBe(32);
  expect(probe.photo.right).toBe(W - 32);
  expect(probe.photo.radius).toBe('24px');
  if (kind === 'photo') expect(probe.photo.bottom).toBe(H - 32);
  expect(hex(probe.bodyBackground)).toBe('#F3E9DC');
  // Paper grain, made in code: an inline SVG noise, never a URL.
  expect(probe.bodyBackgroundImage).toMatch(/^url\("data:image\/svg\+xml/);
  expect(probe.bodyBackgroundImage).toContain('feTurbulence');

  // Logo: top corner on the start side, on a background-colored circle, inside the safe area.
  const { logoCircle, logo } = probe;
  expect(logoCircle.top).toBe(64);
  if (dir === 'rtl') expect(logoCircle.right).toBe(W - 64);
  else expect(logoCircle.left).toBe(64);
  expect(logoCircle.radius).toBe('50%');
  expect(hex(logoCircle.background)).toBe('#F3E9DC');
  expect(inside(logo, logoCircle)).toBe(true);
  expect(inside(logoCircle, safe)).toBe(true);
  if (logo.tag === 'DIV') {
    expect(logo.fontFamily).toContain('Frank Ruhl Libre');
    expect(logo.fontWeight).toBe('700');
    expect(contrastRatio(hex(logo.color), '#F3E9DC')).toBeGreaterThanOrEqual(MIN_CONTRAST);
  }

  if (kind === 'photo') {
    expect(probe.card).toBeNull();
    expect(probe.overlay).toBeNull();
    return;
  }
  // The overlay sits on a paper-texture card that overlaps the bottom of the photo.
  const card = probe.card!;
  const overlay = probe.overlay!;
  expect(card.top).toBeLessThan(probe.photo.bottom);
  expect(card.bottom).toBeGreaterThan(probe.photo.bottom);
  expect(card.backgroundImage).toContain('feTurbulence');
  expect(inside(card, safe)).toBe(true);
  expect(inside(overlay, card)).toBe(true);
  expect(overlay.fontFamily).toContain('Frank Ruhl Libre');
  expect(overlay.fontWeight).toBe('700');
  expect(overlay.fontSize).toBeLessThanOrEqual(64);
  expect(overlay.fontSize).toBeGreaterThanOrEqual(46);
  expect(overlay.textAlign).toBe('start');
  expect(contrastRatio(hex(overlay.color), hex(card.background))).toBeGreaterThanOrEqual(MIN_CONTRAST);
}

describe('Warm style', { timeout: 120_000 }, () => {
  it('declares the Warm fonts, palette, and overlay size', () => {
    expect(styles.warm.fonts).toEqual({
      headline: { family: 'Frank Ruhl Libre', weight: 700 },
      secondary: { family: 'Assistant', weight: 400 },
    });
    expect(styles.warm.palette).toEqual({
      background: '#F3E9DC',
      text: '#3B2A1E',
      accent: '#B5683C',
      secondary: '#7A8450',
    });
    expect(styles.warm.overlay).toEqual({ size: 64, minSize: 46 });
  });

  it('lays out a Hebrew cover right to left within every Warm rule', async () => {
    const { probes, reports } = await render(request());
    expect(reports[0]!.fontsLoaded).toBe(true);
    expectWarmSlide(probes[0]!, 'cover', 'rtl');
    expect(probes[0]!.overlay!.fontSize).toBe(64);
  });

  it('mirrors the layout left to right for an English business', async () => {
    const { probes } = await render(request({ overlayText: 'Weekend sale: 20% off all bouquets' }), {
      ...fixtureBusiness,
      businessName: 'Garden Flowers',
      languages: ['en'],
    });
    expectWarmSlide(probes[0]!, 'cover', 'ltr');
    await expect(
      matchImageSnapshot('warm-ltr-1', store.files.get([...store.files.keys()].at(-1)!)!.bytes),
    ).resolves.toEqual({ ok: true });
  });

  it('sets the business name in the headline font on the circle when there is no logo', async () => {
    const { logoUrl: _logo, ...withoutLogo } = request();
    const { probes } = await render(withoutLogo);
    expect(probes[0]!.logo.tag).toBe('DIV');
    expectWarmSlide(probes[0]!, 'cover', 'rtl');
  });

  it('keeps the logo at its fitted size, at most 160 x 160', async () => {
    const big = (await render(request())).probes[0]!.logo;
    expect([big.width, big.height]).toEqual([160, 160]);
    const small = (await render(request({ logoUrl: fixtureUrls.logoSmall }))).probes[0]!.logo;
    expect([small.width, small.height]).toEqual([100, 60]);
  });

  it('uses brand colors for accent and secondary and keeps text contrast at 4.5:1', async () => {
    const { probes } = await render(request({ brandColors: ['#1F1F1F', '#C9A27E'] }));
    expectWarmSlide(probes[0]!, 'cover', 'rtl');
    const css = styles.warm.css.call(styles.warm, {
      kind: 'cover',
      canvas: { width: W, height: H },
      language: 'he',
      dir: 'rtl',
      palette: { ...styles.warm.palette, accent: '#1F1F1F', secondary: '#C9A27E' },
      photo: { dataUri: 'data:,', width: 1, height: 1 },
      logo: { kind: 'text', text: 'x' },
      overlayText: 'x',
      safeArea: 64,
    });
    expect(css).toContain('#1F1F1F');
    expect(css).toContain('#C9A27E');
    expect(css).not.toContain('#B5683C');
    expect(css).not.toContain('#7A8450');
  });

  it('shrinks long overlay text toward 46 px and fails when two lines are not enough', async () => {
    const { probes } = await render(request({ overlayText: `${'ש'.repeat(13)} ${'ש'.repeat(13)} ${'ש'.repeat(9)}` }));
    expectWarmSlide(probes[0]!, 'cover', 'rtl');
    expect(probes[0]!.overlay!.fontSize).toBeLessThan(64);
    await expect(render(request({ overlayText: 'ש'.repeat(38) }))).rejects.toMatchObject({ code: 'does_not_fit' });
    await expect(render(request({ overlayText: 'א'.repeat(41) }))).rejects.toBeInstanceOf(OverlayTextError);
  });

  it('draws a carousel as a cover and then framed photos with the logo only', async () => {
    const { probes } = await render(
      request({ format: 'carousel', photoUrls: [fixtureUrls.landscape, fixtureUrls.portrait, fixtureUrls.square] }),
    );
    expect(probes).toHaveLength(3);
    expectWarmSlide(probes[0]!, 'cover', 'rtl');
    expectWarmSlide(probes[1]!, 'photo', 'rtl');
    expectWarmSlide(probes[2]!, 'photo', 'rtl');
  });
});

describe('Warm style: the example set', { timeout: 300_000 }, () => {
  let entries: ExampleEntry[] = [];
  beforeAll(async () => {
    entries = await loadExampleSet();
  });

  it('loads all six provisional entries', () => {
    expect(entries).toHaveLength(6);
  });

  it('renders every entry in Warm for every network within the rules', async () => {
    for (const entry of entries) {
      const { profile } = entry;
      const business: BusinessRenderContext = {
        businessName: profile.name,
        languages: profile.languages,
        storagePrefix: `example/${entry.id}`,
      };
      const dir = profile.languages[0] === 'he' || profile.languages[0] === 'ar' ? 'rtl' : 'ltr';
      const photoUrls = entry.photos.map((p, i) => {
        const url = `${EXAMPLE_ORIGIN}/${entry.id}/${i + 1}`;
        examplePaths.set(url, p.path);
        return url;
      });
      const brandColors = profile.brand?.colors ?? [];

      for (const [t, overlayText] of entry.expected.overlayTexts.entries()) {
        const { result, probes } = await render(
          { style: 'warm', format: 'carousel', photoUrls, overlayText, brandColors, networks: NETWORKS },
          business,
        );
        expect(probes, entry.id).toHaveLength(photoUrls.length);
        probes.forEach((probe, i) => expectWarmSlide(probe, i === 0 ? 'cover' : 'photo', dir));
        for (const network of NETWORKS) expect(result[network], `${entry.id} ${network}`).toHaveLength(photoUrls.length);
        if (t === 0) {
          const cover = store.files.get(result.instagram![0]!.storagePath)!.bytes;
          await expect(matchImageSnapshot(`warm-example-${entry.id}-1`, cover)).resolves.toEqual({ ok: true });
        }
      }
    }
  });
});
