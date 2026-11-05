import {
  type AgentContext,
  type AgentProfileField,
  type AgentStep,
  type AgentToolCall,
  profileFieldValueSchema,
} from '../../contracts/agent.js';
import { NETWORKS } from '../../contracts/common.js';
import { playgroundExtraction } from './extraction.js';
import { playgroundPlanning } from './weekly.js';

/**
 * A rule agent for the model simulator, so the human can play the agent flows in the local
 * playground and the dev sandbox without a model (agent.md, Testing without paying for a model).
 * Not product logic: simple word rules, a pure function of the AgentContext.
 *
 * Each turn is one fixed list of calls worked out from the context. The runtime keeps the context
 * fixed within a turn and appends tool results, so the calls already run are the first
 * `toolResults.length` of the list; a step serves the next ones, at most four, and stops after a
 * call whose result a later call needs. When the list is done the agent ends the turn.
 */
export function playgroundAgent(context: AgentContext): AgentStep {
  const plan = context.agent === 'onboarding' ? onboarding(context) : context.agent === 'weekly' ? weekly(context) : drafts(context);
  const calls: AgentToolCall[] = [];
  for (const planned of plan.slice(context.toolResults.length)) {
    calls.push(planned.call);
    if (planned.barrier || calls.length === 4) break;
  }
  return { calls: calls.length ? calls : [{ tool: 'end_turn' }], confidence: 0.9 };
}

/** A planned call; `barrier` ends the step after it (a later call needs its result, or it waits for the owner). */
type Planned = { call: AgentToolCall; barrier?: boolean };

const ownerMessages = (c: AgentContext) => c.messages.filter((m) => m.role === 'owner');
const latestOwner = (c: AgentContext) => ownerMessages(c).at(-1);
const ownerPhotos = (c: AgentContext) => ownerMessages(c).flatMap((m) => m.photos.map((p) => p.assetId));
const ask = (text: string, topic: string, fields?: string[]): Planned => ({
  call: { tool: 'ask_owner', text, topic, expects: 'answer', ...(fields ? { fields } : {}) },
  barrier: true,
});

// Onboarding

/** The fixed order of the profile questions, one group per question (technical-design.md, Onboarding flow). */
const GROUPS: { fields: string[]; question: string }[] = [
  { fields: ['name', 'field', 'mainProducts'], question: 'איך קוראים לעסק, במה הוא עוסק ומה המוצרים העיקריים?' },
  { fields: ['location'], question: 'איפה העסק נמצא, מה שעות הפתיחה, ויש איסוף או משלוחים?' },
  { fields: ['targetAudience', 'differentiator'], question: 'מי הלקוחות שלכם, ומה מייחד אתכם?' },
  { fields: ['channels'], question: 'באילו רשתות לפרסם: אינסטגרם, פייסבוק או שתיהן?' },
];
const ANYTHING_ELSE = 'יש עוד משהו שחשוב שלקוחות ידעו?';

function onboarding(c: AgentContext): Planned[] {
  if (c.step === 'brand_assets') return brandAssets(c);
  if (c.step !== 'profile_questions') return [];

  const answer = latestOwner(c)?.text.trim() ?? '';
  const asked = c.openQuestion?.askedFields ?? [];
  const sets = answer && asked.length ? profileCalls(answer, asked) : [];
  const setTop = new Set(sets.map((s) => (s.call.tool === 'set_profile_field' ? s.call.field.split('.')[0] : '')));
  const missing = c.missingFields.filter((f) => !setTop.has(f));

  const next = GROUPS.find((g) => g.fields.some((f) => missing.includes(f)));
  if (next) {
    const fields = next.fields.filter((f) => missing.includes(f) || f === 'targetAudience');
    const topic = fields.find((f) => missing.includes(f)) ?? fields[0];
    return [...sets, ask(next.question, `profile:${topic}`, fields)];
  }
  if (c.openQuestion?.key !== 'anything_else') return [...sets, ask(ANYTHING_ELSE, 'anything_else')];
  return sets;
}

/** The playground extraction's fields as set_profile_field calls quoting the owner's whole answer. */
function profileCalls(answer: string, asked: string[]): Planned[] {
  const found = playgroundExtraction({ text: answer, askedFields: asked }).found as Record<string, unknown>;
  const calls: Planned[] = [];
  for (const [key, value] of Object.entries(found)) {
    const entries = key === 'location' || key === 'schedule' ? Object.entries(value as object).map(([k, v]) => [`${key}.${k}`, v] as const) : [[key, value] as const];
    for (const [field, v] of entries) {
      if (!profileFieldValueSchema(field as AgentProfileField).safeParse(v).success) continue;
      calls.push({ call: { tool: 'set_profile_field', field: field as AgentProfileField, value: v, sourceQuote: answer } });
    }
  }
  return calls;
}

