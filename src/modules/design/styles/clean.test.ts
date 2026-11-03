// Clean style rules from design-styles.md, checked on the laid-out page. A wrapping
// rasterizer adds a measuring script after the engine's fitting script, so every
// rule is asserted on real geometry and computed styles, not on the CSS source.

import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import type { Network } from '../../../contracts/common.js';
import type { RenderRequest } from '../../../contracts/providers/renderer.js';
import { loadExampleSet } from '../../../example-set/index.js';
import { createSharpImages } from '../adapters/sharp-images.js';
import { contrastRatio, ensureGraphicContrast } from '../color.js';
import { type AssetLoader, type BusinessRenderContext, createDesignEngine, } from '../engine.js';
import { fixtureAssetLoader, fixtureBusiness, fixtureOverlayText, fixtureUrls, memoryFileStore } from '../fixtures/fixture.js';
import { hex, inSafeArea, probingRasterizer } from '../fixtures/probe.js';
import { matchImageSnapshot } from '../fixtures/snapshot.js';
import { styles } from './index.js';

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type Measured = {
  dir: string;
  canvas: { width: number; height: number };
  photo: Box | null;
  band: (Box & { background: string }) | null;
  bar: (Box & { background: string }) | null;
  overlay: (Box & { family: string; weight: string; color: string; fontSize: number; lines: number; textAlign: string }) | null;
  logo: (Box & { isText: boolean; family: string; weight: string; color: string; background: string }) | null;
  /** Elements other than photo, band, bar, overlay, and logo: Clean has none (no frame). */
  extras: string[];
};

const MEASURE_SCRIPT = `<script>
window.__layout = window.__layout.then((report) => {
  const box = (el) => { const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const q = (sel) => document.querySelector(sel);
  const cs = (el) => getComputedStyle(el);
  const photo = q('.photo'), band = q('.band'), bar = q('.bar'), overlay = q('[data-overlay]'), logo = q('[data-safe="logo"]');
  const known = new Set([photo, band, bar, overlay, logo].filter(Boolean));
  const extras = [...document.body.querySelectorAll('*')]
    .filter((el) => el.tagName !== 'SCRIPT' && !known.has(el) && ![...known].some((k) => k.contains(el)))
    .map((el) => el.className || el.tagName);
  const measured = {
    dir: document.documentElement.dir,
    canvas: { width: innerWidth, height: innerHeight },
    photo: photo && box(photo),
    band: band && { ...box(band), background: cs(band).backgroundColor },
    bar: bar && { ...box(bar), background: cs(bar).backgroundColor },
    overlay: overlay && { ...box(overlay), family: cs(overlay).fontFamily, weight: cs(overlay).fontWeight,
      color: cs(overlay).color, fontSize: parseFloat(cs(overlay).fontSize), textAlign: cs(overlay).textAlign,
      lines: Math.round(overlay.offsetHeight / parseFloat(cs(overlay).lineHeight)) },
    logo: logo && { ...box(logo), isText: logo.classList.contains('logo-text'), family: cs(logo).fontFamily,
      weight: cs(logo).fontWeight, color: cs(logo).color, background: cs(logo).backgroundColor },
    extras,
  };
  return { ...report, clean: measured };
});
</script>`;

const rasterizer = probingRasterizer(MEASURE_SCRIPT, (layout) => (layout as { clean: Measured }).clean);
const images = createSharpImages();
const store = memoryFileStore();

/** Example-set photo paths by the URL they are requested under; fixture assets otherwise. */
const examplePhotos = new Map<string, string>();
const assets: AssetLoader = {
  async load(url) {
    const path = examplePhotos.get(url);
    return path === undefined ? fixtureAssetLoader().load(url) : new Uint8Array(await readFile(path));
  },
};
const engine = createDesignEngine({ rasterizer, images, assets, store, styles });

afterAll(() => engine.close(), 30_000);

const NETWORKS: Network[] = ['instagram', 'facebook'];
const CANVAS = { width: 1080, height: 1350 };
const SAFE = 64;
const BAND_TOP = 945; // the photo fills the top 70%
const ACCENT = '#2F6BFF';

function request(overrides: Partial<RenderRequest> = {}): RenderRequest {
  return {
    style: 'clean',
    format: 'single',
    photoUrls: [fixtureUrls.landscape],
    overlayText: fixtureOverlayText,
    logoUrl: fixtureUrls.logo,
    brandColors: [],
    networks: ['instagram'],
    ...overrides,
  };
}

