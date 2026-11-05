import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { METRICS, metrics, withSpan } from './telemetry.js';
import { memoryTelemetry, type MemoryTelemetry } from './telemetry-memory.js';

// docs/observability.md, Metrics (WP-48) and Tracing (WP-48).

const doc = readFileSync(new URL('../../docs/observability.md', import.meta.url), 'utf8');

/** The metric table of the Metrics section: name -> label names. */
function documentedMetrics(): Map<string, string[]> {
  const section = doc.slice(doc.indexOf('## Metrics (WP-48)'), doc.indexOf('## Tracing (WP-48)'));
  const rows = section.split('\n').filter((line) => line.startsWith('| `postly.'));
  return new Map(
    rows.map((row) => {
      const [, name, , labels] = row.split('|').map((cell) => cell.trim());
      const labelNames = [...labels!.replace(/\([^)]*\)/g, '').matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);
      return [name!.replaceAll('`', ''), labelNames.sort()];
    }),
  );
}

const PHONE = '+972501234567';
const OWNER_TEXT = 'מבצע 20% הנחה על זר צבעונים';

let telemetry: MemoryTelemetry;
beforeEach(() => {
  telemetry = memoryTelemetry();
});
afterEach(() => telemetry.stop());

describe('metric catalogue', () => {
  it('matches the table in docs/observability.md, names and labels', () => {
    const documented = documentedMetrics();
    const declared = new Map(Object.entries(METRICS).map(([name, m]) => [name, Object.keys(m.labels).sort()]));
    expect(declared).toEqual(documented);
  });

  it('declares every label value as a fixed list or a code-constant pattern', () => {
    for (const metric of Object.values(METRICS)) {
      for (const allowed of Object.values(metric.labels)) expect(Array.isArray(allowed) || allowed instanceof RegExp).toBe(true);
    }
  });
});

describe('metrics', () => {
  it('records a counter with its labels', async () => {
    metrics.count('postly.messages.count', { direction: 'in', kind: 'text', outcome: 'accepted' });
    metrics.count('postly.messages.count', { direction: 'in', kind: 'text', outcome: 'accepted' });
    expect(await telemetry.points('postly.messages.count')).toEqual([{ labels: { direction: 'in', kind: 'text', outcome: 'accepted' }, value: 2 }]);
  });

  it('records a histogram', async () => {
    metrics.record('postly.model.latency', 120, { task: 'caption_writing', outcome: 'valid' });
    const [point] = await telemetry.points('postly.model.latency');
    expect(point).toMatchObject({ labels: { task: 'caption_writing', outcome: 'valid' }, count: 1, sum: 120 });
  });

  it('replaces a value outside the declared list with "other", so customer text or a phone never reaches a label', async () => {
    metrics.count('postly.messages.count', { direction: 'in', kind: OWNER_TEXT, outcome: PHONE } as never);
    metrics.count('postly.jobs.failures.count', { job: `weekly ${OWNER_TEXT}` });
    const all = JSON.stringify(await telemetry.allPoints());
    expect(all).not.toContain(PHONE);
    expect(all).not.toContain('מבצע');
    expect(await telemetry.points('postly.messages.count')).toEqual([{ labels: { direction: 'in', kind: 'other', outcome: 'other' }, value: 1 }]);
    expect(await telemetry.points('postly.jobs.failures.count')).toEqual([{ labels: { job: 'other' }, value: 1 }]);
  });

  it('drops a label the metric does not declare (no business id label)', async () => {
    metrics.count('postly.drafts.count', { outcome: 'sent', businessId: '3f1c2b9e-0000-4000-8000-000000000000' } as never);
    expect(await telemetry.points('postly.drafts.count')).toEqual([{ labels: { outcome: 'sent' }, value: 1 }]);
  });

  it('never throws into the caller', () => {
    expect(() => metrics.count('postly.unknown' as never, {} as never)).not.toThrow();
    expect(() => metrics.record('postly.model.latency', Number.NaN, { task: 'caption_writing', outcome: 'valid' })).not.toThrow();
  });
});

describe('spans', () => {
  it('opens a span with allowed attributes and returns the result', async () => {
    const id = '3f1c2b9e-0000-4000-8000-000000000000';
    const result = await withSpan('publication run', { publicationId: id, network: 'instagram', attempt: 2 }, async () => 'done');
    expect(result).toBe('done');
    expect(telemetry.spans()).toEqual([expect.objectContaining({ name: 'publication run', attributes: { publicationId: id, network: 'instagram', attempt: 2 }, status: 'OK' })]);
  });

  it('drops unknown keys and free-text values', async () => {
    await withSpan('inbound burst', { messageId: OWNER_TEXT, text: OWNER_TEXT, phone: PHONE, outcome: 'accepted' } as never, async () => undefined);
    const [span] = telemetry.spans();
    expect(span!.attributes).toEqual({ outcome: 'accepted' });
    expect(JSON.stringify(telemetry.spans())).not.toContain(PHONE);
  });

  it('marks a thrown span as ERROR with scrubbed text, and rethrows', async () => {
    await expect(withSpan('job weekly-tick', { job: 'weekly-tick' }, async () => { throw new Error(`send to ${PHONE} failed`); })).rejects.toThrow('failed');
    const [span] = telemetry.spans();
    expect(span!.status).toBe('ERROR');
    expect(span!.statusMessage).toContain('[redacted]');
    expect(JSON.stringify(span)).not.toContain(PHONE);
    expect(span!.events).toEqual([]);
  });

  it('nests spans in one trace', async () => {
    await withSpan('job publishing-tick', { job: 'publishing-tick' }, () => withSpan('publication run', {}, async () => undefined));
    const [inner, outer] = telemetry.spans();
    expect(inner!.traceId).toBe(outer!.traceId);
    expect(inner!.parentSpanId).toBe(outer!.spanId);
  });
});
