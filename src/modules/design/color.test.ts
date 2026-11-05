import { describe, expect, it } from 'vitest';
import { contrastRatio, edgeColor, ensureContrast, ensureGraphicContrast, fillForText, MIN_GRAPHIC_CONTRAST, resolvePalette } from './color.js';

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

describe('ensureGraphicContrast', () => {
  it('keeps a color that already reaches 3:1 against its neighbor', () => {
    expect(ensureGraphicContrast('#2F6BFF', '#FFFFFF')).toBe('#2F6BFF');
    expect(ensureGraphicContrast('#FFC83D', '#14141F')).toBe('#FFC83D');
  });

  it('darkens a pale brand color on a light neighbor and lightens a dark one on a dark neighbor', () => {
    const pale = ensureGraphicContrast('#E8B4C8', '#FFFFFF');
    expect(contrastRatio(pale, '#FFFFFF')).toBeGreaterThanOrEqual(MIN_GRAPHIC_CONTRAST);
    expect(contrastRatio(pale, '#FFFFFF')).toBeLessThan(4);
    const dark = ensureGraphicContrast('#1F3A5F', '#14141F');
    expect(contrastRatio(dark, '#14141F')).toBeGreaterThanOrEqual(MIN_GRAPHIC_CONTRAST);
  });

  it('always reaches 3:1', () => {
    for (const color of ['#E8B4C8', '#F5E6A8', '#777777', '#FFFFFF', '#000000', '#C9A27E']) {
      for (const against of ['#FFFFFF', '#FBF6EE', '#14141F', '#777777']) {
        expect(contrastRatio(ensureGraphicContrast(color, against), against)).toBeGreaterThanOrEqual(MIN_GRAPHIC_CONTRAST);
      }
    }
  });
});

describe('edgeColor', () => {
  it('returns the dark shadow or white, whichever reaches 3:1 against the element', () => {
    for (const color of ['#FF3D5A', '#FFC83D', '#E8B4C8', '#1F3A5F', '#14141F', '#777777']) {
      expect(contrastRatio(edgeColor(color, '#14141F'), color)).toBeGreaterThanOrEqual(MIN_GRAPHIC_CONTRAST);
    }
    expect(edgeColor('#FFC83D', '#14141F')).toBe('#14141F');
    expect(edgeColor('#1F3A5F', '#14141F')).toBe('#FFFFFF');
  });
});

describe('fillForText', () => {
  it('keeps a fill that already carries the text at 4.5:1', () => {
    expect(fillForText('#1F3A5F', '#FFFFFF')).toBe('#1F3A5F');
  });

  it('darkens a fill under light text until it reaches 4.5:1', () => {
    for (const fill of ['#B5683C', '#E8B4C8', '#FFC83D']) {
      const out = fillForText(fill, '#FBF6EE');
      expect(contrastRatio('#FBF6EE', out)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('lightens a fill under dark text until it reaches 4.5:1', () => {
    const out = fillForText('#14141F', '#111111');
    expect(contrastRatio('#111111', out)).toBeGreaterThanOrEqual(4.5);
  });
});
