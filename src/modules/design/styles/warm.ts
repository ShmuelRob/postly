// Warm (design-styles.md): earth tones and textures.
// Minimal template for WP-11; WP-12 owns the final rules, including the paper texture asset.

import { ensureContrast } from '../color.js';
import { fontCss } from '../fonts.js';
import { logoHtml, overlayHtml, photoHtml } from './shared.js';
import type { StyleTemplate } from './types.js';

const FRAME = 32;
const CORNER_RADIUS = 24;
/** On the cover the photo stops this far above the bottom so the card can overlap it. */
const COVER_PHOTO_BOTTOM = 200;
const CARD_COLOR = '#FBF6EE';
const LOGO_CIRCLE = 184;

export const warm: StyleTemplate = {
  fonts: {
    headline: { family: 'Frank Ruhl Libre', weight: 700 },
    secondary: { family: 'Assistant', weight: 400 },
  },
  palette: { background: '#F3E9DC', text: '#3B2A1E', accent: '#B5683C', secondary: '#7A8450' },
  overlay: { size: 64, minSize: 46 },

  photoBox(kind, canvas) {
    const width = canvas.width - 2 * FRAME;
    return kind === 'cover'
      ? { width, height: canvas.height - FRAME - COVER_PHOTO_BOTTOM }
      : { width, height: canvas.height - 2 * FRAME };
  },

  html(ctx) {
    const logo = `<div class="logo-circle">${logoHtml(ctx, 'logo')}</div>`;
    if (ctx.kind === 'photo') return `${photoHtml(ctx, 'photo')}${logo}`;
    return `${photoHtml(ctx, 'photo')}${logo}
      <div class="card"><div class="rule"></div>${overlayHtml(ctx, 'overlay')}</div>`;
  },

  css(ctx) {
    const { palette, safeArea } = ctx;
    const text = ensureContrast(palette.text, CARD_COLOR);
    return `
      body { background: ${palette.background}; }
      .photo { position: absolute; top: ${FRAME}px; left: ${FRAME}px; display: block; border-radius: ${CORNER_RADIUS}px; }
      .logo-circle { position: absolute; top: ${safeArea}px; inset-inline-start: ${safeArea}px; width: ${LOGO_CIRCLE}px; height: ${LOGO_CIRCLE}px;
        border-radius: 50%; background: ${palette.background}; display: flex; align-items: center; justify-content: center; }
      .logo { max-width: 120px; max-height: 120px; }
      .logo-text { ${fontCss(this.fonts.headline)} font-size: 38px; line-height: 1.05; color: ${ensureContrast(palette.text, palette.background)};
        text-align: center; max-width: 150px; }
      .card { position: absolute; bottom: ${safeArea}px; inset-inline: ${safeArea}px; min-height: 230px; padding: 36px 44px;
        background: ${CARD_COLOR}; border-radius: 16px; box-shadow: 0 10px 30px rgba(59, 42, 30, 0.18);
        display: flex; flex-direction: column; justify-content: center; gap: 18px; }
      .rule { width: 72px; height: 6px; border-radius: 3px; background: ${palette.accent}; }
      .overlay { ${fontCss(this.fonts.headline)} line-height: 1.2; color: ${text}; text-align: start; }
    `;
  },
};
