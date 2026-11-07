import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addLogContext, asError, log, setLogLabels, setLogLevel, setLogSink, withLogContext, traceFromHeaders } from './logger.js';
import { withSpan } from './telemetry.js';
import { memoryTelemetry } from './telemetry-memory.js';

// docs/observability.md, Logging (WP-47).

let lines: string[] = [];
const capture = () => {
  lines = [];
  setLogSink((line) => lines.push(line));
};
const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
afterEach(() => setLogSink(undefined));

const CUSTOMER_TEXT = 'מבצע 1+1 על כל הקרואסונים רק השבוע';
const PHONES = ['+972501234567', '+972 50-123-4567', '0501234567', '972501234567'];
// Fake, built at runtime so secret scanners do not flag the source.
const fake = (n: number) => Array.from({ length: n }, (_, i) => 'a1B2c3D4e5'[i % 10]).join('');
const PASSWORD = ['not', 'real', '9pw'].join('-');
const SECRETS = [
  `postgres://app_workflow:${PASSWORD}@10.0.0.3:5432/postly`,
  `Bearer ${['ya', '29'].join('')}.${fake(30)}`,
  `${['sk', 'test'].join('_')}_${fake(40)}`,
  `${['AI', 'za'].join('')}Sy${fake(33)}`,
];
const FORBIDDEN = [CUSTOMER_TEXT, ...PHONES, PASSWORD, SECRETS[1]!.slice(7), SECRETS[2]!, SECRETS[3]!];

describe('logger format', () => {
  it('writes one Cloud Logging JSON line with severity, message and time', () => {
    capture();
    log.warn('workflow event rejected', { businessId: 'b1', reason: 'invalid_transition' });
    expect(lines).toHaveLength(1);
    const [line] = parsed();
    expect(line).toMatchObject({ severity: 'WARNING', message: 'workflow event rejected', businessId: 'b1', reason: 'invalid_transition' });
    expect(typeof line!.time).toBe('string');
  });

  it('maps every level to a Cloud Logging severity', () => {
    capture();
    setLogLevel('debug');
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    setLogLevel(undefined);
    expect(parsed().map((l) => l.severity)).toEqual(['DEBUG', 'INFO', 'WARNING', 'ERROR']);
  });

  it('carries the context ids as labels, nested contexts adding to their parent', async () => {
    capture();
    await withLogContext({ requestId: 'r1', trace: 'projects/p/traces/abc' }, async () => {
      await Promise.resolve();
      withLogContext({ businessId: 'b1', messageId: 'm1' }, () => log.info('inbound burst failed'));
      log.info('after');
    });
    log.info('outside');
    const [inner, after, outside] = parsed();
    expect(inner!['logging.googleapis.com/labels']).toMatchObject({ requestId: 'r1', businessId: 'b1', messageId: 'm1' });
    expect(inner!['logging.googleapis.com/trace']).toBe('projects/p/traces/abc');
    expect(after!['logging.googleapis.com/labels']).not.toHaveProperty('businessId');
    expect(outside!['logging.googleapis.com/labels'] ?? {}).not.toHaveProperty('requestId');
  });

  it('reads the trace from X-Cloud-Trace-Context or traceparent', () => {
    expect(traceFromHeaders({ 'x-cloud-trace-context': '105445aa7843bc8bf206b12000100000/1;o=1' }, 'proj')).toBe(
      'projects/proj/traces/105445aa7843bc8bf206b12000100000',
    );
    expect(traceFromHeaders({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }, 'proj')).toBe(
      'projects/proj/traces/4bf92f3577b34da6a3ce929d0e0e4736',
    );
    expect(traceFromHeaders({ 'x-cloud-trace-context': 'abc/1' }, undefined)).toBeUndefined();
    expect(traceFromHeaders({}, 'proj')).toBeUndefined();
  });
});

