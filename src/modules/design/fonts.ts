// Self-hosted fonts under assets/fonts/, each with its OFL.txt (SIL Open Font License 1.1).
// Source: github.com/google/fonts, ofl/<family>/, at commit 2fe1e8c6b137fb13041a7cfca6fdcd8a910ea4dc;
// update them only from there.
// They are embedded into the page as data URIs, so rendering needs no network.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fontDir = fileURLToPath(new URL('../../../assets/fonts/', import.meta.url));

/** Variable fonts: one file covers every weight a style uses. */
const FONT_FILES = {
  Heebo: 'heebo/Heebo[wght].ttf',
  'Frank Ruhl Libre': 'frankruhllibre/FrankRuhlLibre[wght].ttf',
  Assistant: 'assistant/Assistant[wght].ttf',
  Rubik: 'rubik/Rubik[wght].ttf',
} as const;

export type FontFamily = keyof typeof FONT_FILES;
export type FontFace = { family: FontFamily; weight: number };

const cache = new Map<FontFamily, string>();

/** An @font-face rule with the font file inlined. */
export function fontFaceCss(family: FontFamily): string {
  let base64 = cache.get(family);
  if (base64 === undefined) {
    base64 = readFileSync(`${fontDir}${FONT_FILES[family]}`).toString('base64');
    cache.set(family, base64);
  }
  return `@font-face { font-family: "${family}"; font-weight: 100 900; font-style: normal; font-display: block; src: url(data:font/ttf;base64,${base64}) format("truetype"); }`;
}

/** The CSS `font` shorthand a style declares, for loading and checking in the page. */
export function fontSpec(face: FontFace, size = 16): string {
  return `${face.weight} ${size}px "${face.family}"`;
}

export function fontCss(face: FontFace): string {
  return `font-family: "${face.family}"; font-weight: ${face.weight};`;
}
