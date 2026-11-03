// Dynamic style rules (design-styles.md, "Dynamic"), measured in the rendered page:
// the engine renders for real, and a probe added to each page reports the computed
// geometry and styles of the Dynamic elements next to the engine's own layout report.

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Network } from '../../../contracts/common.js';
import type { RenderRequest } from '../../../contracts/providers/renderer.js';
import { loadExampleSet, type ExampleEntry } from '../../../example-set/index.js';
import { createSharpImages } from '../adapters/sharp-images.js';
import { contrastRatio, MIN_CONTRAST } from '../color.js';
import { createDesignEngine, type BusinessRenderContext, type DesignEngine } from '../engine.js';
import {
  fixtureAssetLoader,
  fixtureBusiness,
  fixtureOverlayText,
  fixtureUrls,
  memoryFileStore,
} from '../fixtures/fixture.js';
import { hex, inSafeArea, probingRasterizer, type Rect } from '../fixtures/probe.js';
import { matchImageSnapshot } from '../fixtures/snapshot.js';
import { styles } from './index.js';

const NETWORKS: Network[] = ['instagram', 'facebook'];
const W = 1080;
const H = 1350;
const SAFE = 64;

type Probe = {
  dir: string;
  photo: Rect | null;
  band: { rect: Rect; transform: string; background: string } | null;
  overlay: { rect: Rect; color: string; family: string; weight: string; fontSize: number; lines: number } | null;
  stripes: { rect: Rect; background: string; transform: string }[];
  logo: { rect: Rect; kind: 'image' | 'text'; filter: string; color: string; family: string; weight: string } | null;
};

// Runs in the page after the engine's fit script, so the overlay already has its size.
const PROBE = `<script>
window.__layout = window.__layout.then((layout) => {
  const rect = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
  const cs = (n) => getComputedStyle(n);
  const photo = document.querySelector('.photo');
  const band = document.querySelector('.band');
  const overlay = document.querySelector('[data-overlay]');
  const logo = document.querySelector('[data-safe="logo"]');
  const probe = {
    dir: document.documentElement.dir,
    photo: photo && rect(photo),
    band: band && { rect: rect(band), transform: cs(band).transform, background: cs(band).backgroundColor },
    overlay: overlay && {
      rect: rect(overlay), color: cs(overlay).color, family: cs(overlay).fontFamily, weight: cs(overlay).fontWeight,
      fontSize: parseFloat(cs(overlay).fontSize),
      lines: Math.round(overlay.offsetHeight / parseFloat(cs(overlay).lineHeight)),
    },
    stripes: [...document.querySelectorAll('.stripe')].map((n) => ({ rect: rect(n), background: cs(n).backgroundColor, transform: cs(n).transform })),
    logo: logo && {
      rect: rect(logo), kind: logo.tagName === 'IMG' ? 'image' : 'text', filter: cs(logo).filter, color: cs(logo).color,
      family: cs(logo).fontFamily, weight: cs(logo).fontWeight,
    },
  };
  return { ...layout, probe };
});
</script>`;

const rasterizer = probingRasterizer(PROBE, (layout) => (layout as { probe: Probe }).probe);
const probes = rasterizer.slides;

const exampleFiles = new Map<string, string>();
const store = memoryFileStore();
let engine: DesignEngine;

beforeAll(() => {
  const fixtures = fixtureAssetLoader();
  engine = createDesignEngine({
    rasterizer,
    images: createSharpImages(),
    store,
    styles,
    assets: {
      load: async (url) => {
        const path = exampleFiles.get(url);
        return path === undefined ? fixtures.load(url) : new Uint8Array(readFileSync(path));
      },
    },
  });
});

afterAll(async () => {
  await engine.close();
}, 30_000);

function request(overrides: Partial<RenderRequest> = {}): RenderRequest {
  return {
    style: 'dynamic',
    format: 'single',
    photoUrls: [fixtureUrls.landscape],
    overlayText: fixtureOverlayText,
    logoUrl: fixtureUrls.logo,
    brandColors: [],
    networks: NETWORKS,
    ...overrides,
  };
}

/** Renders and returns the probes of the slides of the first network (both networks share a size). */
async function render(req: RenderRequest, business: BusinessRenderContext = fixtureBusiness) {
  probes.length = 0;
  const result = await engine.forBusiness(business).render(req);
  for (const network of req.networks) {
    expect(result[network], network).toHaveLength(req.format === 'single' ? 1 : req.photoUrls.length);
    for (const file of result[network] ?? []) expect(file).toMatchObject({ width: W, height: H, mimeType: 'image/jpeg' });
  }
  return { result, slides: probes.slice() };
}