describe('no customer content or secret in a log line', () => {
  it('redacts content and secret fields by name', () => {
    capture();
    log.error('inbound burst failed', {
      businessId: 'b1',
      text: CUSTOMER_TEXT,
      body: CUSTOMER_TEXT,
      caption: CUSTOMER_TEXT,
      content: CUSTOMER_TEXT,
      phone: PHONES[0],
      from: PHONES[1],
      to: PHONES[2],
      token: SECRETS[1],
      apiKey: SECRETS[2],
      password: PASSWORD,
      authorization: SECRETS[1],
      databaseUrl: SECRETS[0],
    } as never);
    const [line] = parsed();
    expect(line!.businessId).toBe('b1');
    for (const key of ['text', 'body', 'caption', 'content', 'phone', 'from', 'to', 'token', 'apiKey', 'password', 'authorization', 'databaseUrl']) {
      expect(line![key]).toBe('[redacted]');
    }
  });

  it('scrubs phones and secrets inside free strings such as error text', () => {
    capture();
    for (const value of [...PHONES, ...SECRETS]) log.error('send failed', { error: `provider said: ${value} rejected` });
    log.error('send failed', { error: new Error(`could not reach ${SECRETS[0]} for ${PHONES[0]}`) } as never);
    for (const line of lines) for (const bad of FORBIDDEN.slice(1)) expect(line).not.toContain(bad);
    expect(parsed()[0]!.error).toBe('provider said: [redacted] rejected');
  });

  it('keeps ids, UUIDs and short numbers', () => {
    capture();
    const id = '3f2b8a3e-1c4d-4e5f-9a6b-7c8d9e0f1a2b';
    log.info('publication run failed', { publicationId: id, attempt: 3, status: 'failed', error: 'HTTP 503 after 3 tries' });
    expect(parsed()[0]).toMatchObject({ publicationId: id, attempt: 3, error: 'HTTP 503 after 3 tries' });
  });

  it('keeps a model call token count (a number under a key ending in Tokens), but never a string there', () => {
    capture();
    log.info('model call', { inputTokens: 1200, outputTokens: 80, thinkingTokens: 310, accessTokens: SECRETS[1]!, token: 5 });
    expect(parsed()[0]).toMatchObject({ inputTokens: 1200, outputTokens: 80, thinkingTokens: 310, accessTokens: '[redacted]', token: '[redacted]' });
  });

  it('keeps a UUID whose digit groups look like a phone number, as a field, a label, and inside text', () => {
    capture();
    // "1-02987394" spans two groups: nine digits, which the phone rule alone would redact.
    const id = '845b451e-58c8-426a-bda1-02987394c2a6';
    log.warn('agent global budget reached', { businessId: id, agentTurnId: id, error: `turn ${id} stopped` });
    const [line] = parsed();
    expect(line).toMatchObject({ agentTurnId: id, error: `turn ${id} stopped` });
    expect(line!['logging.googleapis.com/labels']).toMatchObject({ businessId: id });
    // A phone right next to a UUID is still redacted.
    log.error('send failed', { error: `${id} to +972 50-123-4567` });
    expect(parsed()[1]!.error).toBe(`${id} to [redacted]`);
  });

  it('never logs objects or arrays, and cuts long strings', () => {
    capture();
    log.error('x', { error: 'a'.repeat(2000), detail: { text: CUSTOMER_TEXT } as never, list: [CUSTOMER_TEXT] as never });
    const [line] = parsed();
    expect((line!.error as string).length).toBeLessThanOrEqual(500);
    expect(lines[0]).not.toContain(CUSTOMER_TEXT);
  });

  it('redacts content put in the context too', () => {
    capture();
    withLogContext({ businessId: 'b1', text: CUSTOMER_TEXT } as never, () => log.info('x'));
    expect(lines[0]).not.toContain(CUSTOMER_TEXT);
  });
});

