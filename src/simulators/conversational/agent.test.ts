import { describe, expect, it } from 'vitest';
import { AgentContext, AgentStep, type AgentToolCall, type AgentToolResult } from '../../contracts/agent.js';
import { conversationalModelSimulator } from './index.js';
import { playgroundAgent } from './agent.js';
import { taskOutputJsonSchema } from '../model.js';

// The rule agent the playground and the dev sandbox play on the model simulator (agent.md, Testing
// without paying for a model). Word rules, a pure function of the AgentContext; not product logic.

const AT = '2026-11-05T10:00:00+02:00';
const PHOTO = '11111111-2222-4333-8444-555555555555';
const PHOTO_2 = '11111111-2222-4333-8444-666666666666';
const POST_1 = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const POST_2 = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4f';

function ctx(overrides: Partial<AgentContext>): AgentContext {
  return AgentContext.parse({
    agent: 'onboarding',
    persona: { name: 'פוסטלי', gender: 'feminine' },
    languages: ['he'],
    tone: { register: 'warm', address: 'plural', emoji: true },
    profile: {},
    missingFields: [],
    messages: [],
    step: 'onboarding',
    openQuestion: null,
    week: null,
    posts: [],
    rules: [],
    history: [],
    tools: ['ask_owner', 'end_turn'],
    doneRule: 'done',
    budget: { stepsLeft: 12, costLeftUsd: 0.06 },
    toolResults: [],
    ...overrides,
  });
}

const owner = (text: string, photos: string[] = []) => ({ role: 'owner' as const, text, at: AT, photos: photos.map((assetId) => ({ assetId })) });
const ok = (data: Record<string, unknown> = {}): AgentToolResult => ({ status: 'ok', data });
const tools = (s: AgentStep) => s.calls.map((c) => c.tool);

/** Plays a whole turn: each step's calls succeed with the given result data, until the turn ends. */
function playTurn(context: AgentContext, data: (c: AgentToolCall) => Record<string, unknown> = () => ({})): AgentToolCall[] {
  const played: AgentToolCall[] = [];
  let results: AgentContext['toolResults'] = [];
  for (let i = 0; i < 12; i++) {
    const s = AgentStep.parse(playgroundAgent({ ...context, toolResults: results }));
    played.push(...s.calls);
    results = [...results, ...s.calls.map((c) => ({ tool: c.tool, result: ok(data(c)) }))];
    const last = s.calls.at(-1)!;
    if (last.tool === 'end_turn' || last.tool === 'request_photo' || (last.tool === 'ask_owner' && last.expects === 'answer')) return played;
  }
  throw new Error('the rule agent did not end its turn');
}