function stored(path: string): Uint8Array {
  const file = store.files.get(path);
  if (!file) throw new Error(`Nothing stored at ${path}`);
  return file.bytes;
}

/** Rotation in degrees from a computed `matrix(a, b, c, d, e, f)`. */
function rotation(transform: string): number {
  const [a, b] = (transform.match(/-?[\d.e-]+/g) ?? []).map(Number);
  return Math.round((Math.atan2(b ?? 0, a ?? 1) * 180) / Math.PI * 10) / 10;
}

const centerX = (r: Rect) => (r.left + r.right) / 2;
const centerY = (r: Rect) => (r.top + r.bottom) / 2;

type Palette = { accent: string; secondary: string };
const STYLE_PALETTE: Palette = { accent: '#FF3D5A', secondary: '#FFC83D' };

/** Every Dynamic rule that holds on any cover slide. */
function expectDynamicCover(slide: Probe, palette: Palette) {
  // Full-bleed photo, no frame.
  expect(slide.photo).toEqual({ left: 0, top: 0, right: W, bottom: H });

  // Accent band rotated -4 degrees across the lower third, edge to edge.
  const band = slide.band!;
  expect(band).not.toBeNull();
  expect(rotation(band.transform)).toBe(-4);
  expect(hex(band.background)).toBe(palette.accent);
  expect(band.rect.left).toBeLessThanOrEqual(0);
  expect(band.rect.right).toBeGreaterThanOrEqual(W);
  expect(centerY(band.rect)).toBeGreaterThanOrEqual((H * 2) / 3);
  expect(band.rect.bottom).toBeLessThanOrEqual(H);

  // Overlay: Rubik 900, 56 to 80 px, at most 2 lines, AA contrast on the band, inside the safe area.
  const overlay = slide.overlay!;
  expect(overlay.family).toContain('Rubik');
  expect(overlay.weight).toBe('900');
  expect(overlay.fontSize).toBeGreaterThanOrEqual(56);
  expect(overlay.fontSize).toBeLessThanOrEqual(80);
  expect(overlay.lines).toBeLessThanOrEqual(2);
  expect(contrastRatio(hex(overlay.color), palette.accent)).toBeGreaterThanOrEqual(MIN_CONTRAST);
  expect(inSafeArea(overlay.rect)).toBe(true);
  expect(centerY(overlay.rect)).toBeGreaterThanOrEqual((H * 2) / 3);

  expectDynamicChrome(slide, palette);
}

/** Stripes and logo, on every slide. */
function expectDynamicChrome(slide: Probe, palette: Palette) {
  const startIsRight = slide.dir === 'rtl';
  // Two diagonal stripes in the secondary color, in the top start corner (opposite the band).
  expect(slide.stripes).toHaveLength(2);
  for (const stripe of slide.stripes) {
    expect(hex(stripe.background)).toBe(palette.secondary);
    expect(Math.abs(rotation(stripe.transform))).toBe(45);
    expect(centerY(stripe.rect)).toBeLessThan(H / 3);
    if (startIsRight) expect(centerX(stripe.rect)).toBeGreaterThan(W / 2);
    else expect(centerX(stripe.rect)).toBeLessThan(W / 2);
  }

  // Logo: top corner on the end side, white, inside the safe area.
  const logo = slide.logo!;
  expect(inSafeArea(logo.rect)).toBe(true);
  expect(logo.rect.top).toBeLessThan(SAFE + 1);
  if (startIsRight) expect(logo.rect.left).toBeLessThan(W / 2);
  else expect(logo.rect.right).toBeGreaterThan(W / 2);
  if (logo.kind === 'image') {
    expect(logo.filter).toBe('brightness(0) invert(1)');
    expect(logo.rect.right - logo.rect.left).toBeLessThanOrEqual(160);
    expect(logo.rect.bottom - logo.rect.top).toBeLessThanOrEqual(160);
  } else {
    expect(hex(logo.color)).toBe('#FFFFFF');
    expect(logo.family).toContain('Rubik');
    expect(logo.weight).toBe('900');
  }
}