describe('one logger', () => {
  it('no code in src/ writes to the console except the logger', () => {
    const root = join(import.meta.dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !path.endsWith(join('shared', 'logger.ts'))) {
          readFileSync(path, 'utf8')
            .split('\n')
            .forEach((text, i) => {
              if (/\bconsole\.(log|info|warn|error|debug)\b/.test(text)) offenders.push(`${path}:${i + 1}`);
            });
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

// docs/observability.md, Error Reporting (WP-48) and Tracing (logs join traces).
describe('Error Reporting', () => {
  it('marks every ERROR line as a reported error event with the service context', () => {
    capture();
    setLogLabels({ process: 'worker' });
    log.error('publication run failed', { publicationId: 'p1', error: 'timeout' });
    log.warn('workflow event rejected');
    setLogLabels({});
    const [error, warn] = parsed();
    expect(error).toMatchObject({
      '@type': 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent',
      serviceContext: { service: 'worker', version: expect.any(String) },
    });
    expect(warn!['@type']).toBeUndefined();
  });

  it('adds a scrubbed stack trace when a field is an Error', () => {
    capture();
    log.error('inbound burst failed', { error: new Error(`reply to ${PHONES[0]}: ${CUSTOMER_TEXT}`) });
    const [line] = parsed();
    const stack = String(line!.stack_trace);
    expect(stack).toMatch(/^Error: reply to \[redacted\]/);
    expect(stack).toMatch(/\n\s+at .+logger\.test\.ts:\d+/);
    expect(stack).not.toContain(PHONES[0]);
  });
});

describe('logs join traces', () => {
  it('takes the trace and span ids from the active span', async () => {
    const telemetry = memoryTelemetry();
    const previous = process.env.GOOGLE_CLOUD_PROJECT;
    process.env.GOOGLE_CLOUD_PROJECT = 'postly-test';
    try {
      capture();
      await withSpan('job weekly-tick', { job: 'weekly-tick' }, async () => log.info('weekly tick done'));
      const [span] = telemetry.spans();
      const [line] = parsed();
      expect(line!['logging.googleapis.com/trace']).toBe(`projects/postly-test/traces/${span!.traceId}`);
      expect(line!['logging.googleapis.com/spanId']).toBe(span!.spanId);
      expect(line!['logging.googleapis.com/trace_sampled']).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
      else process.env.GOOGLE_CLOUD_PROJECT = previous;
      telemetry.stop();
    }
  });
});

// 2026-11-06, dev console: pg-boss emits some failures as plain objects (`{ ...error, message, stack,
// queue }`), and `String(error)` logged them as "[object Object]". An error keeps its message, code,
// cause and stack, scrubbed like any other string.
describe('error serialization', () => {
  it('logs an Error with its message, code, cause and stack', () => {
    capture();
    const cause = Object.assign(new Error('connect ETIMEDOUT 10.20.0.3:5432'), { code: 'ETIMEDOUT' });
    const error = Object.assign(new Error('Connection terminated due to connection timeout', { cause }), { code: '57P01' });
    log.error('pg-boss error', { error });
    const [line] = parsed();
    expect(line).toMatchObject({
      error: 'Connection terminated due to connection timeout',
      errorName: 'Error',
      errorCode: '57P01',
      errorCause: 'Error: connect ETIMEDOUT 10.20.0.3:5432',
      errorCauseCode: 'ETIMEDOUT',
    });
    const stack = String(line!.stack_trace);
    expect(stack).toMatch(/^Error: Connection terminated due to connection timeout\n\s+at /);
    expect(stack).toContain('Caused by: Error: connect ETIMEDOUT 10.20.0.3:5432');
  });

  it('keeps the stack on a warning too', () => {
    capture();
    log.warn('queue depth not read', { error: new Error('Database not opened') });
    const [line] = parsed();
    expect(line).toMatchObject({ error: 'Database not opened', errorName: 'Error' });
    expect(String(line!.stack_trace)).toMatch(/^Error: Database not opened\n\s+at /);
  });

  it('reads a plain error-like object as an error, never as [object Object]', () => {
    capture();
    const boss = { message: 'Connection terminated due to connection timeout', stack: 'Error: x\n    at fetch (manager.js:1:1)', code: 'ECONNRESET', queue: 'inbound-burst', worker: 'w1' };
    log.error('pg-boss error', { error: asError(boss) });
    log.error('pg-boss error', { error: boss as never });
    expect(lines).toHaveLength(2);
    for (const line of parsed()) {
      expect(line).toMatchObject({ error: 'Connection terminated due to connection timeout', errorCode: 'ECONNRESET' });
      expect(JSON.stringify(line)).not.toContain('[object Object]');
      expect(String(line.stack_trace)).toContain('at fetch (manager.js:1:1)');
    }
  });

  it('asError turns anything thrown into an Error', () => {
    const real = new Error('boom');
    expect(asError(real)).toBe(real);
    expect(asError('plain text').message).toBe('plain text');
    // An object's other fields are never logged (objects may hold content); only its code is kept.
    expect(asError({ code: 'X', text: CUSTOMER_TEXT }).message).toBe('non-error object thrown');
    expect((asError({ code: 'X' }) as Error & { code?: unknown }).code).toBe('X');
    expect(asError(undefined).message).toBe('undefined');
  });

  it('scrubs the message, code and cause of an error', () => {
    capture();
    const cause = new Error(`reply to ${PHONES[0]} failed: ${SECRETS[0]}`);
    log.error('send failed', { error: Object.assign(new Error(`for ${PHONES[1]}`, { cause }), { code: SECRETS[2] }) });
    const text = lines.join('\n');
    for (const secret of FORBIDDEN) expect(text).not.toContain(secret);
    expect(text).not.toContain(PASSWORD);
  });
});

// docs/observability.md, "Following one message": the correlation ids, and LOG_LEVEL.
describe('correlation and log level', () => {
  it('carries correlationId and agentTurnId as labels', () => {
    capture();
    withLogContext({ businessId: 'b1', correlationId: 'm1', agentTurnId: 't1' }, () => log.info('agent tool call'));
    const [line] = parsed();
    expect(line!['logging.googleapis.com/labels']).toMatchObject({ businessId: 'b1', correlationId: 'm1', agentTurnId: 't1' });
    expect(line).not.toHaveProperty('correlationId');
  });

  it('addLogContext adds ids to the current scope only', async () => {
    capture();
    await withLogContext({ businessId: 'b1' }, async () => {
      addLogContext({ agentTurnId: 't1' });
      await Promise.resolve();
      log.info('inside');
    });
    log.info('outside');
    addLogContext({ agentTurnId: 'nowhere' });
    log.info('no scope');
    const [inside, outside, none] = parsed().map((l) => l['logging.googleapis.com/labels'] as Record<string, string> | undefined);
    expect(inside).toMatchObject({ businessId: 'b1', agentTurnId: 't1' });
    expect(outside?.agentTurnId).toBeUndefined();
    expect(none?.agentTurnId).toBeUndefined();
  });

  it('writes nothing below the log level; info by default', () => {
    capture();
    try {
      log.debug('hidden by default');
      log.info('shown');
      setLogLevel('warn');
      log.info('hidden');
      log.warn('warned');
      log.error('failed');
      setLogLevel('debug');
      log.debug('debugged');
    } finally {
      setLogLevel(undefined);
    }
    expect(parsed().map((l) => l.message)).toEqual(['shown', 'warned', 'failed', 'debugged']);
  });
});
