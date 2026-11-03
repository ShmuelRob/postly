import { createHash } from 'node:crypto';
import type { Fact, ModelTaskOutput } from '../../contracts/model-tasks.js';
import type { FactSource } from '../../contracts/post-version.js';

// The code fact check on caption_writing output and the version content hash (technical-design.md,
// Drafts flow; contracts.md, Model tasks). Code compares every factual detail in a caption with its
// source, so a mismatch blocks sending; no model decides it.

/** The profile details a caption may quote. */
export interface ProfileSources {
  location?: { city?: string | undefined; address?: string | undefined; hours?: string | undefined };
  contact?: { phone?: string | undefined; whatsapp?: string | undefined; website?: string | undefined; orderUrl?: string | undefined };
  differentiator?: string | undefined;
}

export interface CaptionCheckContext {
  /** The facts the post's plan named; the caption may use only these. */
  planFactIds: readonly string[];
  facts: readonly Fact[];
  profile: ProfileSources;
}

const PHONE = /(?:\+972[\s-]?|\b0)\d{1,2}[\s-]?\d{3}[\s-]?\d{4}\b/gu;
const NUMBER = /\d+(?:[.,:/]\d+)*/gu;
const WEEKDAY = /יום\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)(?![֐-׿])/gu;

const phoneDigits = (phone: string) => phone.replace(/\D/gu, '').replace(/^972/u, '0');

/** Phones, other numbers, and weekday names in a text. */
function details(text: string) {
  const phones = [...text.matchAll(PHONE)].map((m) => phoneDigits(m[0]));
  const rest = text.replace(PHONE, ' ');
  return {
    phones,
    numbers: [...rest.matchAll(NUMBER)].map((m) => m[0]),
    weekdays: [...rest.matchAll(WEEKDAY)].map((m) => m[1]!),
  };
}

/** The text a caption's details must come from: the used facts and the profile. */
export function captionSources(usedFactIds: readonly string[], facts: readonly Fact[], profile: ProfileSources): string {
  const used = facts.filter((f) => usedFactIds.includes(f.id)).flatMap((f) => [f.value, f.sourceQuote]);
  const { location, contact, differentiator } = profile;
  return [...used, location?.address, location?.city, location?.hours, ...Object.values(contact ?? {}), differentiator]
    .filter((s): s is string => typeof s === 'string')
    .join('\n');
}

/** caption_writing: null when every detail matches a source, else the first mismatch. */
export function checkCaptions(output: ModelTaskOutput<'caption_writing'>, context: CaptionCheckContext): string | null {
  const known = new Set(context.facts.map((f) => f.id));
  for (const id of output.usedFactIds) {
    if (!known.has(id)) return `usedFactIds: unknown fact ${id}`;
    if (!context.planFactIds.includes(id)) return `usedFactIds: fact ${id} is not in the post's plan`;
  }
  const source = details(captionSources(output.usedFactIds, context.facts, context.profile));
  for (const [network, caption] of Object.entries(output.captions)) {
    if (!caption) continue;
    const found = details([caption.text, ...caption.hashtags].join('\n'));
    const phone = found.phones.find((p) => !source.phones.includes(p));
    if (phone) return `${network}: phone ${phone} has no source`;
    const number = found.numbers.find((n) => !source.numbers.includes(n));
    if (number) return `${network}: "${number}" has no source`;
    const day = found.weekdays.find((d) => !source.weekdays.includes(d));
    if (day) return `${network}: "יום ${day}" has no source`;
  }
  return null;
}

/** The used facts as stored on the version (`fact_sources`). */
export function factSources(usedFactIds: readonly string[], facts: readonly Fact[]): FactSource[] {
  return facts
    .filter((f) => usedFactIds.includes(f.id))
    .map((f) => ({ factId: f.id, type: f.type, value: f.value, sourceQuote: f.sourceQuote }));
}

/** JSON with object keys sorted at every level. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** `post_version.content_hash`: SHA-256 of the canonical JSON of the format, captions, and rendered media. */
export function contentHash(version: { format: string; captions: unknown; renderedMedia: unknown }): string {
  const { format, captions, renderedMedia } = version;
  return createHash('sha256').update(canonical({ format, captions, renderedMedia })).digest('hex');
}
