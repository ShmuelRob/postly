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
 * The runtime rebuilds the context before each step and `toolResults` holds every result of the
 * turn so far, so each rule reads what this turn already did from `toolResults` (which tools ran,
 * and the ids they returned) and the rest from the current context. A step has at most four calls;
 * with nothing left to do the agent ends the turn.
 */
export function playgroundAgent(context: AgentContext): AgentStep {
  const calls = context.agent === 'onboarding' ? onboarding(context) : context.agent === 'weekly' ? weekly(context) : drafts(context);
  return { calls: calls.length ? calls.slice(0, 4) : [{ tool: 'end_turn' }], confidence: 0.9 };
}

type Tool = AgentToolCall['tool'];

const ran = (c: AgentContext, tool: Tool) => c.toolResults.some((r) => r.tool === tool);
const okData = (c: AgentContext, tool: Tool) =>
  c.toolResults.flatMap((r) => (r.tool === tool && r.result.status === 'ok' ? [r.result.data] : []));
/** The turn already asked the owner something and now waits: nothing more to do. */
const waiting = (c: AgentContext) => ran(c, 'request_photo') || c.toolResults.some((r) => r.tool === 'ask_owner');

const ownerMessages = (c: AgentContext) => c.messages.filter((m) => m.role === 'owner');
const latestOwner = (c: AgentContext) => ownerMessages(c).at(-1);
const ownerPhotos = (c: AgentContext) => ownerMessages(c).flatMap((m) => m.photos.map((p) => p.assetId));
const ask = (text: string, topic: string, fields?: string[]): AgentToolCall => ({
  tool: 'ask_owner',
  text,
  topic,
  expects: 'answer',
  ...(fields ? { fields } : {}),
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

function onboarding(c: AgentContext): AgentToolCall[] {
  if (waiting(c)) return [];
  if (c.step === 'brand_assets') return brandAssets(c);
  if (c.step !== 'profile_questions') return [];

  const answer = latestOwner(c)?.text.trim() ?? '';
  const asked = c.openQuestion?.askedFields ?? [];
  // The answer is read once per turn: the first step sets the fields, later steps only ask.
  const sets = !ran(c, 'set_profile_field') && answer && asked.length ? profileCalls(answer, asked) : [];
  if (sets.length > 3) return sets;

  // Fields set this turn may not be in a rebuilt context yet; never ask for them again.
  const setNow = new Set(sets.map((s) => (s.tool === 'set_profile_field' ? s.field.split('.')[0] : '')));
  const answered = ran(c, 'set_profile_field') ? new Set(asked) : new Set<string>();
  const missing = c.missingFields.filter((f) => !setNow.has(f) && !answered.has(f));

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
function profileCalls(answer: string, asked: string[]): AgentToolCall[] {
  const found = playgroundExtraction({ text: answer, askedFields: asked }).found as Record<string, unknown>;
  const calls: AgentToolCall[] = [];
  for (const [key, value] of Object.entries(found)) {
    const entries =
      key === 'location' || key === 'schedule'
        ? Object.entries(value as object).map(([k, v]) => [`${key}.${k}`, v] as const)
        : [[key, value] as const];
    for (const [field, v] of entries) {
      if (!profileFieldValueSchema(field as AgentProfileField).safeParse(v).success) continue;
      calls.push({ tool: 'set_profile_field', field: field as AgentProfileField, value: v, sourceQuote: answer });
    }
  }
  return calls;
}

function brandAssets(c: AgentContext): AgentToolCall[] {
  const key = c.openQuestion?.key ?? '';
  const last = latestOwner(c);
  const sentPhoto = (last?.photos.length ?? 0) > 0;
  const quote = last?.text.trim() || 'לא';
  const askBusiness: AgentToolCall = { tool: 'request_photo', purpose: 'business', text: 'אפשר כמה תמונות של העסק והמוצרים?' };
  if (ran(c, 'record_decline')) return [];
  if (/logo/.test(key)) return sentPhoto ? [askBusiness] : [{ tool: 'record_decline', what: 'logo', ownerQuote: quote }, askBusiness];
  if (/business/.test(key)) return sentPhoto ? [] : [{ tool: 'record_decline', what: 'business_photos', ownerQuote: quote }];
  return [{ tool: 'request_photo', purpose: 'logo', text: 'יש לכם לוגו? אפשר לשלוח אותו כתמונה.' }];
}

// Weekly update

function weekly(c: AgentContext): AgentToolCall[] {
  if (c.posts.length > 0 || ran(c, 'plan_posts') || waiting(c)) return [];
  const facts = new Map((c.week?.facts ?? []).map((f) => [f.id, f.value]));
  const source = c.week?.updateText?.trim() || c.week?.transcript?.trim() || latestOwner(c)?.text.trim();

  if (facts.size === 0 && !ran(c, 'record_fact')) {
    // The plan needs the new fact's id, which comes back in the tool result: one call this step.
    return source ? [{ tool: 'record_fact', type: 'other', value: source, sourceQuote: source }] : [];
  }
  for (const data of okData(c, 'record_fact')) {
    if (typeof data.factId === 'string' && !facts.has(data.factId)) facts.set(data.factId, source ?? '');
  }
  const profile = c.profile;
  const planned = playgroundPlanning({
    postsPerWeek: profile.postsPerWeek ?? 3,
    contentTypes: profile.contentTypes ?? ['products', 'promotions'],
    formats: profile.formats ?? ['single'],
    facts: [...facts].map(([id, value]) => ({ id, value })),
    mediaAssetIds: ownerPhotos(c),
  });
  return [{ tool: 'plan_posts', mode: 'initial', posts: planned.posts as never }];
}

// Drafts

const OPEN_FOR_DRAFT = new Set(['planned', 'drafting', 'awaiting_clarification']);
const CHANGEABLE = new Set(['awaiting_approval', 'approved', 'scheduled']);

function drafts(c: AgentContext): AgentToolCall[] {
  if (waiting(c) || ran(c, 'apply_change')) return [];
  const networks = c.profile.channels?.length ? c.profile.channels : [...NETWORKS];
  const hashtags = (c.profile.fixedHashtags ?? []).filter((h) => /^#\S+$/.test(h));
  const photos = ownerPhotos(c);
  // Drafted this turn, even if the rebuilt context still shows the post as open.
  const drafted = new Set(okData(c, 'create_draft').map((d) => d.postId));
  const toDraft = c.posts.filter((p) => OPEN_FOR_DRAFT.has(p.state) && !p.captions && !drafted.has(p.id));

  if (toDraft.length || ran(c, 'create_draft')) {
    const calls: AgentToolCall[] = [];
    for (const post of toDraft) {
      const media = post.plan.mediaAssetIds.length ? post.plan.mediaAssetIds : photos.slice(0, 1);
      if (!media.length) {
        // The photo request waits for the owner, so it is the step's last call.
        calls.push({ tool: 'request_photo', purpose: 'post', postId: post.id, text: `יש תמונה לפוסט "${post.plan.topic}"?` });
        break;
      }
      const caption = { text: post.plan.brief, hashtags };
      calls.push({
        tool: 'create_draft',
        postId: post.id,
        captions: Object.fromEntries(networks.map((n) => [n, caption])),
        usedFactIds: post.plan.factIds,
        design: {
          photos: media.map((assetId) => ({ assetId })),
          title: post.plan.topic.slice(0, 40).trim(),
          ...(media.length > 1 ? { carouselLayout: 'standard' as const } : {}),
        },
      });
      if (calls.length === 4) break;
    }
    return calls;
  }

  const change = latestOwner(c)?.text.trim();
  const target = c.posts.find((p) => CHANGEABLE.has(p.state) && p.captions);
  if (!change || !target?.captions) return [];
  const captions = Object.fromEntries(
    Object.entries(target.captions).map(([network, caption]) => [network, { ...caption, text: `${caption.text}\n${change}` }]),
  );
  return [{ tool: 'apply_change', postId: target.id, ownerQuote: change, captions, rule: { text: change, scope: 'caption' } }];
}