describe('playgroundAgent: onboarding', () => {
  it('asks for the first missing group when nothing was asked yet', () => {
    const played = playTurn(ctx({ step: 'profile_questions', missingFields: ['name', 'field', 'mainProducts', 'location', 'differentiator', 'channels', 'style'] }));
    expect(played).toEqual([
      expect.objectContaining({ tool: 'ask_owner', topic: 'profile:name', expects: 'answer', fields: ['name', 'field', 'mainProducts'] }),
    ]);
  });

  it("fills the asked fields from the owner's answer, quoting it verbatim, and asks for the next group", () => {
    const answer = 'הפרחים של רינה, חנות פרחים, זרי כלה ועציצים';
    const played = playTurn(
      ctx({
        step: 'profile_questions',
        missingFields: ['name', 'field', 'mainProducts', 'location', 'differentiator', 'channels', 'style'],
        messages: [owner(answer)],
        openQuestion: { key: 'profile:name', askedFields: ['name', 'field', 'mainProducts'], attempts: 1, photoAssetIds: [] },
      }),
    );
    expect(played.filter((c) => c.tool === 'set_profile_field')).toEqual([
      { tool: 'set_profile_field', field: 'name', value: 'הפרחים של רינה', sourceQuote: answer },
      { tool: 'set_profile_field', field: 'field', value: 'חנות פרחים', sourceQuote: answer },
      { tool: 'set_profile_field', field: 'mainProducts', value: ['זרי כלה', 'עציצים'], sourceQuote: answer },
    ]);
    expect(played.at(-1)).toMatchObject({ tool: 'ask_owner', topic: 'profile:location', fields: ['location'] });
  });

  it('splits more than four calls over steps of at most four', () => {
    const answer = 'רחוב הרצל 5 בחיפה, פתוח 9:00-19:00, יש משלוחים';
    const context = ctx({
      step: 'profile_questions',
      missingFields: ['location', 'differentiator', 'channels', 'style'],
      messages: [owner(answer)],
      openQuestion: { key: 'profile:location', askedFields: ['location'], attempts: 1, photoAssetIds: [] },
    });
    const first = AgentStep.parse(playgroundAgent(context));
    expect(tools(first)).toEqual(['set_profile_field', 'set_profile_field', 'set_profile_field', 'set_profile_field']);
    const played = playTurn(context);
    expect(played.map((c) => c.tool)).toEqual([...tools(first), 'ask_owner']);
    expect(played.at(-1)).toMatchObject({ topic: 'profile:differentiator' });
  });

  it('asks "anything else?" once when nothing is missing, and ends the turn after its answer', () => {
    expect(playTurn(ctx({ step: 'profile_questions', missingFields: ['style'] }))).toEqual([
      expect.objectContaining({ tool: 'ask_owner', topic: 'anything_else' }),
    ]);
    const answered = ctx({
      step: 'profile_questions',
      missingFields: ['style'],
      messages: [owner('לא, זהו')],
      openQuestion: { key: 'anything_else', askedFields: [], attempts: 1, photoAssetIds: [] },
    });
    expect(playTurn(answered)).toEqual([{ tool: 'end_turn' }]);
  });

  it('brand assets: asks for the logo, records a decline when text comes instead, then asks for business photos', () => {
    expect(playTurn(ctx({ step: 'brand_assets' }))).toEqual([expect.objectContaining({ tool: 'request_photo', purpose: 'logo' })]);
    const declined = playTurn(
      ctx({ step: 'brand_assets', messages: [owner('אין לי לוגו')], openQuestion: { key: 'photo_request:logo', askedFields: [], attempts: 1, photoAssetIds: [] } }),
    );
    expect(declined).toEqual([
      { tool: 'record_decline', what: 'logo', ownerQuote: 'אין לי לוגו' },
      expect.objectContaining({ tool: 'request_photo', purpose: 'business' }),
    ]);
    const sent = playTurn(
      ctx({ step: 'brand_assets', messages: [owner('', [PHOTO])], openQuestion: { key: 'photo_request:business', askedFields: [], attempts: 1, photoAssetIds: [] } }),
    );
    expect(sent).toEqual([{ tool: 'end_turn' }]);
  });
});

describe('playgroundAgent: weekly update', () => {
  const update = 'השבוע 20% הנחה על כל הזרים';
  const weekly = (o: Partial<AgentContext> = {}) =>
    ctx({
      agent: 'weekly',
      step: 'processing_update',
      profile: { postsPerWeek: 2, contentTypes: ['promotions', 'tips'], formats: ['single'] },
      messages: [owner(update, [PHOTO])],
      week: { updateText: update, facts: [], declines: [] },
      ...o,
    });

  it('records the update as one fact, then plans the week from the fact id the runtime returned', () => {
    const first = AgentStep.parse(playgroundAgent(weekly()));
    expect(first.calls).toEqual([{ tool: 'record_fact', type: 'other', value: update, sourceQuote: update }]);

    const played = playTurn(weekly(), (c) => (c.tool === 'record_fact' ? { factId: 'fact-9' } : {}));
    const plan = played.find((c) => c.tool === 'plan_posts');
    expect(plan).toMatchObject({ tool: 'plan_posts', mode: 'initial' });
    if (plan?.tool !== 'plan_posts') throw new Error('no plan');
    expect(plan.posts).toHaveLength(2);
    expect(plan.posts[0]).toMatchObject({ factIds: ['fact-9'], mediaAssetIds: [PHOTO] });
    expect(played.at(-1)).toEqual({ tool: 'end_turn' });
  });

  it('plans from facts already recorded, and ends the turn once posts exist', () => {
    const recorded = weekly({ week: { updateText: update, facts: [{ id: 'f1', type: 'other', value: update, sourceQuote: update }], declines: [] } });
    expect(tools(AgentStep.parse(playgroundAgent(recorded)))).toEqual(['plan_posts']);
    const planned = weekly({
      posts: [{ id: POST_1, state: 'planned', format: 'single', plan: { topic: 'מבצע', contentType: 'promotions', format: 'single', factIds: [], mediaAssetIds: [], brief: 'מבצע' } }],
    });
    expect(playTurn(planned)).toEqual([{ tool: 'end_turn' }]);
  });
});

