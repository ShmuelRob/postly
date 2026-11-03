import { z } from 'zod';
import { Network, Uuid } from './common.js';
import { FACT_TYPES } from './model-tasks.js';

// What a post_version stores beside its captions (contracts.md, "What a post_version stores").

/** Rendered `media_asset` ids per network, in slide order. */
export const RenderedMedia = z.partialRecord(Network, z.array(Uuid).min(1));
export type RenderedMedia = z.infer<typeof RenderedMedia>;

/** A factual detail the captions use and where it came from. */
export const FactSource = z.object({
  factId: z.string().min(1),
  type: z.enum(FACT_TYPES),
  value: z.string(),
  sourceQuote: z.string(),
});
export type FactSource = z.infer<typeof FactSource>;
