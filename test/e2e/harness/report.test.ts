import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyRecord, type E2eRecord } from './record.js';
import { renderReport, writeReport, type ReportRun, type ReportTest } from './report.js';

const at = '2026-11-02T10:00:00.000Z';
const png = 'data:image/png;base64,iVBORw0KGgo=';

function record(): E2eRecord {
  return {
    transcript: [
      { at, direction: 'from_owner', phone: '+972501234567', kind: 'text', text: 'יש לנו צבעונים חדשים' },
      {
        at,
        direction: 'to_owner',
        phone: '+972501234567',
        kind: 'buttons',
        text: 'הנה הטיוטה',
        buttons: [
          { id: 'approve', title: 'אישור' },
          { id: 'change', title: 'שינוי' },
        ],
        image: { ref: 'https://storage.example.test/a.png', mimeType: 'image/png', src: png },
      },
      {
        at,
        direction: 'to_owner',
        phone: '+972501234567',
        kind: 'template',
        template: { name: 'weekly_reminder', language: 'he', variables: { name: 'Dana' } },
      },
    ],
    renders: [
      {
        at,
        network: 'instagram',
        style: 'clean',
        width: 1080,
        height: 1350,
        image: { ref: 'renders/a.png', mimeType: 'image/png', src: png },
      },
    ],
    publishing: [
      {
        at,
        network: 'facebook',
        providerAccountId: 'acc_1',
        idempotencyKey: '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e',
        format: 'single',
        scheduledFor: '2026-11-03T08:00:00.000Z',
        caption: 'צבעונים חדשים בחנות',
        media: [{ ref: 'renders/a.png', mimeType: 'image/png', src: png }],
        outcome: { ok: true, providerPostId: 'post_1' },
      },
      {
        at,
        network: 'instagram',
        providerAccountId: 'acc_2',
        idempotencyKey: '4f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e',
        format: 'single',
        scheduledFor: '2026-11-03T08:00:00.000Z',
        caption: 'צבעונים',
        media: [],
        outcome: { ok: false, error: 'token expired' },
      },
    ],
  };
}

function test(overrides: Partial<ReportTest> = {}): ReportTest {
  return { name: 'owner approves a draft', file: 'test/e2e/sample.e2e.test.ts', state: 'passed', errors: [], ...overrides };
}

function run(tests: ReportTest[]): ReportRun {
  return { title: 'Postly end-to-end report', generatedAt: at, tests };
}

