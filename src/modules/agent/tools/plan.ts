import { and, eq, inArray, max } from 'drizzle-orm';
import { BusinessProfileDraft } from '../../../contracts/business-profile.js';
import type { PlannedPost } from '../../../contracts/content.js';
import * as schema from '../../../db/schema.js';
import type { ToolHandlers, ToolOutcome } from '../types.js';
import { currentWeek, type CurrentWeek, inWeek, refused } from './facts.js';

// plan_posts (WP-93; agent.md, plan_posts): the week's plan, checked in code. An initial plan is
// stored by the workflow (FACTS_EXTRACTED and the posts, through the injected `planStored`); a
// revised plan changes only posts that have no version, and may add planned posts.

declare module '../types.js' {
  interface AgentEvents {
    /**
     * plan_posts `initial` passed its checks: the workflow applies `FACTS_EXTRACTED` and inserts one
     * post per planned post, in one transaction (state-machines.md, Weekly update). Returns the new
     * post ids in plan order, or null when the week was no longer `received`.
     */
    planStored?(businessId: string, input: { weekId: string; posts: PlannedPost[] }): Promise<string[] | null>;
  }
}

/** Never more than 7 posts a week (agent.md, plan_posts); the schema enforces it too. */
const MAX_POSTS_PER_WEEK = 7;
/** Post states a revised plan may change: the post has no version yet. */
const REVISABLE = new Set(['planned', 'awaiting_clarification']);

const ok = (data: Record<string, unknown>): ToolOutcome => ({ result: { status: 'ok', data } });
const invalid = (detail: string) => refused('plan_invalid', detail);

/** The first problem with the planned posts, or null (agent.md, plan_posts: the code checks). */
function planProblem(posts: PlannedPost[], week: CurrentWeek, profile: { formats: readonly string[] }, justified: boolean): string | null {
  const facts = new Set(week.facts.map((f) => f.id));
  for (const [i, post] of posts.entries()) {
    const n = `post ${i + 1}`;
    const unknown = post.factIds.find((id) => !facts.has(id));
    if (unknown) return `${n}: ${unknown} is not a fact recorded this week`;
    if (!profile.formats.includes(post.format) && !justified) return `${n}: the profile has no ${post.format} format, and the owner did not ask for one`;
    const foreign = post.mediaAssetIds.find((id) => !week.photos.includes(id));
    if (foreign) return `${n}: photo ${foreign} is not one the owner sent this week`;
    if (post.format === 'carousel' && (post.mediaAssetIds.length < 2 || post.mediaAssetIds.length > 10)) return `${n}: a carousel has 2 to 10 photos`;
    if (post.format === 'single' && post.mediaAssetIds.length > 1) return `${n}: a single post has one photo or none`;
  }
  return null;
}

export const planTools: ToolHandlers = {
  async plan_posts(call, ctx) {
    const week = await currentWeek(ctx);
    if (!week) return refused('not_allowed', 'there is no week to plan');
    const justified = call.ownerQuote !== undefined && inWeek(week, call.ownerQuote);
    if (call.ownerQuote !== undefined && !justified) return invalid("the owner quote is not in the owner's messages this week");
    const draft = BusinessProfileDraft.safeParse(ctx.context.profile);
    const profile = { postsPerWeek: (draft.success && draft.data.postsPerWeek) || 3, formats: (draft.success && draft.data.formats) || ['single'] };

    if (call.mode === 'initial') {
      // Only the weekly agent plans a week, while its update is being gathered.
      if (ctx.agent !== 'weekly' || week.status !== 'received') return refused('not_allowed', 'an initial plan is made once, while the update is being gathered');
      // Never above 7 a week, justified or not: the schema no longer bounds the list (agent.md, Array limits).
      if (call.posts.length > MAX_POSTS_PER_WEEK) return invalid(`at most ${MAX_POSTS_PER_WEEK} posts a week`);
      if (call.posts.length !== profile.postsPerWeek && !justified) {
        return invalid(`${call.posts.length} posts planned, but the profile has ${profile.postsPerWeek} a week and the owner did not ask for another number`);
      }
      const problem = planProblem(call.posts, week, profile, justified);
      if (problem) return invalid(problem);
      const planStored = ctx.deps.events.planStored;
      if (!planStored) return refused('not_allowed', 'plans cannot be stored from this flow');
      const postIds = await planStored(ctx.businessId, { weekId: week.id, posts: call.posts.map(({ postId: _, ...post }) => post) });
      if (!postIds) return refused('not_allowed', 'the week is no longer being gathered');
      return ok({ postIds });
    }

    // revise: the week is planned; change posts without a version and add planned posts.
    if (week.status !== 'planned') return refused('not_allowed', 'a plan can be revised only after the week is planned');
    const problem = planProblem(call.posts, week, profile, justified);
    if (problem) return invalid(problem);
    return ctx.deps.db.withBusiness('workflow', ctx.businessId, async (tx) => {
      const t = schema.post;
      const ids = call.posts.flatMap((p) => (p.postId ? [p.postId] : []));
      const existing = await tx.select().from(t).where(and(eq(t.weeklyUpdateId, week.id), inArray(t.id, ids)));
      for (const id of ids) {
        const row = existing.find((r) => r.id === id);
        if (!row) return refused('unknown_id', `no post ${id} in this week`);
        if (!REVISABLE.has(row.status) || row.currentVersionId !== null) return invalid(`post ${id} already has a draft, so its plan can't change`);
      }
      const [{ count } = { count: 0 }] = await tx.select({ count: max(t.position) }).from(t).where(eq(t.weeklyUpdateId, week.id));
      const added = call.posts.filter((p) => !p.postId);
      const total = (await tx.select({ id: t.id }).from(t).where(eq(t.weeklyUpdateId, week.id))).length + added.length;
      if (total > MAX_POSTS_PER_WEEK) return invalid(`at most ${MAX_POSTS_PER_WEEK} posts a week`);
      if (added.length > 0 && !justified && total !== profile.postsPerWeek) {
        return invalid('adding a post needs the owner to have asked for it this week');
      }
      for (const { postId, ...post } of call.posts) {
        if (postId) await tx.update(t).set({ plan: post, format: post.format, updatedAt: new Date() }).where(eq(t.id, postId));
      }
      let position = (count ?? -1) + 1;
      const inserted = added.length
        ? await tx
            .insert(t)
            .values(added.map(({ postId: _, ...post }) => ({ businessId: ctx.businessId, weeklyUpdateId: week.id, position: position++, format: post.format, plan: post })))
            .returning({ id: t.id })
        : [];
      return ok({ postIds: [...ids, ...inserted.map((r) => r.id)] });
    });
  },
};
