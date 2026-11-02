// The design engine: turns a RenderRequest into one JPEG per slide per network.
// It is vendor-free; the browser and image library come in through the ports below
// (Playwright and sharp in ./adapters/).

import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { Language, Network } from '../../contracts/common.js';
import {
  RenderRequest,
  RenderResult,
  type TemplateRenderer,
} from '../../contracts/providers/renderer.js';
import { resolvePalette } from './color.js';
import { buildDocument, LayoutReport } from './document.js';
import { OverlayTextError, RenderError } from './errors.js';
import {
  directionFor,
  LOGO_BOX,
  MAX_CAROUSEL_SLIDES,
  MAX_OVERLAY_CHARS,
  MAX_OVERLAY_LINES,
  MIN_CAROUSEL_SLIDES,
  type NormalizedCrop,
  OUTPUT_SIZES,
  overlayLength,
  overlaySizes,
  SAFE_AREA,
  type Size,
} from './layout.js';
import type { StyleRegistry } from './styles/index.js';
import type { LogoImage, LogoText, SlideContext, SlideKind } from './styles/types.js';

/** Resolves a photo or logo URL to its bytes before rendering (from storage, not from the page). */
export interface AssetLoader {
  load(url: string): Promise<Uint8Array>;
}

/** Where rendered files go; `storagePath` in the result is the path given here. */
export interface FileStore {
  put(path: string, bytes: Uint8Array, mimeType: 'image/jpeg'): Promise<void>;
}

export interface Rasterizer {
  /** Lays out a self-contained page with no network access and screenshots it as PNG. */
  rasterize(page: { html: string } & Size): Promise<{ png: Uint8Array; layout: unknown }>;
  close(): Promise<void>;
}

export interface ImageProcessor {
  /** Cover-crops a photo to the box, centered on the crop when one is given; returns PNG. */
  coverCrop(photo: Uint8Array, box: Size, crop?: NormalizedCrop): Promise<Uint8Array>;
  /** Scales a logo to fit the square box, never upscaling; returns PNG and its size. */
  fitLogo(logo: Uint8Array, box: number): Promise<{ png: Uint8Array } & Size>;
  /** JPEG, quality 90, sRGB, no metadata. */
  toJpeg(png: Uint8Array): Promise<Uint8Array>;
}

/**
 * Business details the renderer needs that RenderRequest does not carry (see the PR
 * for WP-11): the language that sets the direction, the name used when there is no
 * logo, the image_review crops, and the storage prefix for the business.
 */
export type BusinessRenderContext = {
  businessName: string;
  languages: z.infer<typeof Language>[];
  storagePrefix: string;
  /** Normalized crops from image_review, keyed by photo URL. */
  photoCrops?: Record<string, NormalizedCrop>;
};

export type DesignEngineDeps = {
  rasterizer: Rasterizer;
  images: ImageProcessor;
  assets: AssetLoader;
  store: FileStore;
  styles: StyleRegistry;
};

export type DesignEngine = {
  forBusiness(business: BusinessRenderContext): TemplateRenderer;
  close(): Promise<void>;
};

function pngDataUri(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

function checkRequest(request: RenderRequest): void {
  const photos = request.photoUrls.length;
  if (request.format === 'single' && photos !== 1) {
    throw new RenderError(`A single post takes exactly 1 photo, got ${photos}`);
  }
  if (request.format === 'carousel' && (photos < MIN_CAROUSEL_SLIDES || photos > MAX_CAROUSEL_SLIDES)) {
    throw new RenderError(`A carousel takes ${MIN_CAROUSEL_SLIDES} to ${MAX_CAROUSEL_SLIDES} photos, got ${photos}`);
  }
  if (overlayLength(request.overlayText) > MAX_OVERLAY_CHARS) {
    throw new OverlayTextError('too_long', `Overlay text is longer than ${MAX_OVERLAY_CHARS} characters`);
  }
}

/** Networks grouped by canvas size, so each distinct size is rendered once. */
function groupBySize(networks: readonly Network[]): { size: Size; networks: Network[] }[] {
  const groups = new Map<string, { size: Size; networks: Network[] }>();
  for (const network of networks) {
    const size = OUTPUT_SIZES[network];
    const key = `${size.width}x${size.height}`;
    const group = groups.get(key) ?? { size, networks: [] };
    group.networks.push(network);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function createDesignEngine(deps: DesignEngineDeps): DesignEngine {
  const { rasterizer, images, assets, store, styles } = deps;

  async function render(business: BusinessRenderContext, input: RenderRequest): Promise<RenderResult> {
    const request = RenderRequest.parse(input);
    checkRequest(request);

    const style = styles[request.style];
    const language = business.languages[0] ?? 'he';
    const dir = directionFor(business.languages);
    const palette = resolvePalette(style.palette, request.brandColors);
    const overlayText = request.overlayText.trim();
    const sizes = overlaySizes(style.overlay.size, style.overlay.minSize);

    const photos = await Promise.all(request.photoUrls.map((url) => assets.load(url)));
    let logo: LogoImage | LogoText = { kind: 'text', text: business.businessName };
    if (request.logoUrl !== undefined) {
      const fitted = await images.fitLogo(await assets.load(request.logoUrl), LOGO_BOX);
      logo = { kind: 'image', dataUri: pngDataUri(fitted.png), width: fitted.width, height: fitted.height };
    }

    // Content-addressed folder: the same request for the same business gives the same paths.
    const renderId = createHash('sha256')
      .update(JSON.stringify({ request, business }))
      .digest('hex')
      .slice(0, 24);

    const result: RenderResult = {};
    for (const group of groupBySize(request.networks)) {
      for (const [index, photoBytes] of photos.entries()) {
        const kind: SlideKind = index === 0 ? 'cover' : 'photo';
        const box = style.photoBox(kind, group.size);
        const crop = business.photoCrops?.[request.photoUrls[index]!];
        const photo = await images.coverCrop(photoBytes, box, crop);
        const ctx: SlideContext = {
          kind,
          canvas: group.size,
          language,
          dir,
          palette,
          photo: { dataUri: pngDataUri(photo), ...box },
          logo,
          overlayText: kind === 'cover' ? overlayText : '',
          safeArea: SAFE_AREA,
        };

        const { png, layout: raw } = await rasterizer.rasterize({ html: buildDocument(style, ctx, sizes), ...group.size });
        const layout = LayoutReport.parse(raw);
        if (!layout.fontsLoaded) throw new RenderError(`Fonts for ${request.style} did not load`);
        if (layout.overlay && layout.overlay.fontSize === null) {
          throw new OverlayTextError(
            'does_not_fit',
            `Overlay text does not fit in ${MAX_OVERLAY_LINES} lines at ${style.overlay.minSize}px`,
          );
        }
        if (layout.safeAreaViolations.length > 0) {
          throw new RenderError(`Outside the safe area in ${request.style}: ${layout.safeAreaViolations.join(', ')}`);
        }

        const jpeg = await images.toJpeg(png);
        for (const network of group.networks) {
          const storagePath = `${business.storagePrefix}/${renderId}/${network}/${index + 1}.jpg`;
          await store.put(storagePath, jpeg, 'image/jpeg');
          (result[network] ??= []).push({ storagePath, ...group.size, mimeType: 'image/jpeg' });
        }
      }
    }
    return RenderResult.parse(result);
  }

  return {
    forBusiness: (business) => ({ render: (request) => render(business, request) }),
    close: () => rasterizer.close(),
  };
}
