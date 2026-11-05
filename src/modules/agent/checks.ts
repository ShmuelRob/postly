import type { AgentContext } from '../../contracts/agent.js';

// Code checks on text the agent proposes for the owner (agent.md, Tools: common rules). They are
// deliberately simple and strict: a refusal only sends the agent back to rephrase.

/** Whitespace runs count as one space, as for every verbatim quote check (contracts.md). */
export const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();

/** The owner's latest burst: their messages after Postly's last one. */
export function latestOwnerText(context: AgentContext): string {
  const lastPostly = context.messages.map((m) => m.role).lastIndexOf('postly');
  return context.messages
    .slice(lastPostly + 1)
    .filter((m) => m.role === 'owner')
    .map((m) => m.text)
    .join('\n');
}

/** True when `quote` appears word for word (whitespace normalized) in `source`. */
export const quoteIn = (quote: string, source: string) => normalize(source).includes(normalize(quote));

/** Words that would read as an approval or a publication; the agent never says either (agent.md, Prompts). */
const APPROVAL_WORDS = [/\bapproved\b/iu, /\bit'?s live\b/iu, /\bpublished\b/iu, /אושר/u, /מאושר/u, /פורסם/u, /עלה לאוויר/u, /באוויר/u];
const URL = /(https?:\/\/|www\.)\S+|\b[\w-]+\.(com|co\.il|net|org|io|app|il)\b/iu;

/**
 * Why the text may not go to the owner, or null. Every number in it (a price, a date, a time, a
 * phone) must appear in a source: the owner's messages, the week's update, or the profile.
 */
export function ownerTextProblem(text: string, context: AgentContext): { reason: 'forbidden_content' | 'fact_mismatch'; detail: string } | null {
  if (URL.test(text)) return { reason: 'forbidden_content', detail: 'no links in a message to the owner' };
  const approval = APPROVAL_WORDS.find((w) => w.test(text));
  if (approval) return { reason: 'forbidden_content', detail: 'no approval or publishing language in a message to the owner' };
  const sources = normalize(
    [
      ...context.messages.filter((m) => m.role === 'owner').map((m) => m.text),
      context.week?.updateText ?? '',
      context.week?.transcript ?? '',
      ...(context.week?.facts.map((f) => `${f.value} ${f.sourceQuote}`) ?? []),
      JSON.stringify(context.profile),
    ].join('\n'),
  );
  const sourceDigits = sources.replace(/\D+/gu, ' ');
  for (const number of text.match(/\d+(?:[.,:/-]\d+)*/gu) ?? []) {
    if (sources.includes(number)) continue;
    // A phone or a number written with other separators still matches by its digit groups.
    if (number.split(/\D+/u).every((group) => new RegExp(`(^| )${group}( |$)`, 'u').test(sourceDigits))) continue;
    return { reason: 'fact_mismatch', detail: `"${number}" does not appear in the owner's messages or the profile` };
  }
  return null;
}
