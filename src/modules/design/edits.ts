// The fixed photo operations (design-styles.md, "Photo edits and badge"; agent.md, Photo edits):
// straighten, then tone. The maths is here and the pixels are in the sharp adapter
// (adapters/sharp-images.ts, `edit`), so this file has no vendor import. The crop is not applied by
// `edit`: it is the focus of the 4:5 cover crop, which the engine does next (layout.ts, coverWindow).
// Nothing here creates, removes or alters what a photo shows, and there are no filters: tone is one
// linear function of each channel.

import type { Size } from './layout.js';

/** Contrast pivots on mid grey, so a light photo gets lighter and a dark one darker. */
export const TONE_PIVOT = 128;

/**
 * The largest rectangle of the photo's own aspect that fits inside the photo rotated by `deg`, so
 * that no empty corner shows after straightening. Centered; sizes are rounded down, and a turned photo
 * loses 2 more pixels on each axis because the rotated edge is anti-aliased (a half-transparent row).
 */
export function insetForRotation(size: Size, deg: number): Size {
  const rad = (Math.abs(deg) * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const s = Math.min(size.width / (size.width * cos + size.height * sin), size.height / (size.width * sin + size.height * cos), 1);
  const edge = deg === 0 ? 0 : 2;
  return { width: Math.floor(size.width * s) - edge, height: Math.floor(size.height * s) - edge };
}

/**
 * Tone as `out = gain * in + offset` on a 0..255 channel: contrast is the gain around mid grey and
 * brightness shifts by up to 30% of the range. Both 0 is the identity.
 */
export function toneLinear(edit: { brightness?: number | undefined; contrast?: number | undefined }): { gain: number; offset: number } {
  const gain = 1 + (edit.contrast ?? 0);
  return { gain, offset: 255 * (edit.brightness ?? 0) + TONE_PIVOT * (1 - gain) };
}
