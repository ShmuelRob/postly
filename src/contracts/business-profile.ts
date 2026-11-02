import { z } from 'zod';
import {
  ContentType,
  HexColor,
  Language,
  Network,
  Phone,
  PostFormat,
  Url,
  Uuid,
  VisualStyle,
  uniqueList,
} from './common.js';

const nonBlank = z.string().trim().min(1);

// Field schemas without defaults. BusinessProfile adds the PRD defaults;
// BusinessProfileDraft makes every field optional for onboarding.
const fields = {
  name: nonBlank,
  field: nonBlank,
  mainProducts: z.array(nonBlank).min(1),
  location: z.object({
    city: nonBlank,
    address: nonBlank,
    hours: nonBlank,
    fulfillment: uniqueList(z.enum(['pickup', 'delivery'])).min(1),
  }),
  targetAudience: nonBlank,
  differentiator: nonBlank,
  languages: uniqueList(Language).min(1),
  tone: z.object({
    register: z.enum(['formal', 'warm', 'humorous']),
    address: z.enum(['masculine', 'feminine', 'plural']),
    emoji: z.boolean(),
  }),
  contentTypes: uniqueList(ContentType).min(1),
  formats: uniqueList(PostFormat).min(1),
  channels: uniqueList(Network).min(1),
  postsPerWeek: z.int().min(2).max(5),
  schedule: z.object({
    publishOnShabbatAndHolidays: z.boolean(),
    /** 0 is Sunday. Empty means any day the agent proposes. */
    days: uniqueList(z.int().min(0).max(6)),
    /** Preferred local times, HH:MM. Empty means the agent proposes. */
    hours: uniqueList(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM')),
  }),
  brand: z.object({
    logoAssetId: Uuid.optional(),
    colors: z.array(HexColor).max(5),
  }),
  style: VisualStyle,
  callToAction: z.enum(['visit', 'call', 'message', 'order_online']),
  contact: z.object({
    phone: Phone.optional(),
    whatsapp: Phone.optional(),
    website: Url.optional(),
    orderUrl: Url.optional(),
  }),
  forbiddenTopics: z.array(nonBlank),
  fixedHashtags: z.array(z.string().regex(/^#\S+$/, 'Hashtags start with # and have no spaces')),
  approverPhone: Phone,
};

export const BusinessProfile = z.object({
  ...fields,
  targetAudience: fields.targetAudience.default('Local residents'),
  languages: fields.languages.default(['he']),
  tone: fields.tone.default({ register: 'warm', address: 'plural', emoji: true }),
  contentTypes: fields.contentTypes.default(['products', 'promotions']),
  formats: fields.formats.default(['single']),
  postsPerWeek: fields.postsPerWeek.default(3),
  schedule: fields.schedule.default({ publishOnShabbatAndHolidays: false, days: [], hours: [] }),
  brand: fields.brand.default({ colors: [] }),
  callToAction: fields.callToAction.default('visit'),
  contact: fields.contact.default({}),
  forbiddenTopics: fields.forbiddenTopics.default(['politics', 'competitor comparisons']),
  fixedHashtags: fields.fixedHashtags.default([]),
});
export type BusinessProfile = z.infer<typeof BusinessProfile>;

export const BusinessProfileDraft = z.object(fields).partial();
export type BusinessProfileDraft = z.infer<typeof BusinessProfileDraft>;

/** Required profile fields that have no default and must come from the owner. */
export const REQUIRED_PROFILE_FIELDS = [
  'name',
  'field',
  'mainProducts',
  'location',
  'differentiator',
  'channels',
  'style',
  'approverPhone',
] as const satisfies ReadonlyArray<keyof typeof fields>;
export type RequiredProfileField = (typeof REQUIRED_PROFILE_FIELDS)[number];

/** Guard for PROFILE_FIELDS_COMPLETE: required fields still missing or invalid in the draft. */
export function missingRequiredProfileFields(draft: Record<string, unknown>): RequiredProfileField[] {
  return REQUIRED_PROFILE_FIELDS.filter((key) => !fields[key].safeParse(draft[key]).success);
}
