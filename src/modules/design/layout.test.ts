import { describe, expect, it } from 'vitest';
import { coverWindow, directionFor, overlaySizes, overlayLength } from './layout.js';

describe('directionFor', () => {
  it('is rtl for Hebrew and Arabic and ltr for English and Russian', () => {
    expect(directionFor(['he'])).toBe('rtl');
    expect(directionFor(['ar'])).toBe('rtl');
    expect(directionFor(['en'])).toBe('ltr');
    expect(directionFor(['ru'])).toBe('ltr');
  });

  it('follows the first language of a mix', () => {
    expect(directionFor(['en', 'he'])).toBe('ltr');
    expect(directionFor(['he', 'en'])).toBe('rtl');
  });
});

describe('overlaySizes', () => {
  it('steps down from the style size to its minimum, always including the minimum', () => {
    expect(overlaySizes(72, 52)).toEqual([72, 70, 68, 66, 64, 62, 60, 58, 56, 54, 52]);
    expect(overlaySizes(64, 59)).toEqual([64, 62, 60, 59]);
  });
});

describe('overlayLength', () => {
  it('counts characters, not UTF-16 units, after trimming', () => {
    expect(overlayLength('  שלום  ')).toBe(4);
    expect(overlayLength('🌸🌸')).toBe(2);
  });
});

describe('coverWindow', () => {
  it('scales the photo to cover the box and centers it without a crop', () => {
    // 2000 x 1000 into 1000 x 1000: scale 1, centered horizontally.
    expect(coverWindow({ width: 2000, height: 1000 }, { width: 1000, height: 1000 })).toEqual({
      resize: { width: 2000, height: 1000 },
      left: 500,
      top: 0,
    });
  });

  it('centers on the crop, clamped to the photo', () => {
    const photo = { width: 2000, height: 1000 };
    const box = { width: 1000, height: 1000 };
    // Crop centered at x = 0.8 -> 1600, window from 1100 to 2100 clamps to 1000.
    expect(coverWindow(photo, box, { x: 0.7, y: 0, width: 0.2, height: 1 }).left).toBe(1000);
    // Crop centered at x = 0.35 -> 700, window from 200.
    expect(coverWindow(photo, box, { x: 0.3, y: 0.2, width: 0.1, height: 0.5 }).left).toBe(200);
  });

  it('upscales a small photo to cover the box', () => {
    const win = coverWindow({ width: 540, height: 400 }, { width: 1080, height: 1350 });
    expect(win.resize.width).toBeGreaterThanOrEqual(1080);
    expect(win.resize.height).toBeGreaterThanOrEqual(1350);
  });
});
