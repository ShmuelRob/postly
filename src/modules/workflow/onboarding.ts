import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DEFAULT_AGENT_NAME, personaName } from '../../contracts/agent.js';
import { BusinessProfile, BusinessProfileDraft, missingRequiredProfileFields } from '../../contracts/business-profile.js';
import { type Network, VISUAL_STYLES } from '../../contracts/common.js';

type VisualStyle = (typeof VISUAL_STYLES)[number];
import type { ModelTaskInput, ModelTaskName, ModelTaskOutput } from '../../contracts/model-tasks.js';
import { OpenQuestion } from '../../contracts/open-question.js';
import type { SendTextRequest } from '../../contracts/providers/messaging.js';
import type { Database, Tx } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import type { Agent, TurnResult } from '../agent/index.js';
import * as copy from './onboarding-copy.js';
import type { Workflow } from './workflow.js';

// The onboarding flow (PRD, WhatsApp onboarding; state-machines.md, Onboarding; technical-design.md,
// Onboarding flow). Code owns every step; models only transcribe and extract profile fields.

/** One burst from messaging (structurally the messaging module's `InboundBurst`). */
export interface OnboardingBurst {
  businessId: string;
  from: string;
  text: string;
  messages: { content: { kind: string }; mediaAssetIds: string[] }[];
}

export interface OnboardingDeps {
  db: Database;
  workflow: Workflow;
  messaging: { sendText(businessId: string, request: SendTextRequest): Promise<unknown> };
  model: { run<T extends ModelTaskName>(businessId: string, task: T, input: ModelTaskInput<T>): Promise<ModelTaskOutput<T>> };
  /** URL of a business media asset (messaging's `mediaUrl`). */
  mediaUrl(businessId: string, mediaAssetId: string): Promise<string>;
  /** Renders one sample per style (the design module's `renderStyleSamples`), returning image URLs. */
  renderSamples(request: {
    businessId: string;
    businessName: string;
    photoUrl: string;
    logoUrl?: string;
    brandColors: string[];
  }): Promise<{ style: VisualStyle; url: string }[]>;
  /** The publishing module's channels. */
  channels: {
    requestLink(businessId: string, networks: Network[]): Promise<string>;
    checkAndTest(businessId: string): Promise<{ network: Network; status: string }[]>;
  };
  /** The photo used for the style samples when the owner sent none. */
  samplePhotoUrl: string;
  /**
   * Billing's payment link (T1, no trial): sent right after activation. Absent when no payment
   * provider is wired. A failure is logged; the business stays active.
   */
  sendPaymentLink?(businessId: string): Promise<unknown>;
  logger?: { error(message: string, detail?: unknown): void };
  /**
   * The onboarding agent (WP-92, agent.md). When given (always, in every deployed composition), the
   * agent asks the profile questions, gathers the brand assets and applies profile corrections;
   * code still decides when each step is done and runs every other step. Without it the one-shot
   * steps run: only tests compose that (`oneShotFlows`), until A9's cleanup removes them.
   */
  agent?: Pick<Agent, 'runTurn'>;
}

export interface Onboarding {
  /** Creates a business in `onboarding` with its conversation_state row (a team or sign-up action). */
  createBusiness(input: { approverPhone: string; name?: string }): Promise<string>;
  /** Runs the current onboarding step for one inbound burst. */
  handle(burst: OnboardingBurst): Promise<void>;
  /** The agent sent a question or photo request expecting an answer: store it as the open question. */
  agentAsked(businessId: string, question: { key: string; askedFields: string[] }): Promise<void>;
}

/** The profile questions in order, each with the fields it asks for. */
export const PROFILE_QUESTIONS = [
  { key: 'business', fields: ['name', 'field', 'mainProducts'] },
  { key: 'location', fields: ['location'] },
  { key: 'audience', fields: ['targetAudience', 'differentiator'] },
  { key: 'channels', fields: ['channels', 'schedule'] },
] as const satisfies ReadonlyArray<{ key: keyof typeof copy.questions; fields: ReadonlyArray<keyof BusinessProfileDraft> }>;

/** A question asked this many times without its required fields hands the conversation to a person. */
export const MAX_QUESTION_ATTEMPTS = 3;

