import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { log, setLogSink, withLogContext, traceFromHeaders } from './logger.js';

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
const SECRETS = [
  'postgres://app_workflow:s3cr3t-pa55@10.0.0.3:5432/postly',
  'Bearer ya29.a0AfH6SMBx7example-token-value',
  'sk_test_51HxYz0123456789abcdefghijklmnopqrstuv',
  'AIzaSyD-1234567890abcdefghijklmnopqrstuvw',
];
const FORBIDDEN = [CUSTOMER_TEXT, ...PHONES, 's3cr3t-pa55', 'ya29.a0AfH6SMBx7example-token-value', SECRETS[2]!, SECRETS[3]!];

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
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
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
      password: 's3cr3t-pa55',
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
