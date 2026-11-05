import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BADGE_KINDS, CAROUSEL_LAYOUTS, DesignSpec, PhotoEdit } from './design-spec.js';

const uuid = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const photo = { assetId: uuid };
const spec = { photos: [photo], title: 'מבצע תמרים' };

describe('DesignSpec (contracts.md, Agent; design-styles.md, Photo edits and badge)', () => {
  it('has the badge kinds and carousel layouts in the docs', () => {
    expect([...BADGE_KINDS]).toEqual(['discount', 'price', 'new', 'sale', 'holiday']);
    expect([...CAROUSEL_LAYOUTS]).toEqual(['standard', 'numbered']);
  });

  it('accepts a single photo with a title; no layout means standard', () => {
    expect(DesignSpec.parse(spec).carouselLayout).toBeUndefined();
    expect(DesignSpec.safeParse({ ...spec, carouselLayout: 'numbered' }).success).toBe(true);
    expect(DesignSpec.safeParse({ ...spec, carouselLayout: 'grid' }).success).toBe(false);
  });

  it('takes 1 to 10 photos', () => {
    expect(DesignSpec.safeParse({ ...spec, photos: [] }).success).toBe(false);
    expect(DesignSpec.safeParse({ ...spec, photos: Array(10).fill(photo) }).success).toBe(true);
    expect(DesignSpec.safeParse({ ...spec, photos: Array(11).fill(photo) }).success).toBe(false);
  });

  it('limits the title to 1 to 40 characters and 2 lines', () => {
    expect(DesignSpec.safeParse({ ...spec, title: '' }).success).toBe(false);
    expect(DesignSpec.safeParse({ ...spec, title: 'א'.repeat(40) }).success).toBe(true);
    expect(DesignSpec.safeParse({ ...spec, title: 'א'.repeat(41) }).success).toBe(false);
    expect(DesignSpec.safeParse({ ...spec, title: 'שורה\nשנייה' }).success).toBe(true);
    expect(DesignSpec.safeParse({ ...spec, title: 'א\nב\nג' }).success).toBe(false);
  });

  it('bounds rotation to -10..10 in 0.5 steps', () => {
    expect(PhotoEdit.safeParse({ rotateDeg: -10 }).success).toBe(true);
    expect(PhotoEdit.safeParse({ rotateDeg: 2.5 }).success).toBe(true);
    expect(PhotoEdit.safeParse({ rotateDeg: 2.3 }).success).toBe(false);
    expect(PhotoEdit.safeParse({ rotateDeg: 10.5 }).success).toBe(false);
  });

  it('bounds brightness and contrast to -0.3..0.3', () => {
    expect(PhotoEdit.safeParse({ brightness: 0.3, contrast: -0.3 }).success).toBe(true);
    expect(PhotoEdit.safeParse({ brightness: 0.31 }).success).toBe(false);
    expect(PhotoEdit.safeParse({ contrast: -0.4 }).success).toBe(false);
  });

  it('keeps the crop inside the image', () => {
    expect(PhotoEdit.safeParse({ crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } }).success).toBe(true);
    expect(PhotoEdit.safeParse({ crop: { x: 0.5, y: 0, w: 0.6, h: 1 } }).success).toBe(false);
    expect(PhotoEdit.safeParse({ crop: { x: 0, y: 0, w: 0, h: 1 } }).success).toBe(false);
  });

  it('needs text and a fact for a discount or price badge, and no text for a sticker', () => {
    const ok = (badge: unknown) => DesignSpec.safeParse({ ...spec, badge }).success;
    expect(ok({ kind: 'discount', text: '-15%', factId: 'f1' })).toBe(true);
    expect(ok({ kind: 'price', text: '₪29.90', factId: 'f2' })).toBe(true);
    expect(ok({ kind: 'discount', text: '-15%' })).toBe(false);
    expect(ok({ kind: 'discount', factId: 'f1' })).toBe(false);
    expect(ok({ kind: 'discount', text: '-15% היום', factId: 'f1' })).toBe(false);
    expect(ok({ kind: 'new' })).toBe(true);
    expect(ok({ kind: 'sale' })).toBe(true);
    expect(ok({ kind: 'holiday', text: 'חג שמח' })).toBe(false);
    expect(ok({ kind: 'sticker' })).toBe(false);
  });

  it('converts to a JSON schema without oneOf, for the model layer', () => {
    expect(JSON.stringify(z.toJSONSchema(DesignSpec))).not.toContain('oneOf');
  });
});
