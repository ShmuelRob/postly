// Clean (design-styles.md): bold typography, plenty of white space, few elements.
// Rules are asserted on the laid-out page in clean.test.ts, including the example set.

import { BADGE_EDGE, badgeFontSize, badgeHtml } from '../badge.js';
import { ensureContrast, ensureGraphicContrast, fillForText } from '../color.js';
import { fontCss } from '../fonts.js';
import { logoHtml, overlayHtml, photoHtml } from './shared.js';
import type { StyleTemplate } from './types.js';

const PHOTO_SHARE = 0.7;
/** The badge: a square-cornered tag of about the area of a 220 px circle (design-styles.md, Badge). */
const TAG = { width: 260, height: 140, padding: 20 };

export const clean: StyleTemplate = {
  fonts: { headline: { family: 'Heebo', weight: 800 }, secondary: { family: 'Heebo', weight: 400 } },
  palette: { background: '#FFFFFF', text: '#111111', accent: '#2F6BFF' },
  overlay: { size: 72, minSize: 52 },

  photoBox(kind, canvas) {
    return kind === 'cover' ? { width: canvas.width, height: Math.round(canvas.height * PHOTO_SHARE) } : canvas;
  },

  html(ctx) {
    if (ctx.kind === 'photo') return `${photoHtml(ctx, 'photo')}${logoHtml(ctx, 'logo logo-corner')}`;
    return `${photoHtml(ctx, 'photo')}
      <div class="band"><div class="bar" data-graphic></div>${overlayHtml(ctx, 'overlay')}${logoHtml(ctx, 'logo')}</div>${badgeHtml(ctx, 'badge')}`;
  },

  css(ctx) {
    const { palette, safeArea, canvas } = ctx;
    const photoHeight = this.photoBox(ctx.kind, canvas).height;
    const text = ensureContrast(palette.text, palette.background);
    // White text on the accent, which is darkened only as far as 4.5:1 needs; the white ring is the 3:1 edge.
    const tag = fillForText(palette.accent, '#FFFFFF');
    const tagFont = badgeFontSize(ctx.badge?.text ?? '', TAG.width - 2 * TAG.padding);
    return `
      body { background: ${palette.background}; }
      .photo { position: absolute; top: 0; left: 0; display: block; }
      .band { position: absolute; top: ${photoHeight}px; left: 0; width: ${canvas.width}px; height: ${canvas.height - photoHeight}px;
        background: ${palette.background}; display: flex; align-items: center; gap: 32px; padding-inline: ${safeArea}px; }
      .bar { position: absolute; top: 0; bottom: 0; inset-inline-start: 0; width: 12px; background: ${ensureGraphicContrast(palette.accent, palette.background)}; }
      .overlay { flex: 1; min-width: 0; ${fontCss(this.fonts.headline)} line-height: 1.15; color: ${text}; text-align: start; }
      .logo { flex: none; max-width: 160px; max-height: 160px; }
      .logo-text { ${fontCss(this.fonts.headline)} font-size: 32px; line-height: 1.1; color: ${text}; max-width: 240px; }
      .logo-corner { position: absolute; bottom: ${safeArea}px; inset-inline-end: ${safeArea}px; }
      .logo-corner.logo-text { background: ${palette.background}; padding: 12px 20px; border-radius: 8px; }
      .badge { position: absolute; top: ${safeArea}px; inset-inline-start: ${safeArea}px; width: ${TAG.width}px; height: ${TAG.height}px;
        padding-inline: ${TAG.padding}px; background: ${tag}; box-shadow: 0 0 0 ${BADGE_EDGE}px #FFFFFF; border-radius: 0;
        display: flex; align-items: center; justify-content: center; color: #FFFFFF; ${fontCss(this.fonts.headline)} }
      .badge span { font-size: ${tagFont}px; line-height: 1.1; white-space: nowrap; }
    `;
  },
};
