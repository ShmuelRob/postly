// Color rules from design-styles.md: brand colors replace the style's accent and
// secondary, and text color is recomputed so contrast stays at least 4.5:1 (WCAG AA).

export const MIN_CONTRAST = 4.5;
/** WCAG 1.4.11 non-text contrast, for graphic elements such as bars and stripes. */
export const MIN_GRAPHIC_CONTRAST = 3;

export type Palette = {
  background: string;
  text: string;
  accent: string;
  secondary?: string;
  shadow?: string;
};

function channel(hex: string, offset: number): number {
  const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #RRGGBB color. */
export function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Returns `preferred` when it reaches 4.5:1 on `background`; otherwise the first of
 * `candidates` (then near-black, white, and black) that does, or whichever contrasts most.
 */
export function ensureContrast(preferred: string, background: string, candidates: string[] = []): string {
  const options = [preferred, ...candidates, '#111111', '#FFFFFF', '#000000'];
  const passing = options.find((c) => contrastRatio(c, background) >= MIN_CONTRAST);
  if (passing) return passing;
  return options.reduce((best, c) => (contrastRatio(c, background) > contrastRatio(best, background) ? c : best));
}

function mix(hex: string, toward: string, amount: number): string {
  const c = (h: string, o: number) => parseInt(h.slice(o, o + 2), 16);
  return `#${[1, 3, 5]
    .map((o) => Math.round(c(hex, o) + (c(toward, o) - c(hex, o)) * amount).toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

/**
 * Returns `color` when it reaches 3:1 against `against`; otherwise mixes it toward black
 * (on a light neighbor) or white (on a dark one) in 5% steps until it does, so the hue of
 * a brand color survives as far as possible. Falls back to the other direction.
 */
export function ensureGraphicContrast(color: string, against: string): string {
  if (contrastRatio(color, against) >= MIN_GRAPHIC_CONTRAST) return color;
  const darkFirst = luminance(against) > 0.18;
  for (const toward of darkFirst ? ['#000000', '#FFFFFF'] : ['#FFFFFF', '#000000']) {
    for (let step = 1; step <= 20; step++) {
      const mixed = mix(color, toward, step / 20);
      if (contrastRatio(mixed, against) >= MIN_GRAPHIC_CONTRAST) return mixed;
    }
  }
  return contrastRatio('#000000', against) > contrastRatio('#FFFFFF', against) ? '#000000' : '#FFFFFF';
}

/** The edge drawn around a graphic over a photo: `shadow` when it reaches 3:1 against the element, else white. */
export function edgeColor(element: string, shadow: string): string {
  return contrastRatio(element, shadow) >= MIN_GRAPHIC_CONTRAST ? shadow : '#FFFFFF';
}

export function resolvePalette<P extends Palette>(style: P, brandColors: readonly string[]): P {
  const [accent, secondary] = brandColors;
  return {
    ...style,
    ...(accent !== undefined && { accent }),
    ...(secondary !== undefined && { secondary }),
  };
}
