import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AGENT_NAMES,
  AGENT_PERSONA_GENDER,
  AGENT_TOOL_NAMES,
  AGENT_TOOL_REFUSAL_REASONS,
  AGENT_TURN_STOP_REASONS,
  AgentContext,
  AgentStep,
  AgentToolCall,
  AgentToolResult,
  DEFAULT_AGENT_NAME,
  HAND_OFF_REASONS,
  personaName,
} from './agent.js';

const uuid = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const call = (c: unknown) => AgentToolCall.safeParse(c).success;

// The lists below are copied from contracts.md (Agent) and agent.md (Tools); a doc change and its
// test change go together.
describe('agent contract lists', () => {
  it('has the agents, tools, refusal reasons and stop reasons in the docs', () => {
    expect([...AGENT_NAMES]).toEqual(['onboarding', 'weekly', 'drafts']);
    expect([...AGENT_TOOL_NAMES]).toEqual([
      'ask_owner',
      'set_profile_field',
      'record_fact',
      'request_photo',
      'record_decline',
      'plan_posts',
      'create_draft',
      'apply_change',
      'hand_off_to_console',
      'end_turn',
    ]);
    expect([...AGENT_TOOL_REFUSAL_REASONS]).toEqual([
      'not_allowed',
      'unknown_id',
      'invalid_input',
      'quote_not_found',
      'value_not_in_quote',
      'fact_mismatch',
      'forbidden_content',
      'plan_invalid',
      'badge_invalid',
      'edit_out_of_range',
      'render_failed',
      'no_change',
      'window_closed',
      'question_limit',
      'photo_request_limit',
    ]);
    expect([...AGENT_TURN_STOP_REASONS]).toEqual([
      'done',
      'waiting_for_owner',
      'end_turn',
      'handed_off',
      'max_steps',
      'max_tool_calls',
      'turn_budget',
      'daily_budget',
      'global_budget',
      'timeout',
      'stuck',
      'low_confidence',
      'refusals',
      'invalid_output',
    ]);
    expect([...HAND_OFF_REASONS]).toEqual([
      'owner_asked_for_person',
      'unclear',
      'out_of_scope',
      'sensitive',
      'repeated_failure',
    ]);
  });

  it('names no approval tool, and no tool or reason mentions approval', () => {
    for (const name of [...AGENT_TOOL_NAMES, ...AGENT_TOOL_REFUSAL_REASONS]) expect(name).not.toMatch(/approv|publish|schedul/);
  });
});

describe('persona (agent.md, A1 and A2)', () => {
  it('is Postly, or פוסטלי in Hebrew, and feminine', () => {
    expect(DEFAULT_AGENT_NAME).toEqual({ he: 'פוסטלי', en: 'Postly', ar: 'Postly', ru: 'Postly' });
    expect(AGENT_PERSONA_GENDER).toBe('feminine');
  });

  it('uses the business override before the global name', () => {
    expect(personaName({}, 'he')).toBe('פוסטלי');
    expect(personaName({ persona: {} }, 'en')).toBe('Postly');
    expect(personaName({ persona: { agentName: 'רוני' } }, 'he')).toBe('רוני');
  });
});

describe('AgentStep', () => {
  const step = (calls: unknown[], confidence = 0.9) => AgentStep.safeParse({ calls, confidence });

  it('takes 1 to 4 tool calls and a confidence of 0 to 1', () => {
    expect(step([{ tool: 'end_turn' }]).success).toBe(true);
    expect(step([]).success).toBe(false);
    expect(step(Array(4).fill({ tool: 'end_turn' })).success).toBe(true);
    expect(step(Array(5).fill({ tool: 'end_turn' })).success).toBe(false);
    expect(step([{ tool: 'end_turn' }], 1.1).success).toBe(false);
  });

  it('rejects an unknown tool, such as an approval', () => {
    expect(step([{ tool: 'approve_post', postId: uuid }]).success).toBe(false);
  });

  it('converts to a JSON schema without oneOf, for the model layer', () => {
    expect(JSON.stringify(z.toJSONSchema(AgentStep))).not.toContain('oneOf');
    // A field the model fills has a real type: no bare `{}` ("any") schema anywhere in a step.
    expect(JSON.stringify(z.toJSONSchema(AgentStep))).not.toMatch(/"value":\{\}/);
  });
});