/** Required fields the profile questions fill: all but style (style selection) and the approver (known). */
const missingFromQuestions = (draft: BusinessProfileDraft) =>
  missingRequiredProfileFields(draft).filter((f) => f !== 'style' && f !== 'approverPhone');

const normalize = (text: string) => text.trim().replace(/[.!,״"']+$/u, '').trim();
const isOneOf = (text: string, words: string[]) => words.includes(normalize(text));

export function parseStyle(text: string): VisualStyle | undefined {
  const t = normalize(text).toLowerCase();
  const byNumber: Record<string, VisualStyle> = { '1': 'clean', '2': 'warm', '3': 'dynamic' };
  if (byNumber[t]) return byNumber[t];
  return VISUAL_STYLES.find((s) => t === s || t.includes(copy.styleNames[s]));
}

/** Merges extracted fields into the draft; nested objects merge one level deep. */
export function mergeDraft(draft: BusinessProfileDraft, found: BusinessProfileDraft): BusinessProfileDraft {
  const merged: Record<string, unknown> = { ...draft };
  for (const [k, v] of Object.entries(found)) {
    if (v === undefined || k === 'approverPhone' || k === 'style') continue;
    const old = merged[k];
    merged[k] = old && typeof old === 'object' && !Array.isArray(old) && typeof v === 'object' && !Array.isArray(v) ? { ...old, ...v } : v;
  }
  return BusinessProfileDraft.parse(merged);
}

export function createOnboarding(deps: OnboardingDeps): Onboarding {
  const { db, workflow } = deps;

  async function load(businessId: string) {
    return db.withBusiness('workflow', businessId, async (tx) => {
      const [business] = await tx.select().from(schema.business).where(eq(schema.business.id, businessId));
      const [state] = await tx.select().from(schema.conversationState).where(eq(schema.conversationState.businessId, businessId));
      if (!business || !state) throw new Error(`Business ${businessId} has no onboarding state`);
      const question = state.openQuestion ? OpenQuestion.parse(state.openQuestion) : null;
      const draft = BusinessProfileDraft.parse(business.profile);
      const [control] = await tx.select({ agentName: schema.systemControl.agentName }).from(schema.systemControl);
      const names = (control?.agentName ?? DEFAULT_AGENT_NAME) as Partial<typeof DEFAULT_AGENT_NAME>;
      const persona = personaName(draft, draft.languages?.[0] ?? 'he', names);
      return { business, step: state.step, question, draft, persona };
    });
  }

  const saveDraft = (businessId: string, draft: BusinessProfileDraft) =>
    db.withBusiness('workflow', businessId, (tx) =>
      tx
        .update(schema.business)
        .set({ profile: draft, ...(draft.name ? { name: draft.name } : {}), ...(draft.style ? { style: draft.style } : {}), updatedAt: new Date() })
        .where(eq(schema.business.id, businessId)),
    );

  const setQuestion = (businessId: string, question: OpenQuestion | null) =>
    db.withBusiness('workflow', businessId, (tx) =>
      tx.update(schema.conversationState).set({ openQuestion: question, updatedAt: new Date() }).where(eq(schema.conversationState.businessId, businessId)),
    );

  const event = (businessId: string, name: string, guard?: (tx: Tx) => Promise<string | null>) =>
    workflow.apply(businessId, { machine: 'onboarding', id: businessId, event: name, source: 'inbound', ...(guard ? { guard } : {}) });

  async function ask(burst: OnboardingBurst, key: string, text: string, previous: OpenQuestion | null, askedFields: readonly string[] = []) {
    const attempts = previous?.key === key ? previous.attempts + 1 : 1;
    await setQuestion(burst.businessId, { key, askedFields: [...askedFields], attempts, photoAssetIds: previous?.photoAssetIds ?? [] });
    await reply(burst, text);
  }

  const reply = (burst: OnboardingBurst, text: string, mediaUrl?: string) =>
    deps.messaging.sendText(burst.businessId, { to: burst.from, text, ...(mediaUrl ? { mediaUrl } : {}) });

  async function handOff(burst: OnboardingBurst, reason: string) {
    await workflow.startHandoff(burst.businessId, { reason, step: 'onboarding' });
    await reply(burst, copy.handoff);
  }

  /** The owner's words: typed text plus the transcript of every voice note in the burst. */
  async function ownerText(burst: OnboardingBurst, draft: BusinessProfileDraft): Promise<string> {
    const parts = burst.text ? [burst.text] : [];
    for (const m of burst.messages) {
      if (m.content.kind !== 'voice') continue;
      for (const voiceAssetId of m.mediaAssetIds) {
        const t = await deps.model.run(burst.businessId, 'transcription', { voiceAssetId, languageHint: draft.languages?.[0] ?? 'he' });
        if (t.text.trim()) parts.push(t.text.trim());
      }
    }
    return parts.join('\n');
  }

  const imagesIn = (burst: OnboardingBurst) => burst.messages.filter((m) => m.content.kind === 'image').flatMap((m) => m.mediaAssetIds);

  async function askNextProfileQuestion(burst: OnboardingBurst, draft: BusinessProfileDraft, previous: OpenQuestion | null) {
    const missing = new Set<string>(missingFromQuestions(draft));
    const next = PROFILE_QUESTIONS.find((q) => q.fields.some((f) => missing.has(f)));
    if (next) {
      const repeat = previous?.key === next.key;
      if (repeat && previous.attempts >= MAX_QUESTION_ATTEMPTS) return handOff(burst, `profile question ${next.key} unanswered`);
      return ask(burst, next.key, repeat ? copy.reask(copy.questions[next.key]) : copy.questions[next.key], previous, next.fields);
    }
    const done = await event(burst.businessId, 'PROFILE_FIELDS_COMPLETE', async (tx) => {
      const [row] = await tx.select({ profile: schema.business.profile }).from(schema.business).where(eq(schema.business.id, burst.businessId));
      const left = missingFromQuestions(BusinessProfileDraft.parse(row?.profile ?? {}));
      return left.length === 0 ? null : `missing profile fields: ${left.join(', ')}`;
    });
    if (done.ok) await ask(burst, 'logo', copy.askLogo, null);
  }

  async function sendSamples(burst: OnboardingBurst, draft: BusinessProfileDraft, question: OpenQuestion | null) {
    const photo = question?.photoAssetIds[0];
    const logo = draft.brand?.logoAssetId;
    const samples = await deps.renderSamples({
      businessId: burst.businessId,
      businessName: draft.name ?? '',
      photoUrl: photo ? await deps.mediaUrl(burst.businessId, photo) : deps.samplePhotoUrl,
      ...(logo ? { logoUrl: await deps.mediaUrl(burst.businessId, logo) } : {}),
      brandColors: draft.brand?.colors ?? [],
    });
    await reply(burst, copy.samplesIntro);
    for (const sample of samples) await reply(burst, copy.sampleCaption[sample.style], sample.url);
    await ask(burst, 'style', copy.chooseStyle, question);
  }

  async function activate(burst: OnboardingBurst): Promise<boolean> {
    const result = await workflow.apply(burst.businessId, {
      machine: 'business',
      id: burst.businessId,
      event: 'ONBOARDING_COMPLETED',
      source: 'system',
      guard: async (tx) => {
        const verified = await tx.select().from(schema.channelConnection).where(eq(schema.channelConnection.status, 'verified'));
        if (verified.length === 0) return 'no verified channel';
        const [row] = await tx.select().from(schema.business).where(eq(schema.business.id, burst.businessId));
        const profile = BusinessProfile.safeParse({ ...(row?.profile as object), approverPhone: row?.approverPhone });
        if (!profile.success) return `profile incomplete: ${profile.error.issues.map((i) => i.path.join('.')).join(', ')}`;
        // state-machines.md, Onboarding: the full profile with defaults, and the conversation starts idle.
        await tx.update(schema.business).set({ profile: profile.data, style: profile.data.style, updatedAt: new Date() }).where(eq(schema.business.id, burst.businessId));
        await tx
          .update(schema.conversationState)
          .set({ step: 'idle', openQuestion: null, updatedAt: new Date() })
          .where(eq(schema.conversationState.businessId, burst.businessId));
        return null;
      },
    });
    return result.ok;
  }

  /** channel_connection: the owner says the link flow is done; ask the provider, then run the test. */
  async function handleChannels(burst: OnboardingBurst, draft: BusinessProfileDraft) {
    const chosen = draft.channels ?? [];
    const statuses = await deps.channels.checkAndTest(burst.businessId);
    const verified = statuses.filter((s) => s.status === 'verified').map((s) => s.network);
    if (verified.length === 0) return reply(burst, copy.notConnected(await deps.channels.requestLink(burst.businessId, chosen)));

    const connected = await event(burst.businessId, 'CHANNEL_CONNECTED', async (tx) => {
      const rows = await tx.select().from(schema.channelConnection);
      return rows.some((r) => r.status === 'connected' || r.status === 'verified') ? null : 'no connected channel';
    });
    if (!connected.ok) return;
    return finishTest(burst, chosen, verified);
  }

  /**
   * channel_test: every chosen channel must be verified (state-machines.md, Onboarding). Also the
   * resume point when a burst finds the onboarding stopped in channel_test after a restart.
   */
  async function finishTest(burst: OnboardingBurst, chosen: Network[], verified: Network[]) {
    const missing = chosen.filter((n) => !verified.includes(n));
    if (missing.length > 0) {
      await event(burst.businessId, 'CHANNEL_TEST_FAILED');
      const link = await deps.channels.requestLink(burst.businessId, missing);
      return reply(burst, verified.length > 0 ? copy.partlyConnected(missing, link) : copy.notConnected(link));
    }
    const passed = await event(burst.businessId, 'CHANNEL_TEST_PASSED', async (tx) => {
      const rows = await tx.select().from(schema.channelConnection);
      return chosen.every((n) => rows.some((r) => r.network === n && r.status === 'verified')) ? null : 'a chosen channel is not verified';
    });
    if (!passed.ok) return handOff(burst, 'channel test could not pass');
    return finishActivation(burst);
  }

  /** completed: activate the business; also the resume point after a stop before activation. */
  async function finishActivation(burst: OnboardingBurst) {
    if (await activate(burst)) {
      await reply(burst, copy.activated);
      if (deps.sendPaymentLink) {
        try {
          await deps.sendPaymentLink(burst.businessId);
        } catch (error) {
          (deps.logger ?? console).error('payment link not sent after activation', { businessId: burst.businessId, error: String(error) });
          await deps.db.withBusiness('workflow', burst.businessId, (tx) =>
            tx.insert(schema.consoleItem).values({ businessId: burst.businessId, kind: 'payment_link_failed', details: { error: String(error) } }),
          );
        }
      }
      return;
    }
    return handOff(burst, 'activation guard failed after the channel test');
  }

  // The agent path (WP-92, agent.md, How it fits the state machines).

  const burstTrigger = (burst: OnboardingBurst) => ({ kind: 'burst' as const, messageIds: (burst.messages as { id?: string }[]).flatMap((m) => (m.id ? [m.id] : [])) });
  const eventTrigger = (name: string) => ({ kind: 'event' as const, name });
  /** The owner waits on these turns; a turn that says nothing and is not done hands off (agent.md, No silent turn). */
  const MUST_REPLY = { mustReply: true } as const;

  /** profile_questions with the agent: once the agent is done, code applies PROFILE_FIELDS_COMPLETE and the agent asks for the logo. */
  async function afterProfileTurn(burst: OnboardingBurst, result: TurnResult) {
    if (result.stopReason !== 'done') return;
    const done = await event(burst.businessId, 'PROFILE_FIELDS_COMPLETE', async (tx) => {
      const [row] = await tx.select({ profile: schema.business.profile }).from(schema.business).where(eq(schema.business.id, burst.businessId));
      const left = missingFromQuestions(BusinessProfileDraft.parse(row?.profile ?? {}));
      return left.length === 0 ? null : `missing profile fields: ${left.join(', ')}`;
    });
    if (!done.ok) return;
    await setQuestion(burst.businessId, null);
    return afterBrandTurn(burst, await deps.agent!.runTurn(burst.businessId, 'onboarding', eventTrigger('brand_assets'), MUST_REPLY));
  }

  /** brand_assets with the agent: once the agent is done, code applies BRAND_ASSETS_DONE and sends the style samples. */
  async function afterBrandTurn(burst: OnboardingBurst, result: TurnResult) {
    if (result.stopReason !== 'done') return;
    const done = await event(burst.businessId, 'BRAND_ASSETS_DONE');
    if (!done.ok) return;
    const { draft, question } = await load(burst.businessId);
    return sendSamples(burst, draft, question);
  }

  /** brand_assets: an image answers the open photo request; code sets the logo (agent.md, request_photo). */
  async function storeAssetAnswer(burst: OnboardingBurst, draft: BusinessProfileDraft, question: OpenQuestion | null) {
    const images = imagesIn(burst);
    if (images.length === 0) return;
    let photos = images;
    if (question?.key === 'photo_request:logo' && !draft.brand?.logoAssetId) {
      const [logo, ...rest] = images;
      photos = rest;
      await saveDraft(burst.businessId, BusinessProfileDraft.parse({ ...draft, brand: { colors: draft.brand?.colors ?? [], logoAssetId: logo } }));
    }
    if (photos.length > 0) {
      await setQuestion(burst.businessId, {
        key: question?.key ?? 'photo_request:business',
        askedFields: [],
        attempts: question?.attempts ?? 1,
        photoAssetIds: [...(question?.photoAssetIds ?? []), ...photos],
      });
    }
  }

  async function agentStep(burst: OnboardingBurst, step: string, draft: BusinessProfileDraft, question: OpenQuestion | null): Promise<boolean> {
    const agent = deps.agent;
    if (!agent) return false;
    const { businessId } = burst;
    switch (step) {
      case 'profile_questions':
        await afterProfileTurn(burst, await agent.runTurn(businessId, 'onboarding', burstTrigger(burst), MUST_REPLY));
        return true;
      case 'brand_assets':
        await storeAssetAnswer(burst, draft, question);
        await afterBrandTurn(burst, await agent.runTurn(businessId, 'onboarding', burstTrigger(burst), MUST_REPLY));
        return true;
      case 'profile_review': {
        if (isOneOf(await ownerText(burst, draft), copy.APPROVAL_WORDS)) return false;
        const result = await agent.runTurn(businessId, 'onboarding', burstTrigger(burst));
        if (result.stopReason === 'done') {
          await event(businessId, 'PROFILE_CORRECTED');
          await reply(burst, copy.summary((await load(businessId)).draft));
        } else if (result.stopReason === 'end_turn') {
          await reply(burst, copy.correctionUnclear);
        }
        return true;
      }
      default:
        return false;
    }
  }

  async function step(burst: OnboardingBurst) {
    const { business, step, question, draft, persona } = await load(burst.businessId);
    if (business.status !== 'onboarding') return;
    const { businessId } = burst;
    if (step !== 'intro' && (await agentStep(burst, step, draft, question))) return;

    switch (step) {
      case 'intro': {
        const sent = await event(businessId, 'INTRO_SENT');
        if (!sent.ok) return;
        await reply(burst, copy.intro(persona));
        if (deps.agent) {
          return afterProfileTurn(burst, await deps.agent.runTurn(businessId, 'onboarding', eventTrigger('intro_sent'), MUST_REPLY));
        }
        return askNextProfileQuestion(burst, draft, null);
      }

      case 'profile_questions': {
        const text = await ownerText(burst, draft);
        let next = draft;
        if (text && question) {
          const extracted = await deps.model.run(businessId, 'profile_extraction', { text, draft, askedFields: question.askedFields.length ? question.askedFields : ['name'] });
          next = mergeDraft(draft, extracted.found);
          await saveDraft(businessId, next);
        }
        return askNextProfileQuestion(burst, next, question);
      }

      case 'brand_assets': {
        const images = imagesIn(burst);
        if (question?.key === 'logo') {
          const [logo, ...photos] = images;
          if (logo) {
            await saveDraft(businessId, BusinessProfileDraft.parse({ ...draft, brand: { colors: draft.brand?.colors ?? [], logoAssetId: logo } }));
            await reply(burst, copy.logoSaved);
          }
          return ask(burst, 'photos', copy.askPhotos, { ...question, photoAssetIds: [...question.photoAssetIds, ...photos] });
        }
        if (images.length > 0) {
          const photoAssetIds = [...(question?.photoAssetIds ?? []), ...images];
          await setQuestion(businessId, { key: 'photos', askedFields: [], attempts: 1, photoAssetIds });
          return reply(burst, copy.photosReceived(photoAssetIds.length));
        }
        const done = await event(businessId, 'BRAND_ASSETS_DONE');
        if (!done.ok) return;
        return sendSamples(burst, (await load(businessId)).draft, question);
      }

      case 'style_selection': {
        const style = parseStyle(await ownerText(burst, draft));
        if (!style) return reply(burst, copy.styleUnclear);
        const next = BusinessProfileDraft.parse({ ...draft, style });
        const chosen = await event(businessId, 'STYLE_CHOSEN', async (tx) => {
          await tx.update(schema.business).set({ profile: next, style, updatedAt: new Date() }).where(eq(schema.business.id, businessId));
          return null;
        });
        if (!chosen.ok) return;
        await setQuestion(businessId, { key: 'review', askedFields: [], attempts: 1, photoAssetIds: question?.photoAssetIds ?? [] });
        return reply(burst, copy.summary(next));
      }

      case 'profile_review': {
        const text = await ownerText(burst, draft);
        if (isOneOf(text, copy.APPROVAL_WORDS)) {
          const approved = await event(businessId, 'PROFILE_APPROVED', async () =>
            burst.from === business.approverPhone ? null : 'not the approver number',
          );
          if (!approved.ok) return;
          await setQuestion(businessId, { key: 'connect', askedFields: [], attempts: 1, photoAssetIds: question?.photoAssetIds ?? [] });
          return reply(burst, copy.connect(await deps.channels.requestLink(businessId, draft.channels ?? [])));
        }
        if (!text) return reply(burst, copy.correctionUnclear);
        const askedFields = PROFILE_QUESTIONS.flatMap((q) => q.fields);
        const extracted = await deps.model.run(businessId, 'profile_extraction', { text, draft, askedFields });
        if (Object.keys(extracted.found).length === 0) return reply(burst, copy.correctionUnclear);
        const next = mergeDraft(draft, extracted.found);
        await saveDraft(businessId, next);
        await event(businessId, 'PROFILE_CORRECTED');
        return reply(burst, copy.summary(next));
      }

      case 'channel_connection':
        return handleChannels(burst, draft);

      case 'channel_test': {
        // A stop between CHANNEL_CONNECTED and CHANNEL_TEST_PASSED: run the test again.
        const statuses = await deps.channels.checkAndTest(businessId);
        const verified = statuses.filter((s) => s.status === 'verified').map((s) => s.network);
        return finishTest(burst, draft.channels ?? [], verified);
      }

      case 'completed':
        // A stop between CHANNEL_TEST_PASSED and ONBOARDING_COMPLETED: activate now.
        return finishActivation(burst);

      default:
        return;
    }
  }

  return {
    async createBusiness({ approverPhone, name }) {
      const id = randomUUID();
      // Review queue item 15: the conversation_state row is created with the business, so handoff works.
      await db.withBusiness('workflow', id, async (tx) => {
        await tx.insert(schema.business).values({ id, name: name ?? '', approverPhone, profile: { approverPhone, ...(name ? { name } : {}) } });
        await tx.insert(schema.conversationState).values({ businessId: id, step: 'intro' });
      });
      return id;
    },

    async agentAsked(businessId, { key, askedFields }) {
      const { question } = await load(businessId);
      await setQuestion(businessId, {
        key,
        askedFields,
        attempts: question?.key === key ? question.attempts + 1 : 1,
        photoAssetIds: question?.photoAssetIds ?? [],
      });
    },

    async handle(burst) {
      if (!(await workflow.mayAutoReply(burst.businessId))) return;
      try {
        await step(burst);
      } catch (error) {
        // A model task that failed every attempt is already a console item; a person takes over.
        if (error instanceof Error && error.name === 'ModelTaskFailedError') return handOff(burst, error.message);
        throw error;
      }
    },
  };
}
