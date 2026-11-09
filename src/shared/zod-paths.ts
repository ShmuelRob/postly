import type { z } from 'zod';

// Where a value was invalid, as field names, for log lines (docs/observability.md, Timing lines):
// never the values. Used by the model layer's `invalidPaths` and the agent's per-call paths.

type SchemaDef = { type?: string; shape?: Record<string, z.ZodType>; valueType?: z.ZodType; element?: z.ZodType; innerType?: z.ZodType; in?: z.ZodType; items?: z.ZodType[]; getter?: () => z.ZodType };
const defOf = (schema: z.ZodType | undefined): SchemaDef | undefined => (schema as unknown as { _zod?: { def?: SchemaDef } } | undefined)?._zod?.def;
const WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'readonly', 'catch', 'nonoptional']);

/** One step down the schema along a path segment, and how to write that segment: a field name, `#` or `*`. */
function stepInto(schema: z.ZodType | undefined, segment: PropertyKey): { next: z.ZodType | undefined; written: string } {
  let def = defOf(schema);
  for (let i = 0; def && i < 10; i++) {
    if (def.type && WRAPPERS.has(def.type)) def = defOf(def.innerType);
    else if (def.type === 'pipe') def = defOf(def.in);
    else if (def.type === 'lazy' && def.getter) def = defOf(def.getter());
    else break;
  }
  if (typeof segment === 'number') return { next: def?.type === 'array' ? def.element : def?.type === 'tuple' ? def.items?.[segment] : undefined, written: '#' };
  const key = String(segment);
  if (def?.type === 'object' && def.shape && key in def.shape) return { next: def.shape[key], written: key };
  // A record key is what the model wrote, so it may be content; a key the schema cannot place is a
  // plain identifier at most.
  if (def?.type === 'record') return { next: def.valueType, written: '*' };
  return { next: undefined, written: /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(key) ? key : '*' };
}

/**
 * Where a value was invalid: the issue paths as field names, array indexes as `#`, record keys as `*`,
 * the root as `(root)`, comma-separated and deduplicated, at most 200 characters. A custom issue that
 * carries `params.logPath` is written as that path: a refinement that already wrote its own, made of
 * field and tool names only (agent.md, One bad call does not sink the step).
 */
export function issuePaths(schema: z.ZodType, error: z.ZodError): string {
  const paths = error.issues.map((issue) => {
    const logPath = issue.code === 'custom' ? (issue.params as { logPath?: unknown } | undefined)?.logPath : undefined;
    if (typeof logPath === 'string') return logPath;
    if (issue.path.length === 0) return '(root)';
    let at: z.ZodType | undefined = schema;
    return issue.path
      .map((segment) => {
        const { next, written } = stepInto(at, segment);
        at = next;
        return written;
      })
      .join('.');
  });
  return [...new Set(paths)].join(',').slice(0, 200);
}
