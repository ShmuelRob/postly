import { z } from 'zod';
import { type Language, Uuid } from './common.js';

// The fixed photo operations, title, badge and carousel layout of a post (agent.md, Photo edits;
// design-styles.md, Photo edits and badge). Nothing here creates or alters what a photo shows.
// The engine applies them in a fixed order: rotate, crop, tone, then the style template.

const unit = z.number().min(0).max(1);

/** A normalized focus rectangle inside the photo, used for the 4:5 cover crop. */
export const EditCrop = z
  .object({ x: unit, y: unit, w: unit.gt(0), h: unit.gt(0) })
  .refine((c) => c.x + c.w <= 1 + 1e-9 && c.y + c.h <= 1 + 1e-9, 'Crop must stay inside the photo');

/** -10 to 10 degrees in 0.5 steps. */
export const RotateDeg = z
  .number()
  .min(-10)
  .max(10)
  .refine((d) => Number.isInteger(d * 2), 'Rotation goes in 0.5 degree steps');

/** -0.3 to 0.3; 0 is unchanged. Applied linearly, with no filters. */
export const ToneAdjust = z.number().min(-0.3).max(0.3);

export const PhotoEdit = z.object({
  crop: EditCrop.optional(),
  rotateDeg: RotateDeg.optional(),
  brightness: ToneAdjust.optional(),
  contrast: ToneAdjust.optional(),
});
export type PhotoEdit = z.infer<typeof PhotoEdit>;

export const BADGE_KINDS = ['discount', 'price', 'new', 'sale', 'holiday'] as const;
export const BadgeKind = z.enum(BADGE_KINDS);
export type BadgeKind = z.infer<typeof BadgeKind>;

/** Kinds whose text is a number from a recorded fact; the others are fixed words per language. */
export const FACT_BADGE_KINDS = ['discount', 'price'] as const satisfies readonly BadgeKind[];

/** The fixed words of the stickers, per language; at most 8 characters each (design-styles.md, Badge). */
export const STICKER_WORDS: Record<z.infer<typeof Language>, Record<Exclude<BadgeKind, 'discount' | 'price'>, string>> = {
  he: { new: 'חדש', sale: 'מבצע', holiday: 'חג שמח' },
  ar: { new: 'جديد', sale: 'تخفيضات', holiday: 'عيد سعيد' },
  en: { new: 'NEW', sale: 'SALE', holiday: 'HOLIDAY' },
  ru: { new: 'НОВОЕ', sale: 'АКЦИЯ', holiday: 'ПРАЗДНИК' },
};

export function stickerText(kind: Exclude<BadgeKind, 'discount' | 'price'>, language: z.infer<typeof Language>): string {
  return STICKER_WORDS[language][kind];
}

/** Badge text: at most 8 characters, one line. */
export const BadgeText = z.string().trim().min(1).max(8).regex(/^[^\n]*$/, 'Badge text is one line');

const factId = z.string().min(1);

/**
 * A `discount` or `price` badge carries its text and the fact it shows (the fact check compares
 * them); a sticker (`new`, `sale`, `holiday`) carries neither, since its words are fixed.
 */
export const Badge = z.union([
  z.object({ kind: z.enum(FACT_BADGE_KINDS), text: BadgeText, factId }).strict(),
  z.object({ kind: z.enum(['new', 'sale', 'holiday']) }).strict(),
]);
export type Badge = z.infer<typeof Badge>;

export const CAROUSEL_LAYOUTS = ['standard', 'numbered'] as const;
export const CarouselLayout = z.enum(CAROUSEL_LAYOUTS);

/** The title band text: 1 to 40 characters, at most 2 lines (design-styles.md, Output). */
export const DesignTitle = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((t) => t.split('\n').length <= 2, 'At most 2 lines');

export const DesignPhoto = PhotoEdit.extend({ assetId: Uuid });

export const DesignSpec = z.object({
  /** 1 for a single post, 2 to 10 for a carousel; the first is the cover. */
  photos: z.array(DesignPhoto).min(1).max(10),
  title: DesignTitle,
  badge: Badge.optional(),
  /** Absent means `standard`. */
  carouselLayout: CarouselLayout.optional(),
});
export type DesignSpec = z.infer<typeof DesignSpec>;