describe('playgroundAgent: drafts', () => {
  const plan = (topic: string, mediaAssetIds: string[]) => ({ topic, contentType: 'promotions' as const, format: 'single' as const, factIds: ['f1'], mediaAssetIds, brief: `${topic} אצלנו` });
  const drafts = (o: Partial<AgentContext> = {}) =>
    ctx({ agent: 'drafts', step: 'processing_update', profile: { channels: ['instagram'], fixedHashtags: ['#פרחים'] }, ...o });

  it('drafts each planned post from its plan, and asks for a photo when a post has none and no photo came', () => {
    const played = playTurn(
      drafts({
        posts: [
          { id: POST_1, state: 'planned', format: 'single', plan: plan('זרי סתיו', [PHOTO]) },
          { id: POST_2, state: 'planned', format: 'single', plan: plan('טיפ להשקיה', []) },
        ],
      }),
    );
    expect(played[0]).toEqual({
      tool: 'create_draft',
      postId: POST_1,
      captions: { instagram: { text: 'זרי סתיו אצלנו', hashtags: ['#פרחים'] } },
      usedFactIds: ['f1'],
      design: { photos: [{ assetId: PHOTO }], title: 'זרי סתיו' },
    });
    expect(played[1]).toMatchObject({ tool: 'request_photo', purpose: 'post', postId: POST_2 });
  });

  it("uses a photo from the owner's messages for a post planned without one", () => {
    const played = playTurn(
      drafts({ messages: [owner('הנה תמונה', [PHOTO_2])], posts: [{ id: POST_2, state: 'planned', format: 'single', plan: plan('טיפ להשקיה', []) }] }),
    );
    expect(played[0]).toMatchObject({ tool: 'create_draft', design: { photos: [{ assetId: PHOTO_2 }] } });
  });

  it("applies the owner's change to the first open draft and saves it as a caption rule", () => {
    const played = playTurn(
      drafts({
        messages: [owner('תוסיפו שאנחנו פתוחים עד 20:00')],
        posts: [{ id: POST_1, state: 'awaiting_approval', format: 'single', plan: plan('זרי סתיו', [PHOTO]), captions: { instagram: { text: 'זרי סתיו אצלנו', hashtags: [] } } }],
      }),
    );
    expect(played[0]).toEqual({
      tool: 'apply_change',
      postId: POST_1,
      ownerQuote: 'תוסיפו שאנחנו פתוחים עד 20:00',
      captions: { instagram: { text: 'זרי סתיו אצלנו\nתוסיפו שאנחנו פתוחים עד 20:00', hashtags: [] } },
      rule: { text: 'תוסיפו שאנחנו פתוחים עד 20:00', scope: 'caption' },
    });
  });

  it('ends the turn when there is nothing to do', () => {
    expect(playTurn(drafts())).toEqual([{ tool: 'end_turn' }]);
  });
});

describe('conversationalModelSimulator', () => {
  it('answers the three agent tasks with the rule agent', async () => {
    const model = conversationalModelSimulator();
    const result = await model.generateStructured({
      task: 'agent_onboarding',
      model: 'simulator-model',
      prompt: 'agent_onboarding v1',
      input: ctx({ step: 'profile_questions', missingFields: ['name'] }),
      outputJsonSchema: taskOutputJsonSchema('agent_onboarding'),
      temperature: 0,
    });
    expect(tools(AgentStep.parse(result.output))).toEqual(['ask_owner']);
    expect(model.agentScriptProblems()).toEqual([]);
  });
});