async function measure(req: RenderRequest, business: BusinessRenderContext = fixtureBusiness) {
  const before = rasterizer.slides.length;
  const result = await engine.forBusiness(business).render(req);
  return { result, slides: rasterizer.slides.slice(before) };
}

function insideSafeArea(b: Box) {
  expect(inSafeArea(b)).toBe(true);
}

/** Every Clean rule for a cover slide. */
function expectCleanCover(m: Measured, accent: string) {
  expect(m.canvas).toEqual(CANVAS);
  expect(m.extras).toEqual([]);
  // Layout: the photo fills the top 70%, the white band holds the rest.
  expect(m.photo).toMatchObject({ left: 0, top: 0, width: CANVAS.width, height: BAND_TOP });
  expect(m.band).toMatchObject({ left: 0, top: BAND_TOP, width: CANVAS.width, bottom: CANVAS.height, background: 'rgb(255, 255, 255)' });
  // Accent: a 12 px bar on the band's start edge.
  const bar = m.bar!;
  expect(bar.width).toBe(12);
  expect(bar).toMatchObject({ top: BAND_TOP, bottom: CANVAS.height });
  if (m.dir === 'rtl') expect(bar.right).toBe(CANVAS.width);
  else expect(bar.left).toBe(0);
  // The accent, darkened only as far as 3:1 on the white band needs (graphic contrast).
  expect(hex(bar.background)).toBe(ensureGraphicContrast(accent.toUpperCase(), '#FFFFFF'));
  // Overlay: Heebo 800, 52 to 72 px, at most 2 lines, start-aligned, readable on the band.
  const o = m.overlay!;
  expect(o.family).toContain('Heebo');
  expect(o.weight).toBe('800');
  expect(o.fontSize).toBeGreaterThanOrEqual(52);
  expect(o.fontSize).toBeLessThanOrEqual(72);
  expect(o.lines).toBeLessThanOrEqual(2);
  expect(o.textAlign).toBe('start');
  expect(o.top).toBeGreaterThanOrEqual(BAND_TOP);
  insideSafeArea(o);
  if (m.dir === 'rtl') expect(o.right).toBeCloseTo(CANVAS.width - SAFE, 0);
  else expect(o.left).toBeCloseTo(SAFE, 0);
  expect(contrastRatio(hex(o.color), hex(m.band!.background))).toBeGreaterThanOrEqual(4.5);
  // Logo: in the band, end side, vertically centered.
  const l = m.logo!;
  insideSafeArea(l);
  expect(l.top).toBeGreaterThanOrEqual(BAND_TOP);
  expect((l.top + l.bottom) / 2).toBeCloseTo((BAND_TOP + CANVAS.height) / 2, 0);
  if (m.dir === 'rtl') expect(l.left).toBeCloseTo(SAFE, 0);
  else expect(l.right).toBeCloseTo(CANVAS.width - SAFE, 0);
  expect(l.width).toBeLessThanOrEqual(240);
  if (l.isText) {
    expect(l.family).toContain('Heebo');
    expect(l.weight).toBe('800');
    expect(contrastRatio(hex(l.color), hex(m.band!.background))).toBeGreaterThanOrEqual(4.5);
  }
}

/** Every Clean rule for a carousel photo slide: full-bleed photo and the logo only. */
function expectCleanPhotoSlide(m: Measured) {
  expect(m.extras).toEqual([]);
  expect(m.photo).toMatchObject({ left: 0, top: 0, width: CANVAS.width, height: CANVAS.height });
  expect(m.band).toBeNull();
  expect(m.bar).toBeNull();
  expect(m.overlay).toBeNull();
  const l = m.logo!;
  insideSafeArea(l);
  expect(l.bottom).toBeCloseTo(CANVAS.height - SAFE, 0);
  if (m.dir === 'rtl') expect(l.left).toBeCloseTo(SAFE, 0);
  else expect(l.right).toBeCloseTo(CANVAS.width - SAFE, 0);
  if (l.isText) {
    expect(l.family).toContain('Heebo');
    expect(contrastRatio(hex(l.color), hex(l.background))).toBeGreaterThanOrEqual(4.5);
  }
}

