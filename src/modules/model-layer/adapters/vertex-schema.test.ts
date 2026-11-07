import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MODEL_TASK_NAMES, modelTasks } from '../../../contracts/model-tasks.js';
import { describeVertexError, forVertex } from './vertex.js';

// Gemini 3.5 Flash-Lite answers HTTP 400 to any responseJsonSchema containing `maxItems` (found on dev,
// 2026-11-07; contracts.md, the Google adapter). The adapter drops that keyword; Zod still enforces it.

/** Every `maxItems` used as a schema keyword, by path; a property named `maxItems` is not one. */
function keywordPaths(node: unknown, keyword: string, path = '$'): string[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => keywordPaths(n, keyword, `${path}[${i}]`));
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) => {
    if (['enum', 'const', 'default', 'examples'].includes(key)) return [];
    if (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(key) && value && typeof value === 'object') {
      return Object.entries(value).flatMap(([name, sub]) => keywordPaths(sub, keyword, `${path}.${key}.${name}`));
    }
    return [...(key === keyword ? [`${path}.${key}`] : []), ...keywordPaths(value, keyword, `${path}.${key}`)];
  });
}

/** Every property name declared anywhere in the schema, with its path. */
function propertyNames(node: unknown, path = '$'): string[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => propertyNames(n, `${path}[${i}]`));
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) => {
    if (['enum', 'const', 'default', 'examples'].includes(key)) return [];
    if (key === 'properties' && value && typeof value === 'object') {
      return Object.entries(value).flatMap(([name, sub]) => [`${path}.${name}`, ...propertyNames(sub, `${path}.${name}`)]);
    }
    return propertyNames(value, `${path}.${key}`);
  });
}

describe('forVertex: the schema Vertex receives', () => {
  it('found the case it guards: some task output schemas do use maxItems', () => {
    const using = MODEL_TASK_NAMES.filter((t) => keywordPaths(z.toJSONSchema(modelTasks[t].output), 'maxItems').length > 0);
    expect(using).toContain('profile_extraction');
  });

  it.each(MODEL_TASK_NAMES)('%s: no maxItems keyword and no $schema remain; every property and every other keyword is kept', (task) => {
    const original = z.toJSONSchema(modelTasks[task].output) as Record<string, unknown>;
    const before = JSON.stringify(original);
    const sent = forVertex(original);
    expect(keywordPaths(sent, 'maxItems')).toEqual([]);
    expect(sent).not.toHaveProperty('$schema');
    expect(propertyNames(sent)).toEqual(propertyNames(original));
    // Only maxItems went: put the original's values back at its paths and the two are equal.
    expect(keywordPaths(sent, 'minItems')).toEqual(keywordPaths(original, 'minItems'));
    expect(JSON.stringify(sent).length).toBeLessThanOrEqual(before.length);
    // The caller's schema is not changed.
    expect(JSON.stringify(original)).toBe(before);
  });

  it('drops the keyword at every depth but keeps a property, an enum value or a required name called maxItems', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        maxItems: { type: 'integer', maximum: 5 },
        tags: { type: 'array', items: { type: 'string', enum: ['maxItems', 'a'] }, minItems: 1, maxItems: 3 },
        nested: { anyOf: [{ type: 'array', maxItems: 2, items: { type: 'array', maxItems: 4 } }, { type: 'null' }] },
      },
      required: ['maxItems', 'tags'],
      $defs: { maxItems: { type: 'array', maxItems: 9 } },
    };
    expect(forVertex(schema)).toEqual({
      type: 'object',
      properties: {
        maxItems: { type: 'integer', maximum: 5 },
        tags: { type: 'array', items: { type: 'string', enum: ['maxItems', 'a'] }, minItems: 1 },
        nested: { anyOf: [{ type: 'array', items: { type: 'array' } }, { type: 'null' }] },
      },
      required: ['maxItems', 'tags'],
      $defs: { maxItems: { type: 'array' } },
    });
  });
});

describe('describeVertexError: why a call failed, in model_run.error', () => {
  const vertex400 = Object.assign(new Error('Request contains an invalid argument.'), {
    config: { data: { systemInstruction: { parts: [{ text: 'THE PROMPT' }] }, contents: [{ role: 'user', parts: [{ text: 'OWNER TEXT' }] }] } },
    response: {
      status: 400,
      data: {
        error: {
          code: 400,
          message: 'Request contains an invalid argument.',
          status: 'INVALID_ARGUMENT',
          details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'generation_config.response_json_schema', description: 'maxItems is not supported' }] }],
        },
      },
    },
  });

  it("keeps the HTTP status and Vertex's status, message and details", () => {
    const text = describeVertexError(vertex400);
    expect(text).toContain('HTTP 400');
    expect(text).toContain('INVALID_ARGUMENT');
    expect(text).toContain('Request contains an invalid argument.');
    expect(text).toContain('generation_config.response_json_schema');
    expect(text).toContain('maxItems is not supported');
  });

  it('never carries the request: no prompt and no owner text', () => {
    const text = describeVertexError(vertex400);
    expect(text).not.toContain('THE PROMPT');
    expect(text).not.toContain('OWNER TEXT');
  });

  it('is at most 1000 characters, and an error without a Vertex body keeps its own message', () => {
    const long = Object.assign(new Error('bad'), { response: { status: 400, data: { error: { status: 'INVALID_ARGUMENT', message: 'x', details: [{ d: 'y'.repeat(5000) }] } } } });
    expect(describeVertexError(long).length).toBeLessThanOrEqual(1000);
    expect(describeVertexError(new Error('socket hang up'))).toBe('socket hang up');
    expect(describeVertexError('plain')).toBe('plain');
  });
});
