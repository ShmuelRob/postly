// The carousel layouts and the photo edits, checked on the laid-out page (design-styles.md, "Photo
// edits and badge"): `numbered` adds a counter such as 2/3 on every slide after the cover and
// nothing else; `standard` adds nothing. An edit renders, a crop moves the cover focus, and a
// request with the wrong number of edits is refused.

import { afterAll, describe, expect, it } from 'vitest';
import type { RenderRequest } from '../../../contracts/providers/renderer.js';
import { createSharpImages } from '../adapters/sharp-images.js';
import { contrastRatio, MIN_CONTRAST } from '../color.js';
import { createDesignEngine } from '../engine.js';
import { fixtureAssetLoader, fixtureBusiness, fixtureOverlayText, fixtureUrls, memoryFileStore } from '../fixtures/fixture.js';
import { CANVAS, hex, inSafeArea, probingRasterizer, type Rect } from '../fixtures/probe.js';
import { styles } from './index.js';

type Counter = (Rect & { text: string; family: string; fontSize: number; color: string; background: string; dir: string; innerText: string }) | null;

const PROBE = `<script>
window.__layout = window.__layout.then((report) => {
  const c = document.querySelector('[data-counter]');
  const r = c && c.getBoundingClientRect();
  const s = c && c.querySelector('span');
  return { ...report, counter: c && { left: r.left, top: r.top, right: r.right, bottom: r.bottom, text: s.textContent,
    family: getComputedStyle(c).fontFamily, fontSize: parseFloat(getComputedStyle(c).fontSize), color: getComputedStyle(c).color,
    background: getComputedStyle(c).backgroundColor, dir: s.dir, innerText: document.body.innerText.trim() },
    counters: document.querySelectorAll('[data-counter]').length };
});
</script>`;

const rasterizer = probingRasterizer(PROBE, (layout) => (layout as { counter: Counter }).counter);
const store = memoryFileStore();
const engine = createDesignEngine({ rasterizer, images: createSharpImages(), assets: fixtureAssetLoader(), store, styles });
afterAll(() => engine.close(), 60_000);

const STYLES = ['clean', 'warm', 'dynamic'] as const;
const photoUrls = [fixtureUrls.landscape, fixtureUrls.portrait, fixtureUrls.square];

const request = (style: (typeof STYLES)[number], overrides: Partial<RenderRequest> = {}): RenderRequest => ({
  style,
  format: 'carousel',
  photoUrls,
  overlayText: fixtureOverlayText,
  logoUrl: fixtureUrls.logo,
  brandColors: [],
  networks: ['instagram'],
  ...overrides,
});

async function slides(req: RenderRequest) {
  const before = rasterizer.slides.length;
  const result = await engine.forBusiness(fixtureBusiness).render(req);
  return { counters: rasterizer.slides.slice(before), result };
}

describe('the numbered carousel layout', { timeout: 120_000 }, () => {
  for (const style of STYLES) {
    it(`${style}: a counter on every slide after the cover, and nothing else on them`, async () => {
      const { counters } = await slides(request(style, { carouselLayout: 'numbered' }));
      expect(counters[0]).toBeNull();
      for (const [i, c] of counters.slice(1).entries()) {
        expect(c, `slide ${i + 2}`).not.toBeNull();
        expect(c!.text).toBe(`${i + 2}/3`);
        expect(c!.dir).toBe('ltr');
        // The only text on the slide (the logo is an image here).
        expect(c!.innerText).toBe(c!.text);
        // 32 px in the style's secondary font, bottom start corner, inside the safe area.
        expect(c!.fontSize).toBe(32);
        expect(c!.family).toContain(styles[style].fonts.secondary.family);
        expect(inSafeArea(c!)).toBe(true);
        expect(c!.bottom).toBeCloseTo(CANVAS.height - 64, 0);
        // The start corner: the right side in a Hebrew (right to left) post.
        expect(c!.right).toBeCloseTo(CANVAS.width - 64, 0);
      }
    });

    it(`${style}: text 4.5:1 on a panel of the style's background`, async () => {
      const { counters } = await slides(request(style, { carouselLayout: 'numbered' }));
      const c = counters[1]!;
      expect(hex(c.background)).toBe(styles[style].palette.background);
      expect(contrastRatio(hex(c.color), hex(c.background))).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });

    it(`${style}: the standard layout, and no layout, draw no counter`, async () => {
      for (const carouselLayout of [undefined, 'standard' as const]) {
        const { counters } = await slides(request(style, carouselLayout ? { carouselLayout } : {}));
        expect(counters.every((c) => c === null)).toBe(true);
      }
    });
  }

  it('a single post has no counter, even when numbered is asked for', async () => {
    const { counters } = await slides(request('clean', { format: 'single', photoUrls: [photoUrls[0]!], carouselLayout: 'numbered' }));
    expect(counters).toEqual([null]);
  });
});

describe('photo edits', { timeout: 120_000 }, () => {
  const single = (style: (typeof STYLES)[number], overrides: Partial<RenderRequest> = {}) =>
    request(style, { format: 'single', photoUrls: [photoUrls[0]!], ...overrides });
  const bytesOf = (result: Awaited<ReturnType<typeof slides>>['result']) => store.files.get(result.instagram![0]!.storagePath)!.bytes;

  it('renders a straightened, toned photo, and it differs from the original', async () => {
    const plain = await slides(single('clean'));
    const edited = await slides(single('clean', { edits: [{ rotateDeg: 4, brightness: 0.15, contrast: 0.1 }] }));
    expect(Buffer.from(bytesOf(edited.result)).equals(Buffer.from(bytesOf(plain.result)))).toBe(false);
  });

  it('a crop moves the cover focus: the same photo with a different crop renders differently', async () => {
    const left = await slides(single('dynamic', { edits: [{ crop: { x: 0, y: 0, w: 0.5, h: 1 } }] }));
    const right = await slides(single('dynamic', { edits: [{ crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }] }));
    expect(Buffer.from(bytesOf(left.result)).equals(Buffer.from(bytesOf(right.result)))).toBe(false);
  });

  it('refuses one edit too few for the photos, and a value out of range', async () => {
    await expect(engine.forBusiness(fixtureBusiness).render(request('clean', { edits: [{}, {}] }))).rejects.toThrow(/One edit per photo/);
    await expect(engine.forBusiness(fixtureBusiness).render(single('clean', { edits: [{ rotateDeg: 11 }] }))).rejects.toThrow();
  });
});