describe('tool calls (agent.md, Tools)', () => {
  it('ask_owner: 1 to 600 characters, a topic, and what it expects', () => {
    const ask = { tool: 'ask_owner', text: 'עד מתי המבצע?', topic: 'detail:date', expects: 'answer' };
    expect(call(ask)).toBe(true);
    expect(call({ ...ask, fields: ['location'] })).toBe(true);
    expect(call({ ...ask, text: '' })).toBe(false);
    expect(call({ ...ask, text: 'א'.repeat(601) })).toBe(false);
    expect(call({ ...ask, expects: 'approval' })).toBe(false);
    expect(call({ ...ask, topic: 'whatever' })).toBe(false);
    for (const topic of ['profile:name', 'detail:price', 'photo_choice', 'clarify_change', 'anything_else', 'info'])
      expect(call({ ...ask, topic }), topic).toBe(true);
  });

  it('set_profile_field: an allowed field, never the approver or the style', () => {
    const set = { tool: 'set_profile_field', field: 'name', value: 'פרחי דנה', sourceQuote: 'פרחי דנה' };
    expect(call(set)).toBe(true);
    expect(call({ ...set, field: 'approverPhone', value: '+972501234567' })).toBe(false);
    expect(call({ ...set, field: 'style', value: 'warm' })).toBe(false);
    expect(call({ ...set, field: 'brand.logoAssetId', value: uuid })).toBe(false);
    expect(call({ ...set, field: 'persona', value: { agentName: 'רוני' } })).toBe(false);
    expect(call({ ...set, field: 'persona.agentName', value: 'רוני' })).toBe(false);
  });

  it('set_profile_field: a quote is required for factual fields', () => {
    expect(call({ tool: 'set_profile_field', field: 'location.hours', value: 'א-ה 9-19' })).toBe(false);
    expect(call({ tool: 'set_profile_field', field: 'tone.emoji', value: false })).toBe(true);
  });

  it('record_fact: a fact type and a verbatim source quote', () => {
    const fact = { tool: 'record_fact', type: 'discount_percent', value: '15', sourceQuote: '15% הנחה' };
    expect(call(fact)).toBe(true);
    expect(call({ ...fact, replaces: 'f1' })).toBe(true);
    expect(call({ ...fact, sourceQuote: '' })).toBe(false);
    expect(call({ ...fact, type: 'rumor' })).toBe(false);
  });

  it('request_photo: a post photo names its post', () => {
    const req = { tool: 'request_photo', purpose: 'logo', text: 'יש לך לוגו?' };
    expect(call(req)).toBe(true);
    expect(call({ ...req, purpose: 'post' })).toBe(false);
    expect(call({ ...req, purpose: 'post', postId: uuid })).toBe(true);
    // week: the weekly update asks for a photo before any post exists (WP-93).
    expect(call({ ...req, purpose: 'week' })).toBe(true);
    expect(call({ ...req, purpose: 'week', postId: uuid })).toBe(false);
  });

  it('record_decline: what was declined, and the owner quote', () => {
    const decline = { tool: 'record_decline', what: 'logo', ownerQuote: 'אין לנו לוגו' };
    expect(call(decline)).toBe(true);
    expect(call({ ...decline, what: 'detail:date' })).toBe(true);
    expect(call({ ...decline, what: 'post_photo' })).toBe(false);
    expect(call({ ...decline, what: 'post_photo', postId: uuid })).toBe(true);
    expect(call({ ...decline, ownerQuote: '' })).toBe(false);
  });

  it('plan_posts: revise names each post; initial does not', () => {
    const post = {
      topic: 'מבצע תמרים',
      contentType: 'promotions',
      format: 'single',
      factIds: ['f1'],
      mediaAssetIds: [uuid],
      brief: 'פוסט על המבצע',
    };
    expect(call({ tool: 'plan_posts', mode: 'initial', posts: [post] })).toBe(true);
    expect(call({ tool: 'plan_posts', mode: 'initial', posts: [{ ...post, postId: uuid }] })).toBe(false);
    expect(call({ tool: 'plan_posts', mode: 'revise', posts: [post] })).toBe(false);
    expect(call({ tool: 'plan_posts', mode: 'revise', posts: [{ ...post, postId: uuid }], ownerQuote: 'קרוסלה' })).toBe(true);
    expect(call({ tool: 'plan_posts', mode: 'initial', posts: [] })).toBe(false);
    expect(call({ tool: 'plan_posts', mode: 'initial', posts: Array(8).fill(post) })).toBe(false);
  });

  const design = { photos: [{ assetId: uuid, rotateDeg: 1.5 }], title: 'מבצע תמרים', badge: { kind: 'discount', text: '-15%', factId: 'f1' } };
  const captions = { instagram: { text: 'מבצע!', hashtags: ['#תמרים'] } };

  it('create_draft: captions, used facts and a design', () => {
    const draft = { tool: 'create_draft', postId: uuid, captions, usedFactIds: ['f1'], design };
    expect(call(draft)).toBe(true);
    expect(call({ ...draft, captions: {} })).toBe(false);
    expect(call({ ...draft, design: { ...design, photos: [{ assetId: uuid, rotateDeg: 45 }] } })).toBe(false);
  });

  it('apply_change: an owner quote and at least one change', () => {
    const change = { tool: 'apply_change', postId: uuid, ownerQuote: 'מושלם, רק תוסיף את השעות' };
    expect(call({ ...change, captions })).toBe(true);
    expect(call({ ...change, design })).toBe(true);
    expect(call({ ...change, networks: ['instagram'] })).toBe(true);
    expect(call({ ...change, captions, rule: { text: 'בלי סימני קריאה', scope: 'caption' } })).toBe(true);
    expect(call(change)).toBe(false);
    expect(call({ ...change, rule: { text: 'בלי סימני קריאה', scope: 'caption' } })).toBe(false);
    expect(call({ ...change, networks: [] })).toBe(false);
  });

  it('hand_off_to_console: a reason and a note of up to 300 characters', () => {
    expect(call({ tool: 'hand_off_to_console', reason: 'unclear', note: 'לא ברור מה המבצע' })).toBe(true);
    expect(call({ tool: 'hand_off_to_console', reason: 'unclear', note: 'א'.repeat(301) })).toBe(false);
    expect(call({ tool: 'hand_off_to_console', reason: 'bored', note: 'x' })).toBe(false);
  });

  it('end_turn: no fields', () => {
    expect(call({ tool: 'end_turn' })).toBe(true);
  });
});

