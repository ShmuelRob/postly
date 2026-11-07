import { inArray } from 'drizzle-orm';
import type { AgentContext, AgentToolResult } from '../../../contracts/agent.js';
import { BusinessProfileDraft } from '../../../contracts/business-profile.js';
import type { ChannelCaptions, Fact, PREFERENCE_SCOPES } from '../../../contracts/content.js';
import type { DesignSpec } from '../../../contracts/design-spec.js';
import * as schema from '../../../db/schema.js';
import { checkCaptions, checkDesign } from '../../content/index.js';
import { latestOwnerText, quoteIn } from '../checks.js';
import type { ToolContext, ToolHandlers, ToolOutcome } from '../types.js';

// create_draft and apply_change (WP-94; agent.md, create_draft and apply_change). The tools run the
// checks that need only data (ids, states, ranges, the fact check of captions, title and badge); the
// workflow then renders, versions and sends through the existing drafts code, injected as events.
// The agent never sees or sends the buttons, and never approves.

type Refusal = Extract<AgentToolResult, { status: 'refused' }>['reason'];

/** What the workflow's drafts code answers: the draft went out, or why it could not. */
export type DraftOutcome = { status: 'ok'; data: Record<string, unknown> } | { status: 'refused'; reason: Refusal; detail: string };

declare module '../types.js' {
  interface AgentEvents {
    /**
     * Renders, versions and sends a first draft (the post's events per agent.md, create_draft:
     * DRAFT_STARTED or DETAIL_PROVIDED, then DRAFT_READY). A render that fails refuses `render_failed`.
     */
    draftCreated?(businessId: string, input: { postId: string; captions: ChannelCaptions; usedFactIds: string[]; design: DesignSpec }): Promise<DraftOutcome>;
    /**
     * Applies an owner's fix: invalidates the post's approvals and pending publications first,
     * CHANGE_REQUESTED, saves the rule, renders, writes the new version and sends it with new buttons.
     */
    changeApplied?(
      businessId: string,
      input: { postId: string; ownerQuote: string; captions?: ChannelCaptions; design?: DesignSpec; networks?: string[]; rule?: { text: string; scope: (typeof PREFERENCE_SCOPES)[number] } },
    ): Promise<DraftOutcome>;
    /** Whether the post's week holds a holiday the calendar knows (the holiday badge). */
    holidayInWeek?(businessId: string, postId: string): Promise<boolean>;
  }
}

const ok = (data: Record<string, unknown>): ToolOutcome => ({ result: { status: 'ok', data } });
const refused = (reason: Refusal, detail: string): ToolOutcome => ({ result: { status: 'refused', reason, detail } });

/** Post states a first draft may be written in (no version yet). */
const DRAFTABLE = new Set(['planned', 'drafting', 'awaiting_clarification']);
/** Post states a fix may target (agent.md, apply_change). */
const CHANGEABLE = new Set(['awaiting_approval', 'approved', 'scheduled']);
/** The crop must keep at least this many source pixels across, so a post is never blurred by zoom. */
export const MIN_CROP_PIXELS = 720;

const profileOf = (context: AgentContext) => {
  const parsed = BusinessProfileDraft.safeParse(context.profile);
  return parsed.success ? parsed.data : {};
};

/** The text a post puts in front of customers, for the forbidden-topics word list. */
const customerText = (captions: ChannelCaptions | undefined, design: DesignSpec | undefined) =>
  [...Object.values(captions ?? {}).flatMap((c) => (c ? [c.text, ...c.hashtags] : [])), design?.title ?? ''].join('\n').toLowerCase();

