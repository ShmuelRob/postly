// Layout rules from design-styles.md that do not depend on a browser.

import type { z } from 'zod';
import type { Language, Network } from '../../contracts/common.js';

export type Size = { width: number; height: number };
export type Direction = 'rtl' | 'ltr';
/**
 * A normalized focus rectangle for the cover crop: the `image_review` suggestion, or the agent's
 * `DesignSpec` crop. One shape for both (`EditCrop`: x, y, w, h in 0..1).
 */
export type NormalizedCrop = { x: number; y: number; w: number; h: number };

/** Canvas per network. 4:5 everywhere for now; the engine renders once per distinct size. */
export const OUTPUT_SIZES: Record<Network, Size> = {
  instagram: { width: 1080, height: 1350 },
  facebook: { width: 1080, height: 1350 },
};

export const SAFE_AREA = 64;
export const LOGO_BOX = 160;
export const MAX_OVERLAY_CHARS = 40;
export const MAX_OVERLAY_LINES = 2;
export const JPEG_QUALITY = 90;
export const MIN_CAROUSEL_SLIDES = 2;
export const MAX_CAROUSEL_SLIDES = 10;

const RTL_LANGUAGES: ReadonlySet<z.infer<typeof Language>> = new Set(['he', 'ar']);

/** A mix of languages follows the first one. */
export function directionFor(languages: readonly z.infer<typeof Language>[]): Direction {
  const first = languages[0];
  return first !== undefined && RTL_LANGUAGES.has(first) ? 'rtl' : 'ltr';
}

/** Font sizes to try, from the style size down to its minimum in 2 px steps. */
export function overlaySizes(size: number, minSize: number): number[] {
  const sizes: number[] = [];
  for (let s = size; s > minSize; s -= 2) sizes.push(s);
  sizes.push(minSize);
  return sizes;
}

export function overlayLength(text: string): number {
  return [...text.trim()].length;
}

/**
 * Cover crop: scale the photo to cover the box, then pick the box-sized window
 * centered on the crop (or the photo center), clamped to the scaled photo.
 */
export function coverWindow(
  photo: Size,
  box: Size,
  crop?: NormalizedCrop,
): { resize: Size; left: number; top: number } {
  const scale = Math.max(box.width / photo.width, box.height / photo.height);
  const resize = {
    width: Math.max(box.width, Math.round(photo.width * scale)),
    height: Math.max(box.height, Math.round(photo.height * scale)),
  };
  const cx = crop ? crop.x + crop.w / 2 : 0.5;
  const cy = crop ? crop.y + crop.h / 2 : 0.5;
  const clamp = (v: number, max: number) => Math.min(Math.max(Math.round(v), 0), max);
  return {
    resize,
    left: clamp(cx * resize.width - box.width / 2, resize.width - box.width),
    top: clamp(cy * resize.height - box.height / 2, resize.height - box.height),
  };
}
