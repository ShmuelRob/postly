import { z } from 'zod';
import { ContentType, Network, PostFormat, Uuid } from './common.js';

// Content shapes shared by the model tasks (model-tasks.ts) and the agent tools (agent.ts). They
// live here so the two files do not import each other; model-tasks.ts re-exports them.

const text = z.string().trim().min(1);
const factId = z.string().min(1);

export const FACT_TYPES = [
  'price',
  'discount_percent',
  'date',
  'date_range',
  'time',
  'address',
  'phone',
  'product',
  'promotion',
  'testimonial',
  'other',
] as const;

export const Fact = z.object({
  id: factId,
  type: z.enum(FACT_TYPES),
  value: text,
  /** Verbatim quote from the owner's text or transcript; checked in code. */
  sourceQuote: text,
});
export type Fact = z.infer<typeof Fact>;

export const PlannedPost = z.object({
  topic: text,
  contentType: ContentType,
  format: PostFormat,
  factIds: z.array(factId),
  mediaAssetIds: z.array(Uuid),
  brief: text,
});
export type PlannedPost = z.infer<typeof PlannedPost>;

export const Caption = z.object({
  text,
  hashtags: z.array(z.string().regex(/^#\S+$/, 'Hashtags start with # and have no spaces')),
});

export const ChannelCaptions = z
  .partialRecord(Network, Caption)
  .refine((captions) => Object.keys(captions).length > 0, 'At least one network caption is required');
export type ChannelCaptions = z.infer<typeof ChannelCaptions>;

export const PREFERENCE_SCOPES = ['caption', 'design', 'schedule', 'general'] as const;