function brandAssets(c: AgentContext): Planned[] {
  const key = c.openQuestion?.key ?? '';
  const last = latestOwner(c);
  const sentPhoto = (last?.photos.length ?? 0) > 0;
  const quote = last?.text.trim() || 'לא';
  const askBusiness: Planned = {
    call: { tool: 'request_photo', purpose: 'business', text: 'אפשר כמה תמונות של העסק והמוצרים?' },
    barrier: true,
  };
  if (/logo/.test(key)) {
    return sentPhoto ? [askBusiness] : [{ call: { tool: 'record_decline', what: 'logo', ownerQuote: quote } }, askBusiness];
  }
  if (/business/.test(key)) return sentPhoto ? [] : [{ call: { tool: 'record_decline', what: 'business_photos', ownerQuote: quote } }];
  return [{ call: { tool: 'request_photo', purpose: 'logo', text: 'יש לכם לוגו? אפשר לשלוח אותו כתמונה.' }, barrier: true }];
}

// Weekly update

function weekly(c: AgentContext): Planned[] {
  if (c.posts.length > 0) return [];
  const plan: Planned[] = [];
  const facts = (c.week?.facts ?? []).map((f) => ({ id: f.id, value: f.value }));
  if (facts.length === 0) {
    const source = c.week?.updateText?.trim() || c.week?.transcript?.trim() || latestOwner(c)?.text.trim();
    if (!source) return [];
    plan.push({ call: { tool: 'record_fact', type: 'other', value: source, sourceQuote: source }, barrier: true });
    // The new fact's id comes back in the tool result (data.factId).
    const recorded = c.toolResults.find((r) => r.tool === 'record_fact' && r.result.status === 'ok');
    const id = recorded?.result.status === 'ok' ? recorded.result.data.factId : undefined;
    if (typeof id === 'string') facts.push({ id, value: source });
  }
  const profile = c.profile;
  const planned = playgroundPlanning({
    postsPerWeek: profile.postsPerWeek ?? 3,
    contentTypes: profile.contentTypes ?? ['products', 'promotions'],
    formats: profile.formats ?? ['single'],
    facts,
    mediaAssetIds: ownerPhotos(c),
  });
  plan.push({ call: { tool: 'plan_posts', mode: 'initial', posts: planned.posts as never } });
  return plan;
}

// Drafts

const OPEN_FOR_DRAFT = new Set(['planned', 'drafting', 'awaiting_clarification']);
const CHANGEABLE = new Set(['awaiting_approval', 'approved', 'scheduled']);

function drafts(c: AgentContext): Planned[] {
  const networks = c.profile.channels?.length ? c.profile.channels : [...NETWORKS];
  const hashtags = (c.profile.fixedHashtags ?? []).filter((h) => /^#\S+$/.test(h));
  const photos = ownerPhotos(c);
  const toDraft = c.posts.filter((p) => OPEN_FOR_DRAFT.has(p.state) && !p.captions);

  if (toDraft.length) {
    return toDraft.map((post): Planned => {
      const media = post.plan.mediaAssetIds.length ? post.plan.mediaAssetIds : photos.slice(0, 1);
      if (!media.length) {
        return { call: { tool: 'request_photo', purpose: 'post', postId: post.id, text: `יש תמונה לפוסט "${post.plan.topic}"?` }, barrier: true };
      }
      const caption = { text: post.plan.brief, hashtags };
      return {
        call: {
          tool: 'create_draft',
          postId: post.id,
          captions: Object.fromEntries(networks.map((n) => [n, caption])),
          usedFactIds: post.plan.factIds,
          design: {
            photos: media.map((assetId) => ({ assetId })),
            title: post.plan.topic.slice(0, 40).trim(),
            ...(media.length > 1 ? { carouselLayout: 'standard' as const } : {}),
          },
        },
      };
    });
  }

  const change = latestOwner(c)?.text.trim();
  const target = c.posts.find((p) => CHANGEABLE.has(p.state) && p.captions);
  if (!change || !target?.captions) return [];
  const captions = Object.fromEntries(
    Object.entries(target.captions).map(([network, caption]) => [network, { ...caption, text: `${caption.text}\n${change}` }]),
  );
  return [
    {
      call: {
        tool: 'apply_change',
        postId: target.id,
        ownerQuote: change,
        captions,
        rule: { text: change, scope: 'caption' },
      },
    },
  ];
}