describe('AgentToolResult', () => {
  it('is ok with data, or refused with a known reason and a detail', () => {
    expect(AgentToolResult.safeParse({ status: 'ok', data: { factId: 'f2' } }).success).toBe(true);
    expect(AgentToolResult.safeParse({ status: 'refused', reason: 'quote_not_found', detail: 'not in the message' }).success).toBe(true);
    expect(AgentToolResult.safeParse({ status: 'refused', reason: 'nope', detail: 'x' }).success).toBe(false);
  });
});

describe('AgentContext', () => {
  const context = {
    agent: 'weekly',
    persona: { name: 'פוסטלי', gender: 'feminine' },
    languages: ['he'],
    tone: { register: 'warm', address: 'plural', emoji: true },
    profile: { name: 'פרחי דנה' },
    missingFields: [],
    messages: [{ role: 'owner', text: 'השבוע 15% הנחה על ורדים', at: '2026-11-05T10:00:00+02:00', photos: [] }],
    step: 'processing_update',
    openQuestion: null,
    week: { updateText: 'השבוע 15% הנחה על ורדים', facts: [], declines: [] },
    posts: [],
    rules: [],
    history: [],
    tools: ['ask_owner', 'record_fact', 'plan_posts', 'end_turn'],
    doneRule: 'A plan passed the plan checks',
    budget: { stepsLeft: 12, costLeftUsd: 0.06 },
    toolResults: [],
  };

  it('accepts the context of one business', () => {
    expect(AgentContext.safeParse(context).success).toBe(true);
  });

  it('keeps the persona feminine', () => {
    expect(AgentContext.safeParse({ ...context, persona: { name: 'פוסטלי', gender: 'plural' } }).success).toBe(false);
  });

  it('holds at most 20 messages and 8 history topics (A10)', () => {
    expect(AgentContext.safeParse({ ...context, messages: Array(21).fill(context.messages[0]) }).success).toBe(false);
    expect(AgentContext.safeParse({ ...context, history: Array(9).fill('topic') }).success).toBe(false);
  });

  it('has no field for phone numbers', () => {
    expect(Object.keys(AgentContext.shape)).not.toContain('approverPhone');
    expect(AgentContext.shape.profile.safeParse({ approverPhone: '+972501234567' }).success).toBe(false);
  });
});
