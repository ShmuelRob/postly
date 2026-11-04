import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';
import { BusinessProfile } from '../../contracts/business-profile.js';
import { NETWORKS, type Network } from '../../contracts/common.js';
import type { z } from 'zod';
import type { Language as LanguageSchema } from '../../contracts/common.js';

type Language = z.infer<typeof LanguageSchema>;
import type { ChannelCaptions, Fact, ModelTaskInput, ModelTaskName, ModelTaskOutput, PlannedPost } from '../../contracts/model-tasks.js';
import { OpenQuestion } from '../../contracts/open-question.js';
import type { RenderedMedia } from '../../contracts/post-version.js';
import { encodeButtonId, WindowClosedError, type SendButtonsRequest, type SendTemplateRequest, type SendTextRequest } from '../../contracts/providers/messaging.js';
import type { RenderRequest, RenderResult } from '../../contracts/providers/renderer.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { checkCaptions, contentHash, factSources } from '../content/index.js';
import * as copy from './drafts-copy.js';
import * as weeklyCopy from './weekly-copy.js';
import { MAX_QUESTION_ATTEMPTS, type OnboardingBurst } from './onboarding.js';
import type { Workflow } from './workflow.js';

// Drafts (PRD, Weekly update and content preparation, Content safeguards; technical-design.md,
// Drafts flow; state-machines.md, Post and Conversation). Code owns every step: the model writes
// captions and reads change requests, code checks the facts, renders, versions, and sends.
// Approval itself is WP-33.

/** A burst as drafts reads it: the inbound messages carry their row id and content. */
export interface DraftsBurst extends OnboardingBurst {
  messages: { id: string; content: { kind: string; payload?: unknown }; mediaAssetIds: string[] }[];
}

export interface DraftsDeps {
  db: Database;
  workflow: Workflow;
  messaging: {
    sendText(businessId: string, request: SendTextRequest): Promise<unknown>;
    sendButtons(businessId: string, request: SendButtonsRequest): Promise<unknown>;
    /** For the `drafts_ready` template when the 24-hour window has closed (technical-design.md, Failure handling). */
    sendTemplate?(businessId: string, request: SendTemplateRequest): Promise<unknown>;
  };
  model: {
    run<T extends ModelTaskName>(
      businessId: string,
      task: T,
      input: ModelTaskInput<T>,
      options?: { referenceId?: string; check?: (output: ModelTaskOutput<T>) => string | null },
    ): Promise<ModelTaskOutput<T>>;
  };
  /** Renders with the design module for one business (`forBusiness(...).render`). */
  render(business: { businessId: string; businessName: string; languages: Language[] }, request: RenderRequest): Promise<RenderResult>;
  /** URL of a business media asset. */
  mediaUrl(businessId: string, mediaAssetId: string): Promise<string>;
  /** URL and bytes of a stored file, such as a rendered one. */
  urlFor(storagePath: string): string;
  readFile(storagePath: string): Promise<Uint8Array | undefined>;
  /** The photo used when a post has none and the library is empty. */
  samplePhotoUrl: string;
  /**
   * Invalidates the post's valid approvals and cancels its pending publications (the approval
   * service, WP-33). Called before any new version and before a change leaves `approved` or `scheduled`.
   */
  invalidate(businessId: string, postId: string): Promise<void>;
}

export interface Drafts {
  /** Drafts every post of the week still to draft, then moves the conversation to `reviewing_drafts`. */
  draftWeek(businessId: string, weekId: string): Promise<void>;
  /**
   * Handles a burst while the conversation is `awaiting_answer` or `reviewing_drafts`. Returns false
   * when the burst is not for drafts (another step), so the next flow may take it.
   */
  handle(burst: DraftsBurst): Promise<boolean>;
  /** Sends `text`, then every open draft again with its buttons (after a refused Approve tap). */
  resendOpen(businessId: string, to: string, text: string): Promise<void>;
  /** The post's planned topic, for the approval confirmation. */
  topicOf(businessId: string, postId: string): Promise<string | undefined>;
}

