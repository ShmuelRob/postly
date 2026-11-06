import { createHash } from 'node:crypto';
import type { DesignSpec } from '../../contracts/design-spec.js';
import type { Fact, ModelTaskOutput } from '../../contracts/model-tasks.js';
import type { FactSource } from '../../contracts/post-version.js';
import { normalizeHebrewDetails, weekdays } from './hebrew-details.js';

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
const AMOUNT = String.raw`\d+(?:[.,]\d+)?`;
const DISCOUNT = new RegExp(String.raw`(${AMOUNT})\s*%`, 'gu');
const PRICE = new RegExp(String.raw`(${AMOUNT})\s*(?:₪|ש"ח|ש״ח|שקל(?:ים)?)|₪\s*(${AMOUNT})`, 'gu');
const TIME = /(?<!\d)(~?\d{1,2}:\d{2})(?!\d)/gu;
const DATE = /(?<![\d.\/])(\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?)(?![\d\/])/gu;
const NUMBER = /\d+(?:[.,:/]\d+)*/gu;
const WEEKDAY = /יום\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)(?![\u0590-\u05FF])/gu;

const phoneDigits = (phone: string) => phone.replace(/\D/gu, '').replace(/^972/u, '0');

/** The kinds of factual detail the check tells apart; `number` is any other number, such as a house number. */
type Kind = 'phone' | 'price' | 'discount' | 'time' | 'date' | 'weekday' | 'number';
type Details = Record<Kind, string[]>;

/** `08:00` → `8:00`; `~8:00` (an hour with no part of day) stays marked. */
const canonicalTime = (t: string) => t.replace(/^(~?)0(\d)/u, '$1$2');
/** `05.11.26` → `5/11/2026`. */
function canonicalDate(d: string): string {
  const [day, month, year] = d.split(/[./]/u).map(Number);
  return `${day}/${month}${year === undefined ? '' : `/${year < 100 ? 2000 + year : year}`}`;
}

/** Each detail in a text, by kind. A detail is taken out of the text once it has a kind. */
function details(raw: string): Details {
  const text = normalizeHebrewDetails(raw);
  const take = (re: RegExp, map: (m: RegExpMatchArray) => string) => {
    const found = [...rest.matchAll(re)].map(map);
    rest = rest.replace(re, ' ');
    return found;
  };
  let rest = text;
  const phone = take(PHONE, (m) => phoneDigits(m[0]));
  // 100% is emphasis ("100% טבעי") unless it names a discount ("100% הנחה", "הנחה של 100%").
  const discount = take(DISCOUNT, (m) => {
    const after = m.input!.slice(m.index! + m[0].length, m.index! + m[0].length + 8);
    const before = m.input!.slice(Math.max(0, m.index! - 12), m.index!);
    return m[1] === '100' && !/^\s*הנחה/u.test(after) && !/הנחה(?:\s+של)?\s*$/u.test(before) ? '' : m[1]!;
  }).filter((d) => d !== '');
  const price = take(PRICE, (m) => (m[1] ?? m[2])!);
  const time = take(TIME, (m) => canonicalTime(m[1]!));
  const date = take(DATE, (m) => canonicalDate(m[1]!));
  const weekday = weekdays(rest);
  const number = [...rest.matchAll(NUMBER)].map((m) => m[0]);
  return { phone, price, discount, time, date, weekday, number };
}

/** Which kind a fact of each type vouches for, besides the details its own text shows. */
const KIND_OF_FACT: Partial<Record<Fact['type'], Kind>> = {
  price: 'price',
  discount_percent: 'discount',
  time: 'time',
  date: 'date',
  date_range: 'date',
  phone: 'phone',
};

/** The details a caption may use, by kind: the used facts and the profile. */
function sourceDetails(usedFactIds: readonly string[], facts: readonly Fact[], profile: ProfileSources): Details {
  const out: Details = { phone: [], price: [], discount: [], time: [], date: [], weekday: [], number: [] };
  const add = (text: string, kind?: Kind) => {
    const found = details(text);
    for (const k of Object.keys(out) as Kind[]) out[k].push(...found[k]);
    // Every number in the text, of whatever kind, is a plain number source too.
    out.number.push(...[...text.replace(PHONE, ' ').matchAll(NUMBER)].map((m) => m[0]));
    // A fact typed as a price (or discount, time, date) vouches for its numbers in that role.
    if (kind === 'time') out.time.push(...[...text.matchAll(NUMBER)].map((m) => canonicalTime(m[0])));
    else if (kind === 'date') out.date.push(...[...text.matchAll(NUMBER)].map((m) => canonicalDate(m[0])));
    else if (kind) out[kind].push(...[...text.matchAll(NUMBER)].map((m) => m[0]));
    if (kind === 'phone') out.phone.push(phoneDigits(text));
  };
  for (const f of facts.filter((f) => usedFactIds.includes(f.id))) for (const t of [f.value, f.sourceQuote]) add(t, KIND_OF_FACT[f.type]);
  const { location, contact, differentiator } = profile;
  for (const t of [location?.address, location?.city, location?.hours, differentiator]) if (t) add(t);
  for (const t of Object.values(contact ?? {})) if (t) add(t, 'phone');
  return out;
}

/**
 * Whether a caption detail has a source. A date with no year matches the same day and month with a
 * year; an hour with no part of day (`~8:00`) matches 8:00 or 20:00.
 */
