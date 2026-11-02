import { describe, expect, it } from 'vitest';
import { contrastRatio, ensureContrast, resolvePalette } from './color.js';

describe('contrastRatio', () => {
  it('follows the WCAG formula', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    // White on the Dynamic accent: about 3.4:1, below AA.
    expect(contrastRatio('#FFFFFF', '#FF3D5A')).toBeLessThan(4.5);
  });
});

describe('ensureContrast', () => {
  it('keeps the preferred color when it reaches 4.5:1', () => {
    expect(ensureContrast('#111111', '#FFFFFF')).toBe('#111111');
  });

  it('falls back to the darkest or lightest candidate that reaches 4.5:1', () => {
    expect(ensureContrast('#FFFFFF', '#FFFF00')).toBe('#111111');
    expect(ensureContrast('#111111', '#14141F')).toBe('#FFFFFF');
    expect(ensureContrast('#FFFFFF', '#FF3D5A', ['#14141F'])).toBe('#14141F');
  });

  it('always returns a color that reaches 4.5:1', () => {
    for (const bg of ['#777777', '#2F6BFF', '#B5683C', '#7A8450', '#FFC83D']) {
      expect(contrastRatio(ensureContrast('#888888', bg), bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('resolvePalette', () => {
  const style = { background: '#FFFFFF', text: '#111111', accent: '#2F6BFF', secondary: '#7A8450' };

  it('keeps the style palette without brand colors', () => {
    expect(resolvePalette(style, [])).toEqual(style);
  });

  it('replaces the accent with the first brand color and the secondary with the second', () => {
    expect(resolvePalette(style, ['#AA0000'])).toEqual({ ...style, accent: '#AA0000' });
    expect(resolvePalette(style, ['#AA0000', '#00AA00', '#0000AA'])).toEqual({
      ...style,
      accent: '#AA0000',
      secondary: '#00AA00',
    });
  });
});
