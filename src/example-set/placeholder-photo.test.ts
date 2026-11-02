import { describe, expect, it } from 'vitest';
import { PlaceholderSpec, placeholderPhotoSvg } from './placeholder-photo.js';

const spec = PlaceholderSpec.parse({
  width: 1080,
  height: 1350,
  colors: ['#F7C6D9', '#7A3E5D', '#FFFFFF'],
  motif: 'petals',
  seed: 7,
});

describe('placeholderPhotoSvg', () => {
  it('is deterministic for the same spec', () => {
    expect(placeholderPhotoSvg(spec)).toBe(placeholderPhotoSvg({ ...spec }));
  });

  it('changes with the seed', () => {
    expect(placeholderPhotoSvg({ ...spec, seed: 8 })).not.toBe(placeholderPhotoSvg(spec));
  });

  it('declares the requested size', () => {
    const svg = placeholderPhotoSvg({ ...spec, width: 1600, height: 1200 });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1600" height="1200" viewBox="0 0 1600 1200">/);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('fills the canvas with a gradient of the first two colors', () => {
    const svg = placeholderPhotoSvg(spec);
    expect(svg).toContain('<linearGradient');
    expect(svg).toContain('stop-color="#F7C6D9"');
    expect(svg).toContain('stop-color="#7A3E5D"');
    expect(svg).toContain('fill="url(#bg)"');
  });

  it.each(PlaceholderSpec.shape.motif.options)('draws shapes for the %s motif', (motif) => {
    const svg = placeholderPhotoSvg({ ...spec, motif });
    expect(svg).toMatch(/<(circle|ellipse|rect|path)\b[^>]*"#FFFFFF"/);
  });

  it('references nothing outside the file', () => {
    for (const motif of PlaceholderSpec.shape.motif.options) {
      const svg = placeholderPhotoSvg({ ...spec, motif });
      expect(svg).not.toMatch(/href|https?:\/\/(?!www\.w3\.org\/2000\/svg)|<image|<text/);
    }
  });

  it('rejects a spec without three colors', () => {
    expect(PlaceholderSpec.safeParse({ ...spec, colors: ['#FFFFFF', '#000000'] }).success).toBe(false);
  });
});
