import { z } from 'zod';
import { BusinessProfile } from '../contracts/business-profile.js';
import { FactExtractionOutput } from '../contracts/model-tasks.js';
import { PlaceholderSpec } from './placeholder-photo.js';

// The entry.json file of one example-set entry. The format is described in
// fixtures/example-set/README.md.

/** Overlay text rule from design-styles.md: at most 2 lines and 40 characters. */
export const OverlayText = z
  .string()
  .refine((text) => text.trim().length > 0, 'Overlay text is empty')
  .refine((text) => text.split('\n').length <= 2, 'Overlay text has more than 2 lines')
  .refine((text) => [...text.replace(/\n/g, '')].length <= 40, 'Overlay text is longer than 40 characters');

/** A photo path inside the entry folder, under photos/. */
const PhotoFile = z.string().regex(/^photos\/[a-z0-9-]+\.(svg|jpg|jpeg|png)$/, 'Expected photos/<name>.svg|jpg|jpeg|png');

export const ExamplePhoto = z
  .object({
    file: PhotoFile,
    description: z.string().trim().min(1),
    /** Present only for code-generated placeholder photos, which are SVG. */
    placeholder: PlaceholderSpec.optional(),
  })
  .refine((photo) => photo.placeholder === undefined || photo.file.endsWith('.svg'), {
    message: 'A placeholder photo is an SVG file',
    path: ['file'],
  });

export const ExampleEntryFile = z.object({
  provisional: z.boolean(),
  profile: BusinessProfile,
  /** Carousel limit from design-styles.md. */
  photos: z.array(ExamplePhoto).min(1).max(10),
  /**
   * What the example should produce: the fact_extraction output for the
   * weekly update (every sourceQuote verbatim in it), and overlay texts the
   * design engine renders on the cover.
   */
  expected: FactExtractionOutput.extend({
    overlayTexts: z.array(OverlayText).min(1),
  }),
});
export type ExampleEntryFile = z.infer<typeof ExampleEntryFile>;
