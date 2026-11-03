// Builds the self-contained HTML page for one slide: inlined fonts, the style's markup,
// and a script that fits the overlay text and reports the layout back to the engine.

import { z } from 'zod';
import { fontFaceCss, fontSpec, type FontFamily } from './fonts.js';
import { MAX_OVERLAY_LINES } from './layout.js';
import type { SlideContext, StyleTemplate } from './styles/types.js';

/** What the page reports after layout; validated, since it comes back from the browser. */
export const LayoutReport = z.object({
  fontsLoaded: z.boolean(),
  overlay: z.object({ fontSize: z.number().nullable(), lines: z.number() }).nullable(),
  safeAreaViolations: z.array(z.string()),
});
export type LayoutReport = z.infer<typeof LayoutReport>;

type FitConfig = {
  sizes: number[];
  maxLines: number;
  safeArea: number;
  width: number;
  height: number;
  fonts: string[];
};

// Runs in the page. Tries each size until the overlay fits in maxLines without
// overflowing, then checks that every [data-safe] element sits inside the safe area.
// offsetHeight ignores transforms, so a rotated band still counts its lines correctly.
const FIT_SCRIPT = `
window.__layout = (async () => {
  const cfg = window.__postlyConfig;
  await Promise.all(cfg.fonts.map((f) => document.fonts.load(f)));
  await document.fonts.ready;
  const fontsLoaded = cfg.fonts.every((f) => document.fonts.check(f));
  const el = document.querySelector('[data-overlay]');
  let overlay = null;
  if (el) {
    let fontSize = null;
    let lines = 0;
    for (const size of cfg.sizes) {
      el.style.fontSize = size + 'px';
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      lines = Math.round(el.offsetHeight / lineHeight);
      if (lines <= cfg.maxLines && el.scrollWidth <= el.clientWidth + 1) { fontSize = size; break; }
    }
    overlay = { fontSize, lines };
  }
  const s = cfg.safeArea;
  const safeAreaViolations = [...document.querySelectorAll('[data-safe]')]
    .filter((n) => {
      const r = n.getBoundingClientRect();
      return r.left < s - 0.5 || r.top < s - 0.5 || r.right > cfg.width - s + 0.5 || r.bottom > cfg.height - s + 0.5;
    })
    .map((n) => n.getAttribute('data-safe'));
  return { fontsLoaded, overlay, safeAreaViolations };
})();
`;

export function buildDocument(style: StyleTemplate, ctx: SlideContext, overlaySizes: number[]): string {
  const families = [...new Set<FontFamily>([style.fonts.headline.family, style.fonts.secondary.family])];
  const config: FitConfig = {
    sizes: overlaySizes,
    maxLines: MAX_OVERLAY_LINES,
    safeArea: ctx.safeArea,
    width: ctx.canvas.width,
    height: ctx.canvas.height,
    fonts: [fontSpec(style.fonts.headline), fontSpec(style.fonts.secondary)],
  };
  return `<!doctype html>
<html lang="${ctx.language}" dir="${ctx.dir}">
<head>
<meta charset="utf-8">
<style>
${families.map(fontFaceCss).join('\n')}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: ${ctx.canvas.width}px; height: ${ctx.canvas.height}px; overflow: hidden; position: relative; }
body { -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; font-family: "${style.fonts.secondary.family}"; }
img { display: block; }
/* Every style: explicit line breaks are kept, and Hebrew is never tracked. */
[data-overlay] { white-space: pre-line; letter-spacing: normal; }
</style>
<style>${style.css(ctx)}</style>
</head>
<body>
${style.html(ctx)}
<script>window.__postlyConfig = ${JSON.stringify(config)};${FIT_SCRIPT}</script>
</body>
</html>`;
}
