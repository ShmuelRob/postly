import { describe, expect, it } from 'vitest';
import { INTENTS, MODEL_TASK_NAMES, modelTasks } from './model-tasks.js';

const uuid = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

describe('model task registry', () => {
  it('has exactly the tasks in contracts.md', () => {
    expect([...MODEL_TASK_NAMES].sort()).toEqual(
      [
        'intent_detection',
        'transcription',
        'profile_extraction',
        'fact_extraction',
        'weekly_planning',
        'caption_writing',
        'change_interpretation',
        'image_review',
        'fact_check',
        'agent_onboarding',
        'agent_weekly',
        'agent_drafts',
      ].sort(),
    );
  });

  it('gives every task an input and an output schema', () => {
    for (const name of MODEL_TASK_NAMES) {
      expect(modelTasks[name].input, name).toBeDefined();
      expect(modelTasks[name].output, name).toBeDefined();
    }
  });
});

describe('intent_detection', () => {
  const { output } = modelTasks.intent_detection;

  it('has no approval intent', () => {
    expect(INTENTS.some((i) => i.includes('approv'))).toBe(false);
    expect(output.safeParse({ intent: 'approve', confidence: 0.9 }).success).toBe(false);
  });

  it('bounds confidence to 0..1', () => {
    expect(output.safeParse({ intent: 'weekly_update', confidence: 1.2 }).success).toBe(false);
    expect(output.safeParse({ intent: 'weekly_update', confidence: 0.8 }).success).toBe(true);
  });
});

describe('fact_extraction', () => {
  const { output } = modelTasks.fact_extraction;

  it('accepts facts with a source quote', () => {
    const parsed = output.parse({
      facts: [{ id: 'f1', type: 'discount_percent', value: '20', sourceQuote: '20% הנחה על תמרים' }],
      missingDetails: ['When does the promotion end?'],
    });
    expect(parsed.facts).toHaveLength(1);
  });

  it('rejects a fact without a source quote', () => {
    const result = output.safeParse({ facts: [{ id: 'f1', type: 'price', value: '30' }], missingDetails: [] });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown fact type', () => {
    const result = output.safeParse({
      facts: [{ id: 'f1', type: 'rumor', value: 'x', sourceQuote: 'x' }],
      missingDetails: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate fact ids', () => {
    const fact = { id: 'f1', type: 'product', value: 'Roses', sourceQuote: 'ורדים' };
    expect(output.safeParse({ facts: [fact, fact], missingDetails: [] }).success).toBe(false);
  });
});

describe('weekly_planning', () => {
  const { output } = modelTasks.weekly_planning;

  it('accepts 2 to 5 posts', () => {
    const post = {
      topic: 'New tulips',
      contentType: 'products',
      format: 'single',
      factIds: ['f1'],
      mediaAssetIds: [uuid],
      brief: 'Show the tulips arriving this morning',
    };
    expect(output.safeParse({ posts: [post, post] }).success).toBe(true);
    expect(output.safeParse({ posts: [post] }).success).toBe(false);
    expect(output.safeParse({ posts: Array(6).fill(post) }).success).toBe(false);
  });
});

describe('caption_writing', () => {
  const { output } = modelTasks.caption_writing;

  it('requires at least one network caption', () => {
    expect(output.safeParse({ captions: {}, usedFactIds: [] }).success).toBe(false);
  });

  it('accepts a caption per network', () => {
    const caption = { text: 'צבעונים טריים הגיעו!', hashtags: ['#כפר_סבא'] };
    expect(output.safeParse({ captions: { instagram: caption, facebook: caption }, usedFactIds: ['f1'] }).success).toBe(
      true,
    );
  });

  it('rejects hashtags without a leading #', () => {
    const caption = { text: 'x', hashtags: ['flowers'] };
    expect(output.safeParse({ captions: { instagram: caption }, usedFactIds: [] }).success).toBe(false);
  });
});

describe('change_interpretation', () => {
  const { output } = modelTasks.change_interpretation;

  it('accepts changes with an optional rule to save', () => {
    expect(
      output.safeParse({
        changes: [{ target: 'caption', instruction: 'Shorter, no emoji' }],
        rule: { scope: 'caption', text: 'Do not use emoji' },
      }).success,
    ).toBe(true);
    expect(output.safeParse({ changes: [{ target: 'design', instruction: 'Bigger logo' }] }).success).toBe(true);
  });

  it('requires at least one change', () => {
    expect(output.safeParse({ changes: [] }).success).toBe(false);
  });
});

describe('image_review', () => {
  const { output } = modelTasks.image_review;

  it('requires the crop to be normalized', () => {
    const base = { usable: true, score: 0.7, issues: [] };
    expect(output.safeParse({ ...base, crop: { x: 0.1, y: 0, width: 0.8, height: 1 } }).success).toBe(true);
    expect(output.safeParse({ ...base, crop: { x: 0.5, y: 0, width: 0.8, height: 1 } }).success).toBe(false);
  });
});

describe('image_review version 2 (agent.md, Photos the agent sees)', () => {
  const { output } = modelTasks.image_review;
  const base = { usable: true, score: 0.7, issues: [] };

  it('accepts a description and suggested edits within the photo edit ranges', () => {
    expect(output.safeParse({ ...base, description: 'זר ורדים על דלפק', rotateDeg: -2.5, brightness: 0.1, contrast: 0 }).success).toBe(true);
    expect(output.safeParse(base).success).toBe(true);
  });

  it('rejects suggestions out of range and a description over 200 characters', () => {
    expect(output.safeParse({ ...base, rotateDeg: 12 }).success).toBe(false);
    expect(output.safeParse({ ...base, brightness: 0.5 }).success).toBe(false);
    expect(output.safeParse({ ...base, description: 'א'.repeat(201) }).success).toBe(false);
  });
});

describe('agent tasks (contracts.md, Agent)', () => {
  it('take an AgentContext and return an AgentStep', () => {
    for (const task of ['agent_onboarding', 'agent_weekly', 'agent_drafts'] as const) {
      expect(modelTasks[task].output.safeParse({ calls: [{ tool: 'end_turn' }], confidence: 1 }).success, task).toBe(true);
      expect(modelTasks[task].output.safeParse({ calls: [{ tool: 'approve' }], confidence: 1 }).success, task).toBe(false);
    }
  });
});

describe('profile_extraction', () => {
  const { output } = modelTasks.profile_extraction;

  it('validates the fields it found against the profile draft', () => {
    expect(output.safeParse({ found: { postsPerWeek: 4 }, unclear: [] }).success).toBe(true);
    expect(output.safeParse({ found: { postsPerWeek: 8 }, unclear: [] }).success).toBe(false);
  });
});
