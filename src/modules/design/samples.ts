import { VISUAL_STYLES } from '../../contracts/common.js';

type VisualStyle = (typeof VISUAL_STYLES)[number];
import type { TemplateRenderer } from '../../contracts/providers/renderer.js';

export interface StyleSampleInput {
  photoUrl: string;
  logoUrl?: string;
  brandColors: string[];
  /** Short overlay text, such as the business name. */
  overlayText: string;
}

export interface StyleSample {
  style: VisualStyle;
  storagePath: string;
}

/**
 * The onboarding style samples (PRD, WhatsApp onboarding, step 4): one single Instagram post in each
 * of the three styles from the same photo and text, so the owner compares styles, not content.
 */
export async function renderStyleSamples(renderer: TemplateRenderer, input: StyleSampleInput): Promise<StyleSample[]> {
  const samples: StyleSample[] = [];
  for (const style of VISUAL_STYLES) {
    const result = await renderer.render({
      style,
      format: 'single',
      photoUrls: [input.photoUrl],
      overlayText: input.overlayText,
      ...(input.logoUrl ? { logoUrl: input.logoUrl } : {}),
      brandColors: input.brandColors,
      networks: ['instagram'],
    });
    const file = result.instagram?.[0];
    if (!file) throw new Error(`No ${style} sample was rendered`);
    samples.push({ style, storagePath: file.storagePath });
  }
  return samples;
}
