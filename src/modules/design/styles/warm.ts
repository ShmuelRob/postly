// Warm (design-styles.md): earth tones and textures.
// The photo sits inset in a background-colored frame with rounded corners; on the cover
// the overlay text sits on a paper card overlapping the bottom of the photo. The paper
// grain is an SVG noise drawn in code, so no texture file enters the repository.

import { ensureContrast } from '../color.js';
import { fontCss } from '../fonts.js';
import { LOGO_BOX } from '../layout.js';
import { logoHtml, overlayHtml, photoHtml } from './shared.js';
import type { StyleTemplate } from './types.js';

const FRAME = 32;
const CORNER_RADIUS = 24;
/** On the cover the photo stops this far above the bottom so the card can overlap it. */
const COVER_PHOTO_BOTTOM = 200;
const CARD_COLOR = '#FBF6EE';
const CARD_RADIUS = 16;
/** Large enough that a full 160 x 160 logo keeps a margin of background around it. */
const LOGO_CIRCLE = 232;

/** Paper grain: fractal noise tinted brown at low opacity, tiled over a flat fill. */
function paperGrain(opacity: number): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'>` +
    `<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/>` +
    `<feColorMatrix values='0 0 0 0 0.36  0 0 0 0 0.25  0 0 0 0 0.16  0 0 0 ${opacity} 0'/></filter>` +
    `<rect width='100%' height='100%' filter='url(%23g)'/></svg>`;
  return `url("data:image/svg+xml,${svg.replace(/</g, '%3C').replace(/>/g, '%3E')}")`;
}

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
      <div class="card"><div class="rule"><span></span><span></span></div>${overlayHtml(ctx, 'overlay')}</div>`;
  },

  css(ctx) {
    const { palette, safeArea } = ctx;
    const secondary = palette.secondary ?? palette.accent;
    return `
      body { background: ${palette.background} ${paperGrain(0.22)}; }
      .photo { position: absolute; top: ${FRAME}px; left: ${FRAME}px; display: block; border-radius: ${CORNER_RADIUS}px; }
      .logo-circle { position: absolute; top: ${safeArea}px; inset-inline-start: ${safeArea}px; width: ${LOGO_CIRCLE}px; height: ${LOGO_CIRCLE}px;
        border-radius: 50%; background: ${palette.background}; display: flex; align-items: center; justify-content: center;
        box-shadow: 0 6px 18px rgba(59, 42, 30, 0.16); }
      .logo { max-width: ${LOGO_BOX}px; max-height: ${LOGO_BOX}px; }
      .logo-text { ${fontCss(this.fonts.headline)} font-size: 36px; line-height: 1.1; color: ${ensureContrast(palette.text, palette.background)};
        text-align: center; max-width: 180px; overflow-wrap: anywhere; }
      .card { position: absolute; bottom: ${safeArea}px; inset-inline: ${safeArea}px; min-height: 230px; padding: 36px 44px;
        background: ${CARD_COLOR} ${paperGrain(0.14)}; border-radius: ${CARD_RADIUS}px;
        box-shadow: 0 10px 30px rgba(59, 42, 30, 0.18), inset 0 0 0 2px ${secondary}33;
        display: flex; flex-direction: column; justify-content: center; gap: 18px; }
      .rule { display: flex; gap: 10px; }
      .rule span { height: 6px; border-radius: 3px; }
      .rule span:first-child { width: 72px; background: ${palette.accent}; }
      .rule span:last-child { width: 24px; background: ${secondary}; }
      .overlay { ${fontCss(this.fonts.headline)} line-height: 1.2; color: ${ensureContrast(palette.text, CARD_COLOR)}; text-align: start; }
    `;
  },
};
