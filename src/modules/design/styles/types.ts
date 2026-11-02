// The interface a visual style implements. The engine owns everything shared (input
// checks, photo crop, logo fit, fonts, text fitting, safe-area checks, JPEG output);
// a style only declares its rules and returns the HTML and CSS of one slide.

import type { Palette } from '../color.js';
import type { FontFace } from '../fonts.js';
import type { Direction, Size } from '../layout.js';

export type SlideKind = 'cover' | 'photo';

export type LogoImage = { kind: 'image'; dataUri: string; width: number; height: number };
/** No logo: the business name is set in the style's headline font at the logo position. */
export type LogoText = { kind: 'text'; text: string };

export type SlideContext = {
  kind: SlideKind;
  canvas: Size;
  /** The business's first language, which also sets the direction. */
  language: string;
  dir: Direction;
  /** The style palette with brand colors applied. */
  palette: Palette;
  /** The photo, already cover-cropped to `photoBox(kind, canvas)`. */
  photo: { dataUri: string } & Size;
  logo: LogoImage | LogoText;
  /** Plain text; escape it with `escapeHtml`. Empty on photo slides. */
  overlayText: string;
  /** 64 px on every side; elements marked `data-safe` must stay inside it. */
  safeArea: number;
};

export type StyleTemplate = {
  fonts: { headline: FontFace; secondary: FontFace };
  palette: Palette;
  /** Overlay font size in px and the minimum it may shrink to. */
  overlay: { size: number; minSize: number };
  /** The size the photo is cover-cropped to before it is placed on the slide. */
  photoBox(kind: SlideKind, canvas: Size): Size;
  /**
   * The slide body. Contract with the engine:
   * - the overlay text element carries `data-overlay` and a numeric `line-height`; the
   *   engine sets its `font-size`, so the style must not set one on it;
   * - the overlay text and the logo carry `data-safe="<name>"`;
   * - nothing loads over the network (use the data URIs from the context).
   */
  html(ctx: SlideContext): string;
  css(ctx: SlideContext): string;
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
