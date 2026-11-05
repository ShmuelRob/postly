import { afterEach, expect, it } from 'vitest';
import { setLogSink } from '../../shared/logger.js';
import { consoleLogger } from './workflow.js';

afterEach(() => setLogSink(undefined));

it('logs a rejected event with its source state as fromState, not redacted', () => {
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  consoleLogger.rejected({ businessId: 'b1', machine: 'post', id: 'p1', event: 'approve', source: 'inbound', reason: 'invalid_transition', from: 'draft' } as never);
  const line = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(line).toMatchObject({ severity: 'WARNING', message: 'workflow event rejected', fromState: 'draft', reason: 'invalid_transition', event: 'approve' });
  expect(line).not.toHaveProperty('from');
});
