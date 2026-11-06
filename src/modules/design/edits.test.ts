import { describe, expect, it } from 'vitest';
import { insetForRotation, TONE_PIVOT, toneLinear } from './edits.js';

// design-styles.md, "Photo edits and badge": straightening crops the corners so no empty edge shows
// (the largest same-aspect rectangle inside the rotated photo); tone is one linear function. The
// pixels are tested with the adapter (adapters/sharp-edits.test.ts).

describe('insetForRotation', () => {
  it('is the whole photo at 0 degrees and shrinks as the angle grows, keeping the aspect', () => {
    expect(insetForRotation({ width: 2000, height: 1500 }, 0)).toEqual({ width: 2000, height: 1500 });
    const small = insetForRotation({ width: 2000, height: 1500 }, 2);
    const big = insetForRotation({ width: 2000, height: 1500 }, 10);
    expect(big.width).toBeLessThan(small.width);
    expect(small.width).toBeLessThan(2000);
    expect(big.width / big.height).toBeCloseTo(2000 / 1500, 1);
  });

  it('is the same for a left and a right turn', () => {
    expect(insetForRotation({ width: 1600, height: 1200 }, -7.5)).toEqual(insetForRotation({ width: 1600, height: 1200 }, 7.5));
  });

  it('keeps all four corners of the inset inside the rotated photo', () => {
    const photo = { width: 1600, height: 1200 };
    for (const deg of [0.5, 3.5, 10]) {
      const inset = insetForRotation(photo, deg);
      const rad = (deg * Math.PI) / 180;
      // The inset's far corner, rotated back into the photo's own axes, stays within the half sizes.
      const x = (inset.width / 2) * Math.cos(rad) + (inset.height / 2) * Math.sin(rad);
      const y = (inset.width / 2) * Math.sin(rad) + (inset.height / 2) * Math.cos(rad);
      expect(x).toBeLessThanOrEqual(photo.width / 2 + 0.5);
      expect(y).toBeLessThanOrEqual(photo.height / 2 + 0.5);
    }
  });
});

describe('toneLinear', () => {
  it('is the identity at 0', () => {
    expect(toneLinear({})).toEqual({ gain: 1, offset: 0 });
    expect(toneLinear({ brightness: 0, contrast: 0 })).toEqual({ gain: 1, offset: 0 });
  });

  it('brightness shifts and contrast scales around mid grey', () => {
    expect(toneLinear({ brightness: 0.1 })).toEqual({ gain: 1, offset: 25.5 });
    const c = toneLinear({ contrast: 0.2 });
    expect(c.gain).toBeCloseTo(1.2, 10);
    // Mid grey stays where it is under contrast alone.
    expect(c.gain * TONE_PIVOT + c.offset).toBeCloseTo(TONE_PIVOT, 10);
  });
});
