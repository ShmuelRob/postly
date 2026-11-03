import type { Fact, ModelTaskOutput, PlannedPost } from '../../contracts/model-tasks.js';
import type { POST_FORMATS } from '../../contracts/common.js';

// Code checks on model output that the schema cannot express (contracts.md). Each returns null to
// accept the output or a reason to reject it; the model layer counts a rejection as a failed attempt.

/** Whitespace runs, line breaks included, count as one space. */
const squash = (text: string) => text.replace(/\s+/gu, ' ').trim();

/** fact_extraction: every quote appears word for word in the source; a testimonial only in the typed text. */
export function checkQuotes(output: ModelTaskOutput<'fact_extraction'>, source: { text: string; transcript?: string }): string | null {
  const text = squash(source.text);
  const transcript = squash(source.transcript ?? '');
  for (const fact of output.facts) {
    const quote = squash(fact.sourceQuote);
    if (fact.type === 'testimonial') {
      if (!text.includes(quote)) return `fact ${fact.id}: a testimonial quote must appear in the typed text`;
    } else if (!text.includes(quote) && !transcript.includes(quote)) {
      return `fact ${fact.id}: quote not found in the update: ${JSON.stringify(fact.sourceQuote)}`;
    }
  }
  return null;
}

export interface PlanContext {
  facts: Fact[];
  postsPerWeek: number;
  formats: readonly (typeof POST_FORMATS)[number][];
  /** The photos of this update. */
  mediaAssetIds: readonly string[];
}

/** weekly_planning: postsPerWeek posts, known fact ids, profile formats, and this update's photos. */
export function checkPlan(posts: PlannedPost[], context: PlanContext): string | null {
  if (posts.length !== context.postsPerWeek) return `${posts.length} posts planned, postsPerWeek is ${context.postsPerWeek}`;
  const factIds = new Set(context.facts.map((f) => f.id));
  for (const [i, post] of posts.entries()) {
    const unknown = post.factIds.find((id) => !factIds.has(id));
    if (unknown) return `post ${i}: unknown fact id ${unknown}`;
    if (!context.formats.includes(post.format)) return `post ${i}: format ${post.format} is not in the profile`;
    const foreign = post.mediaAssetIds.find((id) => !context.mediaAssetIds.includes(id));
    if (foreign) return `post ${i}: photo ${foreign} is not part of the update`;
  }
  return null;
}