export type PhotoChoice = 'carousel' | 'one' | 'per_photo';

/** The owner's answer to the several-photos question, read in code. */
export function parsePhotoChoice(text: string): PhotoChoice | undefined {
  const t = text.trim().replace(/[.!,״"']+$/u, '').trim();
  if (t === '1' || /קרוסלה/u.test(t)) return 'carousel';
  if (t === '3' || /כל תמונה|נפרד/u.test(t)) return 'per_photo';
  if (t === '2' || /^תמונה אחת|^אחת$/u.test(t)) return 'one';
  return undefined;
}

/** A `channels` change that names one network only narrows the post to it. */
export function networksFromChange(instructions: string[], current: Network[]): Network[] {
  const text = instructions.join(' ');
  const ig = /אינסטגרם|instagram/iu.test(text);
  const fb = /פייסבוק|facebook/iu.test(text);
  if (ig && !fb && current.includes('instagram')) return ['instagram'];
  if (fb && !ig && current.includes('facebook')) return ['facebook'];
  return current;
}

/** The console item reason when a change is refused after the post's approval was invalidated. */
export const CHANGE_REFUSED = 'change refused after approval was invalidated';

const SCOPE_BY_TARGET = { caption: 'caption', design: 'design', media: 'design', schedule: 'schedule', channels: 'general' } as const;

type PostRow = typeof schema.post.$inferSelect;
type VersionRow = typeof schema.postVersion.$inferSelect;
type Outcome = 'sent' | 'asked' | 'failed';

const isModelFailure = (error: unknown) => error instanceof Error && error.name === 'ModelTaskFailedError';

/** The open question while drafts wait for the owner because the 24-hour window had closed. */
export const DRAFTS_WAITING = 'drafts_waiting';

export function createDrafts(deps: DraftsDeps): Drafts {
  const { db, workflow } = deps;
  /** Businesses whose drafts of the current run could not be sent because the window had closed. */
  const windowClosed = new Set<string>();

  const loadBusiness = (businessId: string) =>
    db.withBusiness('workflow', businessId, async (tx) => {
      const [business] = await tx.select().from(schema.business).where(eq(schema.business.id, businessId));
      const [state] = await tx.select().from(schema.conversationState).where(eq(schema.conversationState.businessId, businessId));
      if (!business || !state) return undefined;
      const question = state.openQuestion ? OpenQuestion.safeParse(state.openQuestion) : undefined;
      return { business, step: state.step, question: question?.success ? question.data : undefined };
    });

  const loadPost = (businessId: string, postId: string) =>
    db.withBusiness('workflow', businessId, async (tx) => (await tx.select().from(schema.post).where(eq(schema.post.id, postId)))[0]);

  const currentVersion = (businessId: string, post: PostRow) =>
    post.currentVersionId
      ? db.withBusiness('content', businessId, async (tx) => (await tx.select().from(schema.postVersion).where(eq(schema.postVersion.id, post.currentVersionId!)))[0])
      : Promise.resolve(undefined);

  const setQuestion = (businessId: string, question: OpenQuestion | null) =>
    db.withBusiness('workflow', businessId, (tx) =>
      tx.update(schema.conversationState).set({ openQuestion: question, updatedAt: new Date() }).where(eq(schema.conversationState.businessId, businessId)),
    );

  const conversation = (businessId: string, event: string, question?: OpenQuestion | null) =>
    workflow.apply(businessId, {
      machine: 'conversation',
      id: businessId,
      event,
      source: 'inbound',
      ...(question !== undefined
        ? {
            guard: async (tx) => {
              await tx.update(schema.conversationState).set({ openQuestion: question }).where(eq(schema.conversationState.businessId, businessId));
              return null;
            },
          }
        : {}),
    });

  const postEvent = (businessId: string, postId: string, event: string, guard?: Parameters<Workflow['apply']>[1]['guard']) =>
    workflow.apply(businessId, { machine: 'post', id: postId, event, source: 'system', ...(guard ? { guard } : {}) });

  async function handOff(businessId: string, to: string, reason: string, text: string) {
    await workflow.startHandoff(businessId, { reason, step: 'drafts' });
    await deps.messaging.sendText(businessId, { to, text });
  }

  /** The week's facts, as extraction stored them. */
  const weekFacts = (businessId: string, weekId: string) =>
    db.withBusiness('content', businessId, async (tx) => {
      const [week] = await tx.select({ facts: schema.weeklyUpdate.extractedFacts }).from(schema.weeklyUpdate).where(eq(schema.weeklyUpdate.id, weekId));
      return ((week?.facts as { facts?: Fact[] } | null)?.facts ?? []) as Fact[];
    });

  /** Photo URLs for a post: its own photos, else the latest library photo, else the sample photo. */
  async function photoUrls(businessId: string, post: PostRow, plan: PlannedPost): Promise<string[]> {
    const ids = post.format === 'single' ? plan.mediaAssetIds.slice(0, 1) : plan.mediaAssetIds;
    if (ids.length > 0) return Promise.all(ids.map((id) => deps.mediaUrl(businessId, id)));
    const [latest] = await db.withBusiness('content', businessId, (tx) =>
      tx
        .select({ id: schema.mediaAsset.id })
        .from(schema.mediaAsset)
        .where(and(eq(schema.mediaAsset.kind, 'photo'), eq(schema.mediaAsset.source, 'owner')))
        .orderBy(desc(schema.mediaAsset.createdAt))
        .limit(1),
    );
    return [latest ? await deps.mediaUrl(businessId, latest.id) : deps.samplePhotoUrl];
  }

  /** Stores each rendered file as a `media_asset` (design role) and returns the ids per network. */
  async function storeRenders(businessId: string, result: RenderResult): Promise<RenderedMedia> {
    const files = new Map<string, { mimeType: string; width: number; height: number; sha256: string }>();
    for (const list of Object.values(result)) {
      for (const file of list ?? []) {
        if (files.has(file.storagePath)) continue;
        const bytes = await deps.readFile(file.storagePath);
        if (!bytes) throw new Error(`Rendered file ${file.storagePath} was not stored`);
        files.set(file.storagePath, { ...file, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
    const ids = await db.withBusiness('design', businessId, async (tx) => {
      const byPath = new Map<string, string>();
      for (const [storagePath, f] of files) {
        const [row] = await tx
          .insert(schema.mediaAsset)
          .values({ businessId, kind: 'rendered', source: 'render', storagePath, mimeType: f.mimeType, width: f.width, height: f.height, sha256: f.sha256 })
          .returning({ id: schema.mediaAsset.id });
        byPath.set(storagePath, row!.id);
      }
      return byPath;
    });
    return Object.fromEntries(Object.entries(result).map(([network, list]) => [network, (list ?? []).map((f) => ids.get(f.storagePath)!)]));
  }

  async function sendDraft(businessId: string, to: string, post: PostRow, version: VersionRow) {
    const plan = post.plan as PlannedPost;
    const captions = version.captions as ChannelCaptions;
    const media = version.renderedMedia as RenderedMedia;
    // The Approve button carries the hash of every network's caption and render, so the owner is
    // shown all of them before the buttons (technical-design.md, Drafts flow).
    // jsonb does not keep key order: Instagram first, then Facebook.
    const networks = NETWORKS.filter((n) => captions[n]);
    const [network] = networks as [Network];
    const rows = await db.withBusiness('content', businessId, (tx) =>
      tx.select().from(schema.mediaAsset).where(inArray(schema.mediaAsset.id, networks.flatMap((n) => media[n] ?? []))),
    );
    const files = (n: Network) => (media[n] ?? []).map((id) => rows.find((r) => r.id === id)!);
    const urls = (n: Network) => files(n).map((f) => deps.urlFor(f.storagePath));
    // Renders are compared by content: a network whose render is byte for byte the first's is not shown twice.
    const sameAsFirst = (n: Network) => files(n).map((f) => f.sha256).join() === files(network).map((f) => f.sha256).join();
    const slides = urls(network);
    for (const other of networks.slice(1)) {
      const own = urls(other);
      if (sameAsFirst(other)) continue;
      for (const [i, url] of own.entries()) await deps.messaging.sendText(businessId, { to, text: copy.networkRender(other, i + 1, own.length), mediaUrl: url });
    }
    if (slides.length > 1) {
      for (const [i, url] of slides.entries()) await deps.messaging.sendText(businessId, { to, text: copy.carouselSlide(i + 1, slides.length), mediaUrl: url });
    }
    const details = (version.factSources as { type: string; value: string }[]).filter((f) => !['product', 'promotion', 'other', 'testimonial'].includes(f.type)).map((f) => f.value);
    const payload = { postId: post.id, versionHash: version.contentHash };
    await deps.messaging.sendButtons(businessId, {
      to,
      text: copy.draftText(plan.topic, networks.map((n) => ({ network: n, caption: captions[n]! })), details),
      ...(slides[0] ? { mediaUrl: slides[0] } : {}),
      buttons: [
        { id: encodeButtonId({ action: 'approve', ...payload }), title: copy.APPROVE_TITLE },
        { id: encodeButtonId({ action: 'change', ...payload }), title: copy.CHANGE_TITLE },
      ],
    });
  }

  async function fail(businessId: string, post: PostRow, reason: string, consoleItem: boolean) {
    if (consoleItem) {
      await db.withBusiness('workflow', businessId, (tx) =>
        tx.insert(schema.consoleItem).values({ businessId, kind: 'draft_failed', referenceId: post.id, details: { reason } }),
      );
    }
    await postEvent(businessId, post.id, 'DRAFT_FAILED');
    return 'failed' as const;
  }

  /** Drafts one post in `planned` or `drafting`: question, caption with the fact check, render, version, send. */
  async function draftPost(
    business: typeof schema.business.$inferSelect,
    post: PostRow,
    redraft?: { changes: string[]; networks: Network[] },
  ): Promise<Outcome> {
    const businessId = business.id;
    const profile = BusinessProfile.parse(business.profile);
    const plan = post.plan as PlannedPost;
    if (post.status === 'planned' && !(await postEvent(businessId, post.id, 'DRAFT_STARTED')).ok) return 'failed';

    // Several photos for a single post: ask the owner first (state-machines.md, Post).
    if (post.format === 'single' && plan.mediaAssetIds.length > 1) {
      const question: OpenQuestion = { key: 'photo_choice', askedFields: [], attempts: 1, photoAssetIds: [], postId: post.id };
      await postEvent(businessId, post.id, 'DETAIL_MISSING');
      await conversation(businessId, 'QUESTION_ASKED', question);
      await deps.messaging.sendText(businessId, { to: business.approverPhone, text: copy.photoChoiceQuestion(plan.mediaAssetIds.length, plan.topic) });
      return 'asked';
    }

    const facts = (await weekFacts(businessId, post.weeklyUpdateId)).filter((f) => plan.factIds.includes(f.id));
    const rules = await db.withBusiness('content', businessId, (tx) =>
      tx.select({ rule: schema.preferenceRule.rule }).from(schema.preferenceRule).where(eq(schema.preferenceRule.active, true)).orderBy(asc(schema.preferenceRule.createdAt)),
    );
    const networks = redraft?.networks ?? profile.channels;
    let written: ModelTaskOutput<'caption_writing'>;
    try {
      written = await deps.model.run(
        businessId,
        'caption_writing',
        {
          plan,
          facts,
          businessContext: `${profile.name}, ${profile.field}. ${profile.differentiator}. ${profile.location.address}, ${profile.location.city}.`,
          preferenceRules: rules.map((r) => r.rule),
          networks,
          languages: profile.languages,
          tone: profile.tone,
          fixedHashtags: profile.fixedHashtags,
          ...(redraft ? { changes: redraft.changes } : {}),
        },
        { referenceId: post.id, check: (output) => checkCaptions(output, { planFactIds: plan.factIds, facts, profile }) },
      );
    } catch (error) {
      // Every attempt failed the schema or the fact check: nothing is sent, the console item exists.
      if (isModelFailure(error)) return fail(businessId, post, 'caption_writing failed', false);
      throw error;
    }

    let renderedMedia: RenderedMedia;
    try {
      const rendered = await deps.render(
        { businessId, businessName: profile.name, languages: profile.languages },
        {
          style: profile.style,
          format: post.format,
          photoUrls: await photoUrls(businessId, post, plan),
          overlayText: plan.topic,
          ...(profile.brand?.logoAssetId ? { logoUrl: await deps.mediaUrl(businessId, profile.brand.logoAssetId) } : {}),
          brandColors: profile.brand?.colors ?? [],
          networks: Object.keys(written.captions) as Network[],
        },
      );
      const missing = (Object.keys(written.captions) as Network[]).find((n) => !rendered[n]?.length);
      if (missing) throw new Error(`nothing rendered for ${missing}`);
      renderedMedia = await storeRenders(businessId, rendered);
    } catch (error) {
      return fail(businessId, post, `render failed: ${error instanceof Error ? error.message : String(error)}`, true);
    }

    // Any new version invalidates earlier approvals, before it exists (state-machines.md, Approval guard).
    await deps.invalidate(businessId, post.id);
    // The version, immutable from here: its hash ties a button tap to exactly this content. The post
    // row is locked so two redrafts of one post cannot take the same version number.
    const version = await db.withBusiness('content', businessId, async (tx) => {
      await tx.select({ id: schema.post.id }).from(schema.post).where(eq(schema.post.id, post.id)).for('update');
      const [last] = await tx.select({ n: max(schema.postVersion.versionNumber) }).from(schema.postVersion).where(eq(schema.postVersion.postId, post.id));
      const [row] = await tx
        .insert(schema.postVersion)
        .values({
          businessId,
          postId: post.id,
          versionNumber: (last?.n ?? 0) + 1,
          captions: written.captions,
          renderedMedia,
          factSources: factSources(written.usedFactIds, facts),
          factCheckPassed: true,
          contentHash: contentHash({ format: post.format, captions: written.captions, renderedMedia }),
        })
        .returning();
      await tx.update(schema.post).set({ currentVersionId: row!.id, updatedAt: new Date() }).where(eq(schema.post.id, post.id));
      return row!;
    });

    try {
      await sendDraft(businessId, business.approverPhone, post, version);
    } catch (error) {
      // The window closed: the draft is ready and goes out after the owner's next message.
      if (!(error instanceof WindowClosedError) || !deps.messaging.sendTemplate) throw error;
      windowClosed.add(businessId);
    }
    const ready = await postEvent(businessId, post.id, 'DRAFT_READY', async (tx) => {
      const [row] = await tx.select({ current: schema.post.currentVersionId }).from(schema.post).where(eq(schema.post.id, post.id));
      return row?.current === version.id ? null : 'the sent version is not the current version';
    });
    return ready.ok ? 'sent' : 'failed';
  }

  /** After drafting: `DRAFTS_SENT` when at least one draft is open, else a person takes over. */
  async function finish(business: typeof schema.business.$inferSelect) {
    const open = await openDrafts(business.id);
    const waiting = windowClosed.delete(business.id);
    if (open.length > 0 && waiting) {
      const question: OpenQuestion = { key: DRAFTS_WAITING, askedFields: [], attempts: 1, photoAssetIds: [] };
      if (!(await conversation(business.id, 'DRAFTS_SENT', question)).ok) return;
      const profile = BusinessProfile.safeParse(business.profile);
      await deps.messaging.sendTemplate!(business.id, {
        to: business.approverPhone,
        language: profile.success ? profile.data.languages[0]! : 'he',
        templateName: copy.DRAFTS_READY_TEMPLATE,
        variables: { businessName: business.name },
      });
      return;
    }
    if (open.length > 0) return void (await conversation(business.id, 'DRAFTS_SENT'));
    await handOff(business.id, business.approverPhone, 'no draft could be sent', copy.draftsNeedReview);
  }

  const openDrafts = (businessId: string) =>
    db.withBusiness('workflow', businessId, (tx) =>
      tx.select().from(schema.post).where(eq(schema.post.status, 'awaiting_approval')).orderBy(asc(schema.post.weeklyUpdateId), asc(schema.post.position)),
    );

  async function draftWeek(businessId: string, weekId: string) {
    const loaded = await loadBusiness(businessId);
    if (!loaded) return;
    const { business } = loaded;
    const todo = await db.withBusiness('workflow', businessId, (tx) =>
      tx
        .select()
        .from(schema.post)
        .where(and(eq(schema.post.weeklyUpdateId, weekId), inArray(schema.post.status, ['planned', 'drafting'])))
        .orderBy(asc(schema.post.position)),
    );
    for (const post of todo) {
      if ((await draftPost(business, post)) === 'asked') return;
    }
    await finish(business);
  }

  async function answerPhotoChoice(burst: DraftsBurst, question: OpenQuestion) {
    const { businessId } = burst;
    // Photos or a voice note here are a new update, not an answer (technical-design.md, second update).
    if (burst.messages.some((m) => m.content.kind === 'image' || m.content.kind === 'voice')) {
      return void (await deps.messaging.sendText(businessId, { to: burst.from, text: weeklyCopy.stillWorking }));
    }
    // A button tap is not an answer: ask again without using up an attempt (review of PR #43, item 4).
    if (burst.messages.some((m) => m.content.kind === 'button_reply')) {
      return void (await deps.messaging.sendText(businessId, { to: burst.from, text: copy.photoChoiceReask }));
    }
    const choice = parsePhotoChoice(burst.text);
    if (!choice) {
      if (question.attempts >= MAX_QUESTION_ATTEMPTS) return handOff(businessId, burst.from, 'photo choice not understood', copy.handedOff);
      await setQuestion(businessId, { ...question, attempts: question.attempts + 1 });
      return void (await deps.messaging.sendText(businessId, { to: burst.from, text: copy.photoChoiceReask }));
    }
    const post = question.postId ? await loadPost(businessId, question.postId) : undefined;
    if (!post) return handOff(businessId, burst.from, 'photo choice for an unknown post', copy.handedOff);
    if (!(await conversation(businessId, 'ANSWER_RECEIVED', null)).ok) return;
    const plan = post.plan as PlannedPost;
    const [first, ...others] = plan.mediaAssetIds;
    const provided = await postEvent(businessId, post.id, 'DETAIL_PROVIDED', async (tx) => {
      if (choice === 'carousel') {
        await tx.update(schema.post).set({ format: 'carousel', plan: { ...plan, format: 'carousel' } }).where(eq(schema.post.id, post.id));
        return null;
      }
      await tx.update(schema.post).set({ plan: { ...plan, mediaAssetIds: [first!] } }).where(eq(schema.post.id, post.id));
      if (choice === 'per_photo') {
        const [last] = await tx.select({ n: max(schema.post.position) }).from(schema.post).where(eq(schema.post.weeklyUpdateId, post.weeklyUpdateId));
        await tx.insert(schema.post).values(
          others.map((id, i) => ({
            businessId,
            weeklyUpdateId: post.weeklyUpdateId,
            position: (last?.n ?? post.position) + 1 + i,
            format: 'single' as const,
            plan: { ...plan, format: 'single' as const, mediaAssetIds: [id] },
          })),
        );
      }
      return null;
    });
    if (!provided.ok) return;
    await draftWeek(businessId, post.weeklyUpdateId);
  }

  /** Posts a change may target: open drafts and approved or scheduled posts (their approval is invalidated). */
  const changeable = (businessId: string) =>
    db.withBusiness('workflow', businessId, (tx) =>
      tx.select().from(schema.post).where(inArray(schema.post.status, ['awaiting_approval', 'approved', 'scheduled'])),
    );

  async function resendDrafts(businessId: string, to: string, text: string = copy.notAnApproval) {
    await deps.messaging.sendText(businessId, { to, text });
    for (const post of await openDrafts(businessId)) {
      const version = await currentVersion(businessId, post);
      if (version) await sendDraft(businessId, to, post, version);
    }
  }

  /** A change on one open draft: save the rule, apply the events, draft a new version. */
  async function change(burst: DraftsBurst, business: typeof schema.business.$inferSelect, post: PostRow, text: string) {
    const { businessId } = burst;
    const version = await currentVersion(businessId, post);
    if (!version) return;
    const captions = version.captions as ChannelCaptions;
    const interpreted = await deps.model.run(businessId, 'change_interpretation', { text, captions, plan: post.plan as PlannedPost }, { referenceId: post.id });
    const instructions = interpreted.changes.map((c) => c.instruction);
    const rule = interpreted.rule ?? { scope: SCOPE_BY_TARGET[interpreted.changes[0]!.target], text: instructions.join('; ') };
    const source = [...burst.messages].reverse().find((m) => m.content.kind === 'text' || m.content.kind === 'voice');
    const current = Object.keys(captions) as Network[];
    const networks = interpreted.changes.some((c) => c.target === 'channels')
      ? networksFromChange(interpreted.changes.filter((c) => c.target === 'channels').map((c) => c.instruction).concat(text), current)
      : current;
    // A change to an approved or scheduled post invalidates its approval first, so a failure after
    // this leaves a post that cannot publish (technical-design.md, Approval flow).
    const invalidated = post.status === 'approved' || post.status === 'scheduled';
    if (invalidated) await deps.invalidate(businessId, post.id);
    const applied = (await conversation(businessId, 'CHANGE_REQUESTED', null)).ok && (await postEvent(businessId, post.id, 'CHANGE_REQUESTED')).ok;
    if (!applied) {
      // The post keeps its status with no valid approval, so it cannot publish: the team is told.
      if (invalidated) {
        await db.withBusiness('workflow', businessId, (tx) =>
          tx.insert(schema.consoleItem).values({ businessId, kind: 'draft_failed', referenceId: post.id, details: { reason: CHANGE_REFUSED } }),
        );
      }
      return;
    }
    // PRD, Context that updates automatically: every change is saved as a rule, once the change is
    // applied, so a refused change leaves no rule behind (review of PR #43, item 5).
    await db.withBusiness('business_data', businessId, (tx) =>
      tx.insert(schema.preferenceRule).values({ businessId, scope: rule.scope, rule: rule.text, sourceMessageId: source?.id ?? null, sourcePostVersionId: version.id }),
    );
    const drafting = await loadPost(businessId, post.id);
    await draftPost(business, drafting!, { changes: instructions, networks });
    await finish(business);
  }

  async function transcribed(burst: DraftsBurst, language: Language) {
    const parts = burst.text.trim() ? [burst.text.trim()] : [];
    for (const m of burst.messages) {
      if (m.content.kind !== 'voice') continue;
      for (const voiceAssetId of m.mediaAssetIds) {
        const t = await deps.model.run(burst.businessId, 'transcription', { voiceAssetId, languageHint: language });
        if (t.text.trim()) parts.push(t.text.trim());
      }
    }
    return parts.join('\n');
  }

  async function review(burst: DraftsBurst, business: typeof schema.business.$inferSelect, question: OpenQuestion | undefined) {
    const { businessId } = burst;
    // The drafts waited for the window: whatever the owner wrote, they now get the drafts (Failure handling).
    if (question?.key === DRAFTS_WAITING) {
      await setQuestion(businessId, null);
      return resendDrafts(businessId, burst.from, copy.draftsHere);
    }
    const tap = burst.messages.find((m) => m.content.kind === 'button_reply');
    if (tap) {
      const payload = tap.content.payload as { action: string; postId: string };
      // An Approve tap belongs to the approval service (WP-33). A Change tap applies to the current
      // version whatever hash it carries (technical-design.md, Drafts flow).
      if (payload.action !== 'change') return;
      const post = await loadPost(businessId, payload.postId);
      if (!post || !['awaiting_approval', 'approved', 'scheduled'].includes(post.status)) return resendDrafts(businessId, burst.from);
      await setQuestion(businessId, { key: 'change_request', askedFields: [], attempts: 1, photoAssetIds: [], postId: post.id });
      return void (await deps.messaging.sendText(businessId, { to: burst.from, text: copy.askWhatToChange }));
    }
    const profile = BusinessProfile.parse(business.profile);
    const text = await transcribed(burst, profile.languages[0] ?? 'he');
    if (!text) return resendDrafts(businessId, burst.from);
    const { intent } = await deps.model.run(businessId, 'intent_detection', { text, step: 'reviewing_drafts', draftsOpen: true });
    if (intent !== 'change_request' && intent !== 'weekly_update') return resendDrafts(businessId, burst.from);
    const open = await openDrafts(businessId);
    const target =
      question?.key === 'change_request' ? (await changeable(businessId)).find((p) => p.id === question.postId) : open.length === 1 ? open[0] : undefined;
    if (!target) return void (await deps.messaging.sendText(businessId, { to: burst.from, text: copy.whichDraft }));
    await change(burst, business, target, text);
  }

  return {
    async draftWeek(businessId, weekId) {
      try {
        await draftWeek(businessId, weekId);
      } catch (error) {
        // Any other error after the plan: the team gets the week and a person takes over, so the
        // conversation does not wait in processing_update answering every message with stillWorking.
        console.error(JSON.stringify({ level: 'error', msg: 'drafting failed', businessId, weekId, error: String(error) }));
        await db.withBusiness('workflow', businessId, (tx) =>
          tx.insert(schema.consoleItem).values({ businessId, kind: 'draft_failed', referenceId: weekId, details: { error: String(error) } }),
        );
        const loaded = await loadBusiness(businessId);
        if (loaded) await handOff(businessId, loaded.business.approverPhone, 'drafting failed', copy.draftsNeedReview);
      }
    },
    resendOpen: (businessId, to, text) => resendDrafts(businessId, to, text),
    topicOf: async (businessId, postId) => ((await loadPost(businessId, postId))?.plan as PlannedPost | undefined)?.topic,
    async handle(burst) {
      const loaded = await loadBusiness(burst.businessId);
      if (!loaded || loaded.business.status !== 'active') return false;
      const { business, step, question } = loaded;
      const forDrafts = step === 'reviewing_drafts' || (step === 'awaiting_answer' && question?.key === 'photo_choice');
      if (!forDrafts) return false;
      if (burst.from !== business.approverPhone || !(await workflow.mayAutoReply(burst.businessId))) return true;
      try {
        if (step === 'awaiting_answer') await answerPhotoChoice(burst, question!);
        else await review(burst, business, question);
      } catch (error) {
        // A model task that failed every attempt is already a console item; a person takes over.
        if (!isModelFailure(error)) throw error;
        await handOff(burst.businessId, burst.from, (error as Error).message, copy.handedOff);
      }
      return true;
    },
  };
}
