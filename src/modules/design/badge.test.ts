import { describe, expect, it } from 'vitest';
import { BADGE_KINDS, BadgeText } from '../../contracts/design-spec.js';
import { LANGUAGES } from '../../contracts/common.js';
import { BADGE_SIZE, badgeFontSize, badgeHtml, stickerText } from './badge.js';
import type { SlideContext } from './styles/types.js';

// design-styles.md, "Photo edits and badge": the badge is one element with fixed words for the
// stickers, a size of about 220 px, cover slide only and at most one per post.

const ctx = (overrides: Partial<SlideContext>): SlideContext =>
  ({
    kind: 'cover',
    canvas: { width: 1080, height: 1350 },
    language: 'he',
    dir: 'rtl',
    palette: { background: '#FFFFFF', text: '#111111', accent: '#2F6BFF' },
    photo: { dataUri: 'data:,', width: 1, height: 1 },
    logo: { kind: 'text', text: 'x' },
    overlayText: 'x',
    safeArea: 64,
    ...overrides,
  }) as SlideContext;

describe('sticker words', () => {
  it('are fixed per language and fit the badge text rule', () => {
    for (const language of LANGUAGES) {
      for (const kind of ['new', 'sale', 'holiday'] as const) {
        const text = stickerText(kind, language);
        expect(BadgeText.safeParse(text).success, `${language} ${kind}: ${text}`).toBe(true);
      }
    }
  });

  it('are the Hebrew words of the spec', () => {
    expect(stickerText('new', 'he')).toBe('חדש');
    expect(stickerText('sale', 'he')).toBe('מבצע');
    expect(stickerText('holiday', 'he')).toBe('חג שמח');
  });

  it('cover every badge kind that is not a fact', () => {
    expect(BADGE_KINDS.filter((k) => k !== 'discount' && k !== 'price')).toEqual(['new', 'sale', 'holiday']);
  });
});

describe('badgeFontSize', () => {
  it('shrinks with the text and stays within 24 to 64 px', () => {
    expect(badgeFontSize('-5%', 220)).toBeLessThanOrEqual(64);
    expect(badgeFontSize('-5%', 220)).toBeGreaterThanOrEqual(badgeFontSize('₪1299.90', 220));
    expect(badgeFontSize('₪1299.90', 220)).toBeGreaterThanOrEqual(24);
  });
});

describe('badgeHtml', () => {
  it('draws nothing without a badge, and nothing on a photo slide', () => {
    expect(badgeHtml(ctx({}), 'badge')).toBe('');
    expect(badgeHtml(ctx({ kind: 'photo', badge: { kind: 'new', text: 'חדש' } }), 'badge')).toBe('');
  });

  it('draws one safe-area, over-photo graphic carrying the kind and the escaped text', () => {
    const html = badgeHtml(ctx({ badge: { kind: 'discount', text: '-15%<' } }), 'badge');
    expect(html.match(/data-badge=/g)).toHaveLength(1);
    expect(html).toContain('data-badge="discount"');
    expect(html).toContain('data-safe="badge"');
    expect(html).toContain('data-graphic="over-photo"');
    expect(html).toContain('-15%&#60;');
    expect(html).not.toContain('<<');
  });

  it('keeps a number left to right inside a right-to-left post, and a sticker word in the post direction', () => {
    expect(badgeHtml(ctx({ badge: { kind: 'discount', text: '-15%' } }), 'badge')).toContain('<span dir="ltr">-15%</span>');
    expect(badgeHtml(ctx({ badge: { kind: 'price', text: '₪29.90' } }), 'badge')).toContain('<span dir="ltr">');
    expect(badgeHtml(ctx({ badge: { kind: 'new', text: 'חדש' } }), 'badge')).toContain('<span>חדש</span>');
  });

  it('is about 220 px', () => {
    expect(BADGE_SIZE).toBe(220);
  });
});
