// Clean (design-styles.md): bold typography, plenty of white space, few elements.
// Rules are asserted on the laid-out page in clean.test.ts, including the example set.

import { ensureContrast, ensureGraphicContrast } from '../color.js';
import { fontCss } from '../fonts.js';
import { logoHtml, overlayHtml, photoHtml } from './shared.js';
import type { StyleTemplate } from './types.js';

const PHOTO_SHARE = 0.7;

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
      <div class="band"><div class="bar" data-graphic></div>${overlayHtml(ctx, 'overlay')}${logoHtml(ctx, 'logo')}</div>`;
  },

  css(ctx) {
    const { palette, safeArea, canvas } = ctx;
    const photoHeight = this.photoBox(ctx.kind, canvas).height;
    const text = ensureContrast(palette.text, palette.background);
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
    `;
  },
};