describe('renderReport', () => {
  it('summarizes pass and fail counts and marks each test', () => {
    const html = renderReport(
      run([test(), test({ name: 'publishing fails', state: 'failed', errors: ['expected 1 post, got 0'] })]),
    );
    expect(html).toContain('<!doctype html>');
    expect(html).toMatch(/1 passed/);
    expect(html).toMatch(/1 failed/);
    expect(html).toContain('data-state="passed"');
    expect(html).toContain('data-state="failed"');
    expect(html).toContain('expected 1 post, got 0');
  });

  it('shows the WhatsApp transcript in both directions with buttons and templates', () => {
    const html = renderReport(run([test({ record: record() })]));
    expect(html).toContain('יש לנו צבעונים חדשים');
    expect(html).toContain('הנה הטיוטה');
    expect(html).toContain('data-direction="from_owner"');
    expect(html).toContain('data-direction="to_owner"');
    expect(html).toContain('אישור');
    expect(html).toContain('weekly_reminder');
    expect(html).toContain('dir="auto"');
  });

  it('embeds rendered images and lists the publishing log with outcomes', () => {
    const html = renderReport(run([test({ record: record() })]));
    expect(html).toContain(`src="${png}"`);
    expect(html).toContain('1080×1350');
    expect(html).toContain('צבעונים חדשים בחנות');
    expect(html).toContain('post_1');
    expect(html).toContain('token expired');
  });

  it('embeds screenshots of a driven UI with their titles', () => {
    const r = record();
    r.screenshots = [{ at: '2026-11-03T10:00:00.000Z', title: 'playground', image: { ref: 'shot.png', mimeType: 'image/png', src: 'data:image/png;base64,AAAA' } }];
    const html = renderReport(run([test({ record: r })]));
    expect(html).toContain('<h3>Screenshots</h3>');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('playground · 2026-11-03T10:00:00.000Z');
  });

  it('escapes HTML in recorded content', () => {
    const r = emptyRecord();
    r.transcript.push({ at, direction: 'from_owner', phone: '+972501234567', kind: 'text', text: '<script>x</script>' });
    const html = renderReport(run([test({ record: r, errors: ['a < b & "c"'] })]));
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('a &lt; b &amp; &quot;c&quot;');
  });

  it('only embeds data: image sources', () => {
    const r = emptyRecord();
    r.renders.push({
      at,
      network: 'facebook',
      style: 'warm',
      width: 1,
      height: 1,
      image: { ref: 'x', mimeType: 'image/png', src: 'javascript:alert(1)' },
    });
    expect(renderReport(run([test({ record: r })]))).not.toContain('javascript:alert(1)');
  });

  it("shows the agent's steps: turn, tool calls, results and the turn's stop reason", () => {
    const r: E2eRecord = {
      ...emptyRecord(),
      agentSteps: [
        {
          at,
          agent: 'weekly',
          turn: 1,
          step: 1,
          calls: [{ tool: 'record_fact', type: 'discount_percent', value: '20', sourceQuote: '20% הנחה' }],
          confidence: 0.9,
          results: [{ tool: 'record_fact', result: { status: 'refused', reason: 'quote_not_found', detail: 'not in the message' } }],
        },
        { at, agent: 'weekly', turn: 1, step: 2, output: { calls: [] }, results: [] },
      ],
      agentTurns: [{ at, agent: 'weekly', turnId: 'turn-1', stopReason: 'waiting_for_owner', steps: [] }],
    };
    const html = renderReport(run([test({ record: r })]));
    expect(html).toContain('<h3>Agent steps</h3>');
    expect(html).toContain('record_fact');
    expect(html).toContain('20% הנחה');
    expect(html).toContain('refused: quote_not_found');
    expect(html).toContain('invalid output');
    expect(html).toContain('waiting_for_owner');
  });

  it('handles a test that recorded nothing', () => {
    const html = renderReport(run([test({ state: 'skipped' })]));
    expect(html).toContain('data-state="skipped"');
    expect(html).toContain('owner approves a draft');
  });
});

describe('writeReport', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('writes index.html into the report directory and returns its path', () => {
    dir = mkdtempSync(join(tmpdir(), 'postly-e2e-'));
    const path = writeReport(join(dir, 'nested'), run([test({ record: record() })]));
    expect(path).toBe(join(dir, 'nested', 'index.html'));
    expect(readFileSync(path, 'utf8')).toContain('יש לנו צבעונים חדשים');
  });
});

describe('versioned runs', () => {
  it('writes each run to its own folder, keeps latest, and lists runs newest first', async () => {
    const { writeRunReport } = await import('./report.js');
    const root = mkdtempSync(join(tmpdir(), 'runs-'));

    writeRunReport(root, run([test()]), '2026-11-02T10-00-00Z', 'abc1234');
    writeRunReport(root, run([test({ state: 'failed', errors: ['boom'] })]), '2026-11-03T10-00-00Z', 'def5678');
    expect(readFileSync(join(root, '2026-11-02T10-00-00Z-abc1234', 'index.html'), 'utf8')).toContain('passed');
    expect(readFileSync(join(root, 'latest', 'index.html'), 'utf8')).toContain('boom');
    const index = readFileSync(join(root, 'index.html'), 'utf8');
    expect(index.indexOf('def5678')).toBeGreaterThan(-1);
    expect(index.indexOf('def5678')).toBeLessThan(index.indexOf('abc1234'));
    expect(index).toContain('href="2026-11-03T10-00-00Z-def5678/index.html"');
    rmSync(root, { recursive: true, force: true });
  });
});