function matches(kind: Kind, d: string, sources: readonly string[]): boolean {
  if (kind === 'date') return sources.some((s) => s === d || (d.split('/').length === 2 && s.startsWith(`${d}/`)));
  if (kind === 'time' && d.startsWith('~')) {
    const [h, m] = d.slice(1).split(':').map(Number);
    return [`${h}:${String(m).padStart(2, '0')}`, `${h! + 12}:${String(m).padStart(2, '0')}`].some((t) => sources.includes(t) || sources.includes(`~${t}`));
  }
  return sources.includes(d);
}

/** The text a caption's details must come from: the used facts and the profile. */
export function captionSources(usedFactIds: readonly string[], facts: readonly Fact[], profile: ProfileSources): string {
  const used = facts.filter((f) => usedFactIds.includes(f.id)).flatMap((f) => [f.value, f.sourceQuote]);
  const { location, contact, differentiator } = profile;
  return [...used, location?.address, location?.city, location?.hours, ...Object.values(contact ?? {}), differentiator]
    .filter((s): s is string => typeof s === 'string')
    .join('\n');
}

/**
 * caption_writing: null when every detail matches a source of its own kind, else the first mismatch.
 * A price must come from a price (a price fact, or a number shown with ₪ in a source), a discount from
 * a discount, and so on; only a plain number may match any number in the sources.
 */
export function checkCaptions(output: ModelTaskOutput<'caption_writing'>, context: CaptionCheckContext): string | null {
  const known = new Set(context.facts.map((f) => f.id));
  for (const id of output.usedFactIds) {
    if (!known.has(id)) return `usedFactIds: unknown fact ${id}`;
    if (!context.planFactIds.includes(id)) return `usedFactIds: fact ${id} is not in the post's plan`;
  }
  const source = sourceDetails(output.usedFactIds, context.facts, context.profile);
  for (const [network, caption] of Object.entries(output.captions)) {
    if (!caption) continue;
    const found = details([caption.text, ...caption.hashtags].join('\n'));
    for (const kind of Object.keys(found) as Kind[]) {
      const missing = found[kind].find((d) => !matches(kind, d, source[kind]));
      if (missing) return `${network}: ${kind} "${kind === 'weekday' ? `יום ${missing}` : missing.replace(/^~/u, '')}" has no source`;
    }
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

export interface DesignCheckContext extends CaptionCheckContext {
  /** The facts the post uses (its caption's `usedFactIds`): only these vouch for its title and badge. */
  usedFactIds: readonly string[];
  /** Whether the post's week (Sunday to Saturday, the business's time zone) holds a known holiday. */
  holidayInWeek: boolean;
}

export type DesignProblem = { reason: 'fact_mismatch' | 'badge_invalid'; detail: string };

const DISCOUNT_BADGE = /^-(\d+(?:\.\d+)?)%$/u;
const PRICE_BADGE = /^₪(\d+(?:\.\d{1,2})?)$/u;

/**
 * The code fact check of a DesignSpec's title and badge (agent.md, Badge element): the title's
 * details come from the used facts and the profile, as a caption's do; a `discount` badge equals a
 * recorded discount fact the post used and a `price` badge a recorded price; `sale` needs a promotion
 * or discount fact in the post; `holiday` needs a holiday in the post's week. `new` needs nothing.
 */
export function checkDesign(design: { title: string; badge?: DesignSpec['badge'] }, context: DesignCheckContext): DesignProblem | null {
  const source = sourceDetails(context.usedFactIds, context.facts, context.profile);
  const found = details(design.title);
  for (const kind of Object.keys(found) as Kind[]) {
    const missing = found[kind].find((d) => !matches(kind, d, source[kind]));
    if (missing) return { reason: 'fact_mismatch', detail: `title: ${kind} "${kind === 'weekday' ? `יום ${missing}` : missing.replace(/^~/u, '')}" has no source` };
  }

  const { badge } = design;
  if (!badge) return null;
  const used = context.facts.filter((f) => context.usedFactIds.includes(f.id));
  if (badge.kind === 'discount' || badge.kind === 'price') {
    const shape = badge.kind === 'discount' ? DISCOUNT_BADGE.exec(badge.text) : PRICE_BADGE.exec(badge.text);
    if (!shape) {
      return { reason: 'badge_invalid', detail: badge.kind === 'discount' ? 'a discount badge reads like -15%' : 'a price badge reads like ₪29.90' };
    }
    const fact = used.find((f) => f.id === badge.factId);
    const type = badge.kind === 'discount' ? 'discount_percent' : 'price';
    if (!fact || fact.type !== type) return { reason: 'fact_mismatch', detail: `the ${badge.kind} badge needs a recorded ${type} fact that the post uses (${badge.factId})` };
    // The fact's value is a bare number ("20") or text ("29.90 ₪", "15%"): its first number is the amount.
    const shown = /\d+(?:[.,]\d+)?/u.exec(fact.value)?.[0]?.replace(',', '.');
    if (shown === undefined || Number(shown) !== Number(shape[1])) {
      return { reason: 'fact_mismatch', detail: `the ${badge.kind} badge shows ${shape[1]}, the fact says ${shown ?? fact.value}` };
    }
    return null;
  }
  if (badge.kind === 'sale' && !used.some((f) => f.type === 'promotion' || f.type === 'discount_percent')) {
    return { reason: 'fact_mismatch', detail: 'a sale badge needs a promotion or discount fact in the post' };
  }
  if (badge.kind === 'holiday' && !context.holidayInWeek) return { reason: 'fact_mismatch', detail: 'a holiday badge needs a holiday in the post week' };
  return null;
}