describe('Dynamic style', { timeout: 60_000 }, () => {
  it('renders a Hebrew cover within every rule', async () => {
    const { result, slides } = await render(request());
    expect(slides[0]!.dir).toBe('rtl');
    expectDynamicCover(slides[0]!, STYLE_PALETTE);
    expect(slides[0]!.logo!.kind).toBe('image');
    expect(await matchImageSnapshot('dynamic-rules-single-1', stored(result.instagram![0]!.storagePath))).toEqual({ ok: true });
  });

  it('mirrors the stripes and logo for a left-to-right business', async () => {
    const { result, slides } = await render(request({ overlayText: 'Weekend sale: 20% off all bouquets' }), {
      ...fixtureBusiness,
      businessName: 'Garden Flowers',
      languages: ['en'],
    });
    expect(slides[0]!.dir).toBe('ltr');
    expectDynamicCover(slides[0]!, STYLE_PALETTE);
    expect(await matchImageSnapshot('dynamic-ltr-1', stored(result.instagram![0]!.storagePath))).toEqual({ ok: true });
  });

  it('sets the business name in white Rubik 900 at the logo position when there is no logo', async () => {
    const { logoUrl: _, ...withoutLogo } = request();
    const { result, slides } = await render(withoutLogo);
    expect(slides[0]!.logo!.kind).toBe('text');
    expectDynamicCover(slides[0]!, STYLE_PALETTE);
    expect(await matchImageSnapshot('dynamic-no-logo-1', stored(result.instagram![0]!.storagePath))).toEqual({ ok: true });
  });

  it('substitutes brand colors and keeps the overlay text at AA contrast', async () => {
    // Yellow replaces the accent; white text on it fails AA, so the text turns dark.
    const { result, slides } = await render(
      request({ brandColors: ['#FFE14D', '#2E6F6A'], photoUrls: [fixtureUrls.square] }),
    );
    expectDynamicCover(slides[0]!, { accent: '#FFE14D', secondary: '#2E6F6A' });
    expect(hex(slides[0]!.overlay!.color)).not.toBe('#FFFFFF');
    expect(await matchImageSnapshot('dynamic-rules-brand-colors-1', stored(result.instagram![0]!.storagePath))).toEqual({
      ok: true,
    });
  });

  it('keeps white overlay text on a dark brand accent', async () => {
    const { slides } = await render(request({ brandColors: ['#1F3A5F'] }));
    expectDynamicCover(slides[0]!, { accent: '#1F3A5F', secondary: STYLE_PALETTE.secondary });
    expect(hex(slides[0]!.overlay!.color)).toBe('#FFFFFF');
  });

  it('keeps an explicit line break and shrinks long text no lower than 56 px', async () => {
    const { slides } = await render(request({ overlayText: 'סביח\nחדש' }));
    expect(slides[0]!.overlay!.lines).toBe(2);
    expectDynamicCover(slides[0]!, STYLE_PALETTE);

    const long = await render(request({ overlayText: 'מבצע ענק לסוף השבוע: חצי מחיר לכל הזרים' }));
    expectDynamicCover(long.slides[0]!, STYLE_PALETTE);
  });

  it('draws the band only on the cover of a carousel; later slides keep stripes and logo', async () => {
    const { slides } = await render(
      request({ format: 'carousel', photoUrls: [fixtureUrls.landscape, fixtureUrls.portrait, fixtureUrls.square] }),
    );
    expect(slides).toHaveLength(3);
    expectDynamicCover(slides[0]!, STYLE_PALETTE);
    for (const slide of slides.slice(1)) {
      expect(slide.band).toBeNull();
      expect(slide.overlay).toBeNull();
      expect(slide.photo).toEqual({ left: 0, top: 0, right: W, bottom: H });
      expectDynamicChrome(slide, STYLE_PALETTE);
    }
  });

  describe('example set', async () => {
    const entries: ExampleEntry[] = await loadExampleSet();

    it.each(entries.map((e) => [e.id, e] as const))('renders %s in Dynamic within the rules', async (id, entry) => {
      const photoUrls = entry.photos.map((photo, i) => {
        const url = `https://example-set.test/${id}/${i}`;
        exampleFiles.set(url, photo.path);
        return url;
      });
      const brand = entry.profile.brand.colors;
      const palette: Palette = { accent: brand[0] ?? STYLE_PALETTE.accent, secondary: brand[1] ?? STYLE_PALETTE.secondary };
      const business: BusinessRenderContext = {
        businessName: entry.profile.name,
        languages: entry.profile.languages,
        storagePrefix: `examples/${id}`,
      };

      for (const [i, overlayText] of entry.expected.overlayTexts.entries()) {
        const { result, slides } = await render(
          { style: 'dynamic', format: 'carousel', photoUrls, overlayText, brandColors: brand, networks: NETWORKS },
          business,
        );
        expectDynamicCover(slides[0]!, palette);
        for (const slide of slides.slice(1)) expectDynamicChrome(slide, palette);
        if (i === 0) {
          expect(await matchImageSnapshot(`dynamic-example-${id}`, stored(result.instagram![0]!.storagePath))).toEqual({
            ok: true,
          });
        }
      }
    });
  });
});
