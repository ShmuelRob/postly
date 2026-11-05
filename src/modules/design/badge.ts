// The badge design element (design-styles.md, "Photo edits and badge"; agent.md, "Badge element"):
// one optional sticker on the cover slide, in the top corner opposite the logo. The caller resolves
// its text (a recorded fact's text, or the sticker's fixed word); this file owns the words, the
// size, the markup that every style shares, and the font fit. Each style owns the shape and colors
// (styles/*.ts), and the rules tests measure all of it on the laid-out page.

import type { z } from 'zod';
import type { Language as LanguageSchema } from '../../contracts/common.js';

type Language = z.infer<typeof LanguageSchema>;
import type { BadgeKind } from '../../contracts/design-spec.js';
import type { SlideContext } from './styles/types.js';
import { escapeHtml } from './styles/types.js';

/** The badge is a 220 px circle, or a box of about the same area. */
export const BADGE_SIZE = 220;
/** The ring or offset edge that sets a badge off the photo (3:1, the graphic-contrast rule). */
export const BADGE_EDGE = 6;
const MIN_FONT = 24;
const MAX_FONT = 64;
/** Average glyph width in em, wide enough for the heaviest style font on digits and Hebrew. */
const GLYPH_EM = 0.72;

/** The fixed words of the stickers, per language; at most 8 characters each. */
export const STICKER_WORDS: Record<Language, Record<Exclude<BadgeKind, 'discount' | 'price'>, string>> = {
  he: { new: 'חדש', sale: 'מבצע', holiday: 'חג שמח' },
  ar: { new: 'جديد', sale: 'تخفيضات', holiday: 'عيد سعيد' },
  en: { new: 'NEW', sale: 'SALE', holiday: 'HOLIDAY' },
  ru: { new: 'НОВОЕ', sale: 'АКЦИЯ', holiday: 'ПРАЗДНИК' },
};

export function stickerText(kind: Exclude<BadgeKind, 'discount' | 'price'>, language: Language): string {
  return STICKER_WORDS[language][kind];
}

/** The largest font size, 24 to 64 px, at which `text` fits one line in `innerWidth` px. */
export function badgeFontSize(text: string, innerWidth: number): number {
  const fit = Math.floor(innerWidth / ([...text].length * GLYPH_EM));
  return Math.max(MIN_FONT, Math.min(MAX_FONT, fit));
}

/**
 * The badge element, or nothing: the cover slide only, and only when the request has a badge. It is
 * a safe-area element and a graphic over the photo, so the engine and the rules tests check its
 * place and its 3:1 edge like any other. The style's CSS gives it its shape (`className`).
 */
export function badgeHtml(ctx: SlideContext, className: string): string {
  if (ctx.kind !== 'cover' || ctx.badge === undefined) return '';
  const { kind, text } = ctx.badge;
  // A number reads left to right even in a Hebrew post: "-15%" keeps its minus in front, not after the %.
  const dir = kind === 'discount' || kind === 'price' ? ' dir="ltr"' : '';
  return `<div class="${className}" data-badge="${kind}" data-safe="badge" data-graphic="over-photo"><span${dir}>${escapeHtml(text)}</span></div>`;
}