/** The first problem with captions and design that needs only the data in the context, or null. */
async function contentProblem(
  ctx: ToolContext,
  post: AgentContext['posts'][number],
  content: { captions: ChannelCaptions; usedFactIds: string[]; design: DesignSpec },
): Promise<ToolOutcome | null> {
  const profile = profileOf(ctx.context);
  const channels = profile.channels ?? [];
  const networks = Object.keys(content.captions);
  const stray = networks.find((n) => !channels.includes(n as never));
  if (stray) return refused('invalid_input', `${stray} is not one of the business's channels`);
  const missing = channels.find((n) => !networks.includes(n));
  if (missing) return refused('invalid_input', `write a caption for ${missing} too`);

  const unknown = content.usedFactIds.find((id) => !post.plan.factIds.includes(id));
  if (unknown) return refused('invalid_input', `fact ${unknown} is not one the post's plan names`);

  // The photos: the business's own, the post's own, and a crop that keeps enough pixels.
  const ids = content.design.photos.map((p) => p.assetId);
  const assets = await ctx.deps.db.withBusiness('workflow', ctx.businessId, (tx) =>
    tx.select({ id: schema.mediaAsset.id, kind: schema.mediaAsset.kind, width: schema.mediaAsset.width }).from(schema.mediaAsset).where(inArray(schema.mediaAsset.id, ids)),
  );
  for (const photo of content.design.photos) {
    const asset = assets.find((a) => a.id === photo.assetId);
    if (!asset || asset.kind !== 'photo') return refused('unknown_id', `no photo ${photo.assetId} in this business`);
    if (post.plan.mediaAssetIds.length > 0 && !post.plan.mediaAssetIds.includes(photo.assetId)) {
      return refused('invalid_input', `photo ${photo.assetId} is not one the post's plan names`);
    }
    if (photo.crop && asset.width !== null && photo.crop.w * asset.width < MIN_CROP_PIXELS) {
      return refused('edit_out_of_range', `the crop keeps ${Math.round(photo.crop.w * asset.width)} source pixels across; at least ${MIN_CROP_PIXELS} are needed`);
    }
  }
  if (post.format === 'single' && content.design.photos.length !== 1) return refused('invalid_input', 'a single post has exactly one photo');
  // The schema no longer bounds the photos (agent.md, Array limits), so the upper limit is checked here too.
  if (post.format === 'carousel' && (content.design.photos.length < 2 || content.design.photos.length > 10)) return refused('invalid_input', 'a carousel has 2 to 10 photos');

  const forbidden = (profile.forbiddenTopics ?? []).find((t) => customerText(content.captions, content.design).includes(t.toLowerCase()));
  if (forbidden) return refused('forbidden_content', `the post mentions "${forbidden}", which the owner asked us to avoid`);

  // The fact check, in code: captions, then the title and badge.
  const facts: Fact[] = ctx.context.week?.facts ?? [];
  const sources = { planFactIds: post.plan.factIds, facts, profile: {
      ...(profile.location ? { location: profile.location } : {}),
      ...(profile.contact ? { contact: profile.contact } : {}),
      ...(profile.differentiator ? { differentiator: profile.differentiator } : {}),
    },
  };
  const caption = checkCaptions({ captions: content.captions, usedFactIds: content.usedFactIds }, sources);
  if (caption) return refused('fact_mismatch', caption);
  const holidayInWeek = content.design.badge?.kind === 'holiday' ? ((await ctx.deps.events.holidayInWeek?.(ctx.businessId, post.id)) ?? false) : false;
  const design = checkDesign(content.design, { ...sources, usedFactIds: content.usedFactIds, holidayInWeek });
  if (design) return refused(design.reason, design.detail);
  return null;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const draftsTools: ToolHandlers = {
  async create_draft(call, ctx) {
    const post = ctx.context.posts.find((p) => p.id === call.postId);
    if (!post) return refused('unknown_id', 'no such post this week');
    if (!DRAFTABLE.has(post.state) || post.captions) return refused('not_allowed', `post ${post.id} is ${post.state}${post.captions ? ' and already has a draft' : ''}; use apply_change to fix a draft`);
    const draftCreated = ctx.deps.events.draftCreated;
    if (!draftCreated) return refused('not_allowed', 'drafts cannot be created from this flow');
    const problem = await contentProblem(ctx, post, call);
    if (problem) return problem;
    const outcome = await draftCreated(ctx.businessId, { postId: call.postId, captions: call.captions, usedFactIds: call.usedFactIds, design: call.design });
    return outcome.status === 'ok' ? ok(outcome.data) : refused(outcome.reason, outcome.detail);
  },

  async apply_change(call, ctx) {
    const post = ctx.context.posts.find((p) => p.id === call.postId);
    if (!post) return refused('unknown_id', 'no such post this week');
    if (!CHANGEABLE.has(post.state)) return refused('not_allowed', `post ${post.id} is ${post.state}; a fix applies to a draft, an approved or a scheduled post`);
    if (!quoteIn(call.ownerQuote, latestOwnerText(ctx.context))) return refused('quote_not_found', "the quote is not in the owner's latest message");
    if (!post.captions || !post.design) return refused('not_allowed', 'this post has no version to change');

    const current = Object.keys(post.captions);
    if (call.networks && call.networks.some((n) => !current.includes(n))) return refused('invalid_input', 'a change can only narrow the networks of the post');
    const captions = call.captions ?? post.captions;
    const design = call.design ?? post.design;
    const networks = call.networks ?? current;
    if (call.captions === undefined && call.design === undefined && sameJson([...networks].sort(), [...current].sort())) return refused('no_change', 'the networks are already these');
    if ((call.captions === undefined || sameJson(call.captions, post.captions)) && (call.design === undefined || sameJson(call.design, post.design)) && sameJson([...networks].sort(), [...current].sort())) {
      return refused('no_change', 'the new captions and design are the same as the current version');
    }
    const changeApplied = ctx.deps.events.changeApplied;
    if (!changeApplied) return refused('not_allowed', 'changes cannot be applied from this flow');

    // The same checks as a first draft, on the content the version will have; its facts are the post's plan facts.
    const narrowed = Object.fromEntries(Object.entries(captions).filter(([n]) => networks.includes(n))) as ChannelCaptions;
    const usedFactIds = post.plan.factIds;
    const problem = await contentProblem({ ...ctx, context: { ...ctx.context, profile: { ...ctx.context.profile, channels: networks as never } } }, post, { captions: narrowed, usedFactIds, design });
    if (problem) return problem;
    const outcome = await changeApplied(ctx.businessId, {
      postId: call.postId,
      ownerQuote: call.ownerQuote,
      ...(call.captions ? { captions: call.captions } : {}),
      ...(call.design ? { design: call.design } : {}),
      ...(call.networks ? { networks: call.networks } : {}),
      ...(call.rule ? { rule: call.rule } : {}),
    });
    return outcome.status === 'ok' ? ok(outcome.data) : refused(outcome.reason, outcome.detail);
  },
};
