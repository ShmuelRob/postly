// The carousel's slide counter (design-styles.md, "Photo edits and badge"): with the `numbered`
// layout every slide after the cover carries a small counter such as `2/5`, in the style's
// secondary font at 32 px, in the bottom start corner inside the safe area, on a small panel of the
// style's background at 4.5:1. It is the only text on those slides. The styles own nothing of it:
// `counterHtml` and `counterCss` are shared, so every style draws the same counter.

import { ensureContrast } from './color.js';
import type { SlideContext } from './styles/types.js';
import type { FontFace } from './fonts.js';
import { fontCss } from './fonts.js';

export const COUNTER_FONT_SIZE = 32;

export function counterText(slide: { index: number; total: number }): string {
  return `${slide.index}/${slide.total}`;
}

/** The counter, or nothing: only on a photo slide of a `numbered` carousel. */
export function counterHtml(ctx: SlideContext, className: string): string {
  if (ctx.kind !== 'photo' || ctx.slide === undefined || !ctx.slide.numbered) return '';
  // Latin digits left to right in every language, so "2/5" is never shown as "5/2".
  return `<div class="${className}" data-counter data-safe="counter"><span dir="ltr">${counterText(ctx.slide)}</span></div>`;
}

/** The counter's CSS on `panel` (the style's background); the text color is picked for 4.5:1. */
export function counterCss(ctx: SlideContext, className: string, font: FontFace, panel: string, text: string): string {
  const { safeArea } = ctx;
  return `
      .${className} { position: absolute; bottom: ${safeArea}px; inset-inline-start: ${safeArea}px; padding: 8px 18px; border-radius: 12px;
        background: ${panel}; color: ${ensureContrast(text, panel)}; ${fontCss(font)} font-size: ${COUNTER_FONT_SIZE}px; line-height: 1.2; white-space: nowrap; }
  `;
}