describe('Clean style rules', { timeout: 120_000 }, () => {
  it('declares the Clean fonts, palette, and overlay sizes', () => {
    expect(styles.clean.fonts).toEqual({ headline: { family: 'Heebo', weight: 800 }, secondary: { family: 'Heebo', weight: 400 } });
    expect(styles.clean.palette).toEqual({ background: '#FFFFFF', text: '#111111', accent: ACCENT });
    expect(styles.clean.overlay).toEqual({ size: 72, minSize: 52 });
  });

  it('lays out a right-to-left cover with the logo', async () => {
    const { slides } = await measure(request());
    expect(slides[0]!.dir).toBe('rtl');
    expect(slides[0]!.logo!.isText).toBe(false);
    expectCleanCover(slides[0]!, ACCENT);
  });

  it('lays out a left-to-right cover for an English business', async () => {
    const { slides } = await measure(request({ overlayText: 'Weekend sale: 20% off all bouquets' }), {
      ...fixtureBusiness,
      businessName: 'Garden Flowers',
      languages: ['en', 'he'],
    });
    expect(slides[0]!.dir).toBe('ltr');
    expectCleanCover(slides[0]!, ACCENT);
  });

  it('sets the business name in Heebo 800 when there is no logo', async () => {
    const { logoUrl: _logo, ...withoutLogo } = request();
    const { slides } = await measure(withoutLogo);
    expect(slides[0]!.logo!.isText).toBe(true);
    expectCleanCover(slides[0]!, ACCENT);
  });

  it('replaces the accent with the first brand color and keeps text readable', async () => {
    const { slides } = await measure(request({ brandColors: ['#E8B4C8', '#7A3E5D'] }));
    expectCleanCover(slides[0]!, '#E8B4C8');
    // The pale pink alone would be a faint 1.9:1 bar on white.
    expect(hex(slides[0]!.bar!.background)).not.toBe('#E8B4C8');
  });

  it('shrinks a long overlay toward 52 px and keeps it within two lines', async () => {
    const { slides } = await measure(request({ overlayText: `${'ש'.repeat(15)} 20% הנחה` }));
    expect(slides[0]!.overlay!.fontSize).toBeLessThan(72);
    expectCleanCover(slides[0]!, ACCENT);
  });

  it('renders a carousel: a cover, then full-bleed photos with the logo only', async () => {
    const photoUrls = [fixtureUrls.landscape, fixtureUrls.portrait, fixtureUrls.square];
    for (const logoUrl of [fixtureUrls.logo, undefined]) {
      const req = request({ format: 'carousel', photoUrls });
      if (logoUrl === undefined) delete req.logoUrl;
      const { slides } = await measure(req);
      expect(slides).toHaveLength(3);
      expectCleanCover(slides[0]!, ACCENT);
      slides.slice(1).forEach(expectCleanPhotoSlide);
    }
  });
});

describe('Clean renders the example set', { timeout: 300_000 }, async () => {
  const entries = await loadExampleSet();

  it('covers all six example businesses', () => {
    expect(entries).toHaveLength(6);
  });

  for (const entry of entries) {
    it(`${entry.id}: every overlay text and a carousel on every network`, async () => {
      const business: BusinessRenderContext = {
        businessName: entry.profile.name,
        languages: entry.profile.languages,
        storagePrefix: `example/${entry.id}`,
      };
      const brandColors = entry.profile.brand.colors;
      const accent = brandColors[0] ?? ACCENT;
      const photoUrls = entry.photos.map((p, i) => {
        const url = `https://example-set.postly.test/${entry.id}/${i + 1}.svg`;
        examplePhotos.set(url, p.path);
        return url;
      });

      for (const [i, overlayText] of entry.expected.overlayTexts.entries()) {
        const { result, slides } = await measure(
          { style: 'clean', format: 'carousel', photoUrls, overlayText, brandColors, networks: NETWORKS },
          business,
        );
        for (const network of NETWORKS) expect(result[network]).toHaveLength(photoUrls.length);
        expectCleanCover(slides[0]!, accent);
        slides.slice(1).forEach(expectCleanPhotoSlide);
        if (i === 0) {
          const cover = store.files.get(result.instagram![0]!.storagePath)!.bytes;
          expect(await matchImageSnapshot(`clean-example-${entry.id}`, cover)).toEqual({ ok: true });
        }
      }
    });
  }
});
