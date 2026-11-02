import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { Network, VisualStyle } from '../../contracts/common.js';
import type { RenderRequest } from '../../contracts/providers/renderer.js';
import { createPlaywrightRasterizer } from './adapters/playwright-rasterizer.js';
import { createSharpImages } from './adapters/sharp-images.js';
import type { BusinessRenderContext } from './engine.js';
import { NetworkAccessError, OverlayTextError, RenderError } from './errors.js';
import {
  fixtureAssetLoader,
  fixtureBusiness,
  fixtureOverlayText,
  fixtureUrls,
  memoryFileStore,
} from './fixtures/fixture.js';
import { matchImageSnapshot } from './fixtures/snapshot.js';
import { createDesignRenderer, type DesignRenderer } from './index.js';

const STYLES: z.infer<typeof VisualStyle>[] = ['clean', 'warm', 'dynamic'];
const NETWORKS: Network[] = ['instagram', 'facebook'];

const images = createSharpImages();
const store = memoryFileStore();
let renderer: DesignRenderer;

beforeAll(() => {
  renderer = createDesignRenderer({ assets: fixtureAssetLoader(), store });
});

afterAll(async () => {
  await renderer.close();
});

function request(overrides: Partial<RenderRequest> = {}): RenderRequest {
  return {
    style: 'clean',
    format: 'single',
    photoUrls: [fixtureUrls.landscape],
    overlayText: fixtureOverlayText,
    logoUrl: fixtureUrls.logo,
    brandColors: [],
    networks: NETWORKS,
    ...overrides,
  };
}

function stored(path: string): Uint8Array {
  const file = store.files.get(path);
  if (!file) throw new Error(`Nothing stored at ${path}`);
  return file.bytes;
}

/** Renders, checks the files of every network, and snapshots each slide once. */
async function renderAndSnapshot(name: string, req: RenderRequest, business: BusinessRenderContext = fixtureBusiness) {
  const result = await renderer.forBusiness(business).render(req);
  const slides = req.format === 'single' ? 1 : req.photoUrls.length;
  const perNetwork = req.networks.map((network) => {
    const files = result[network] ?? [];
    expect(files, network).toHaveLength(slides);
    return files;
  });

  for (const files of perNetwork) {
    for (const file of files) {
      expect(file).toMatchObject({ width: 1080, height: 1350, mimeType: 'image/jpeg' });
      expect(file.storagePath.startsWith(`${business.storagePrefix}/`)).toBe(true);
      expect(store.files.get(file.storagePath)?.mimeType).toBe('image/jpeg');
      expect(await images.inspect(stored(file.storagePath))).toEqual({
        format: 'jpeg',
        width: 1080,
        height: 1350,
        space: 'srgb',
        hasMetadata: false,
      });
    }
  }

  // The canvas is the same for every network today, so every network gets the same slides.
  const [first = [], ...others] = perNetwork;
  for (const files of others) {
    files.forEach((file, i) => expect(stored(file.storagePath)).toEqual(stored(first[i]!.storagePath)));
  }

  for (const [i, file] of first.entries()) {
    expect(await matchImageSnapshot(`${name}-${i + 1}`, stored(file.storagePath))).toEqual({ ok: true });
  }
}

describe('design engine: every style on every network', { timeout: 120_000 }, () => {
  for (const style of STYLES) {
    it(`renders a single post in ${style}`, async () => {
      await renderAndSnapshot(`${style}-single`, request({ style }));
    });

    it(`renders a carousel in ${style}: a cover, then photos with the frame and logo`, async () => {
      await renderAndSnapshot(
        `${style}-carousel`,
        request({
          style,
          format: 'carousel',
          photoUrls: [fixtureUrls.landscape, fixtureUrls.portrait, fixtureUrls.square],
        }),
      );
    });
  }
});

describe('design engine: rules from design-styles.md', { timeout: 120_000 }, () => {
  it('sets the business name in the headline font when there is no logo', async () => {
    const { logoUrl: _logo, ...withoutLogo } = request({ style: 'warm', photoUrls: [fixtureUrls.portrait] });
    await renderAndSnapshot('warm-no-logo', withoutLogo);
  });

  it('applies brand colors and keeps the overlay text readable', async () => {
    // Yellow replaces the Dynamic accent; white text on it fails AA, so the text turns dark.
    await renderAndSnapshot(
      'dynamic-brand-colors',
      request({ style: 'dynamic', brandColors: ['#FFE14D', '#2E6F6A'], photoUrls: [fixtureUrls.square] }),
    );
  });

  it('lays out left to right for an English business', async () => {
    await renderAndSnapshot('clean-ltr', request({ overlayText: 'Weekend sale: 20% off all bouquets' }), {
      ...fixtureBusiness,
      businessName: 'Garden Flowers',
      languages: ['en'],
    });
  });

  it('rejects overlay text longer than 40 characters', async () => {
    const render = renderer.forBusiness(fixtureBusiness).render(request({ overlayText: 'א'.repeat(41) }));
    await expect(render).rejects.toBeInstanceOf(OverlayTextError);
    await expect(render).rejects.toMatchObject({ code: 'too_long' });
  });

  it('fails when the text does not fit in two lines at the minimum size', async () => {
    const render = renderer.forBusiness(fixtureBusiness).render(request({ overlayText: 'ש'.repeat(38) }));
    await expect(render).rejects.toBeInstanceOf(OverlayTextError);
    await expect(render).rejects.toMatchObject({ code: 'does_not_fit' });
  });

  it('requires 2 to 10 photos for a carousel and exactly one for a single post', async () => {
    const business = renderer.forBusiness(fixtureBusiness);
    await expect(business.render(request({ format: 'carousel' }))).rejects.toBeInstanceOf(RenderError);
    await expect(
      business.render(request({ photoUrls: [fixtureUrls.landscape, fixtureUrls.square] })),
    ).rejects.toBeInstanceOf(RenderError);
  });

  it('names files deterministically per network and slide', async () => {
    const business = renderer.forBusiness(fixtureBusiness);
    const a = await business.render(request({ networks: ['instagram'] }));
    const b = await business.render(request({ networks: ['instagram'] }));
    expect(a).toEqual(b);
    expect(a.instagram?.[0]?.storagePath).toMatch(/^test\/renders\/[0-9a-f]{24}\/instagram\/1\.jpg$/);
  });
});

describe('design adapters', { timeout: 60_000 }, () => {
  it('fits the logo into 160 x 160 without upscaling', async () => {
    const loader = fixtureAssetLoader();
    expect(await images.fitLogo(await loader.load(fixtureUrls.logo), 160)).toMatchObject({ width: 160, height: 160 });
    expect(await images.fitLogo(await loader.load(fixtureUrls.logoSmall), 160)).toMatchObject({
      width: 100,
      height: 60,
    });
  });

  it('blocks every network request during rendering', async () => {
    const rasterizer = createPlaywrightRasterizer();
    try {
      const html =
        '<!doctype html><html><body><img src="https://example.com/x.png">' +
        '<script>window.__layout = Promise.resolve({ fontsLoaded: true, overlay: null, safeAreaViolations: [] });</script>' +
        '</body></html>';
      await expect(rasterizer.rasterize({ html, width: 100, height: 100 })).rejects.toBeInstanceOf(NetworkAccessError);
    } finally {
      await rasterizer.close();
    }
  });
});
