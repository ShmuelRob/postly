// Dynamic (design-styles.md): bold graphic elements and a sense of movement.
// Minimal template for WP-11; WP-12 owns the final rules.

import { ensureContrast } from '../color.js';
import { fontCss } from '../fonts.js';
import { logoHtml, overlayHtml, photoHtml } from './shared.js';
import type { StyleTemplate } from './types.js';

const BAND_ANGLE = -4;
/** Room the rotated band needs so its text box stays inside the safe area. */
const ROTATION_MARGIN = 24;

export const dynamic: StyleTemplate = {
  fonts: { headline: { family: 'Rubik', weight: 900 }, secondary: { family: 'Rubik', weight: 500 } },
  palette: { background: '#14141F', text: '#FFFFFF', accent: '#FF3D5A', secondary: '#FFC83D', shadow: '#14141F' },
  overlay: { size: 80, minSize: 56 },

  photoBox(_kind, canvas) {
    return canvas;
  },

  html(ctx) {
    const base = `${photoHtml(ctx, 'photo')}<div class="stripe stripe-1"></div><div class="stripe stripe-2"></div>${logoHtml(ctx, 'logo')}`;
    if (ctx.kind === 'photo') return base;
    return `${base}<div class="band">${overlayHtml(ctx, 'overlay')}</div>`;
  },

  css(ctx) {
    const { palette, safeArea, canvas } = ctx;
    const shadow = palette.shadow ?? '#14141F';
    const text = ensureContrast(palette.text, palette.accent, [shadow]);
    // The stripes cut the top start corner, opposite the band and the logo.
    const stripeAngle = ctx.dir === 'rtl' ? 45 : -45;
    return `
      body { background: ${palette.background}; }
      .photo { position: absolute; top: 0; left: 0; display: block; }
      .band { position: absolute; top: ${Math.round(canvas.height * 0.64)}px; left: ${-canvas.width * 0.1}px; width: ${canvas.width * 1.2}px;
        padding: 34px ${canvas.width * 0.1 + safeArea + ROTATION_MARGIN}px; background: ${palette.accent};
        transform: rotate(${BAND_ANGLE}deg); box-shadow: 0 16px 0 ${shadow}; }
      .overlay { ${fontCss(this.fonts.headline)} line-height: 1.1; color: ${text}; text-align: start; }
      .stripe { position: absolute; width: 520px; height: 34px; background: ${palette.secondary ?? palette.accent};
        transform: rotate(${stripeAngle}deg); }
      .stripe-1 { top: 120px; inset-inline-start: -150px; }
      .stripe-2 { top: 210px; inset-inline-start: -110px; }
      .logo { position: absolute; top: ${safeArea}px; inset-inline-end: ${safeArea}px; max-width: 160px; max-height: 160px;
        filter: brightness(0) invert(1); }
      .logo-text { filter: none; ${fontCss(this.fonts.headline)} font-size: 34px; line-height: 1.1; color: #FFFFFF; max-width: 260px;
        text-shadow: 0 2px 10px rgba(0, 0, 0, 0.45); }
    `;
  },
};
