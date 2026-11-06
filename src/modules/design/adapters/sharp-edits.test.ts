import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createSharpImages } from './sharp-images.js';
import { TONE_PIVOT } from '../edits.js';

// The `edit` operation of the sharp adapter: rotate (corners cropped), then tone.

const images = createSharpImages();
const solid = (width: number, height: number, rgb: [number, number, number]) =>
  sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();

async function stats(png: Uint8Array) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minAlpha = 255;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    minAlpha = Math.min(minAlpha, data[i + 3]!);
    sum += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
  }
  return { width: info.width, height: info.height, minAlpha, mean: sum / (data.length / 4) };
}

describe('sharp edit', () => {
  it('leaves a photo with no edit as it is', async () => {
    expect(await stats(await images.edit(await solid(400, 300, [90, 120, 150]), {}))).toMatchObject({ width: 400, height: 300, minAlpha: 255 });
  });

  it('straightens with no empty edge: the corners are cropped away, the aspect kept', async () => {
    const input = await solid(800, 600, [200, 40, 40]);
    for (const rotateDeg of [10, -10, 3.5]) {
      const out = await stats(await images.edit(input, { rotateDeg }));
      expect(out.minAlpha, `${rotateDeg} degrees`).toBe(255);
      expect(out.width).toBeLessThan(800);
      expect(out.width / out.height).toBeCloseTo(800 / 600, 1);
    }
  });

  it('brightens and darkens linearly', async () => {
    const input = await solid(200, 200, [100, 100, 100]);
    const base = (await stats(await images.edit(input, {}))).mean;
    expect((await stats(await images.edit(input, { brightness: 0.3 }))).mean).toBeGreaterThan(base + 50);
    expect((await stats(await images.edit(input, { brightness: -0.3 }))).mean).toBeLessThan(base - 50);
  });

  it('contrast pivots on mid grey: a light photo gets lighter, a dark one darker, mid grey stays', async () => {
    expect((await stats(await images.edit(await solid(100, 100, [200, 200, 200]), { contrast: 0.3 }))).mean).toBeGreaterThan(200);
    expect((await stats(await images.edit(await solid(100, 100, [50, 50, 50]), { contrast: 0.3 }))).mean).toBeLessThan(50);
    // Within a level of mid grey (the linear function rounds to a whole channel value).
    const mid = (await stats(await images.edit(await solid(10, 10, [TONE_PIVOT, TONE_PIVOT, TONE_PIVOT]), { contrast: 0.3 }))).mean;
    expect(Math.abs(mid - TONE_PIVOT)).toBeLessThanOrEqual(1);
  });

  it('refuses a value outside the ranges instead of clamping it', async () => {
    const input = await solid(100, 100, [10, 10, 10]);
    await expect(images.edit(input, { rotateDeg: 12 })).rejects.toThrow();
    await expect(images.edit(input, { brightness: 0.5 })).rejects.toThrow();
    await expect(images.edit(input, { rotateDeg: 0.3 })).rejects.toThrow();
  });
});
