import { z } from 'zod';

export const Phone = z.e164();
export const Uuid = z.uuid();
export const Timestamp = z.iso.datetime({ offset: true });
export const ContentHash = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase hex SHA-256');
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a hex color such as #1a2b3c');
export const Url = z.url({ protocol: /^https?$/ });

export const NETWORKS = ['instagram', 'facebook'] as const;
export const Network = z.enum(NETWORKS);
export type Network = z.infer<typeof Network>;

export const LANGUAGES = ['he', 'ar', 'en', 'ru'] as const;
export const Language = z.enum(LANGUAGES);

export const VISUAL_STYLES = ['clean', 'warm', 'dynamic'] as const;
export const VisualStyle = z.enum(VISUAL_STYLES);

export const POST_FORMATS = ['single', 'carousel'] as const;
export const PostFormat = z.enum(POST_FORMATS);

export const CONTENT_TYPES = [
  'products',
  'promotions',
  'behind_the_scenes',
  'tips',
  'holidays_and_events',
  'testimonials',
] as const;
export const ContentType = z.enum(CONTENT_TYPES);

/** A non-empty array whose items are unique by value. */
export function uniqueList<T extends z.ZodType>(item: T) {
  return z
    .array(item)
    .refine((items) => new Set(items.map((i) => JSON.stringify(i))).size === items.length, 'Items must be unique');
}
