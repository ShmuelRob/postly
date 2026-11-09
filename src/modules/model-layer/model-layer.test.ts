import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { issuePaths } from './model-layer.js';

// docs/observability.md, Timing lines: `invalidPaths` names where an output was invalid, never what it held.
describe('invalidPaths', () => {
  const check = (schema: z.ZodType, value: unknown) => {
    const result = schema.safeParse(value);
    if (result.success) throw new Error('expected an invalid value');
    return issuePaths(schema, result.error);
  };

  it('names object fields, writes array indexes as # and the root as (root)', () => {
    const schema = z.object({ posts: z.array(z.object({ topic: z.string() })), confidence: z.number() });
    expect(check(schema, { posts: [{ topic: 1 }] })).toBe('posts.#.topic,confidence');
    expect(check(z.string(), 5)).toBe('(root)');
  });

  it('writes a record key as *, since a key the model wrote may be content', () => {
    const schema = z.object({ captions: z.record(z.string(), z.object({ text: z.string() })) });
    expect(check(schema, { captions: { 'מבצע 1+1 על כל הקרואסונים': { text: 3 } } })).toBe('captions.*.text');
  });

  it('writes any key it cannot place under the schema as *, unless it is a plain identifier', () => {
    const schema = z.union([z.object({ a: z.string() }), z.record(z.string(), z.number())]);
    const paths = check(z.object({ v: schema }), { v: { 'שלום עולם': 'x' } });
    expect(paths).not.toContain('שלום');
  });

  it("uses a custom issue's logPath as given: an agent step names its failing calls (agent.md, One bad call)", () => {
    const schema = z.object({ calls: z.array(z.unknown()) }).superRefine((_v, ctx) => {
      ctx.addIssue({ code: 'custom', path: ['calls', 0], message: 'no call parses', params: { logPath: 'calls.0(create_draft).design.title' } });
    });
    expect(check(schema, { calls: [{}] })).toBe('calls.0(create_draft).design.title');
  });
});
