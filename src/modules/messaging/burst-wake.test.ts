import { describe, expect, it } from 'vitest';
import { INBOUND_BURST_JOB, jobBurstWake } from './index.js';

describe('the inbound-burst wake-up job (technical-design.md, Onboarding flow, durable bursts)', () => {
  it('sends one job keyed by business and sender, due at the requested time', async () => {
    const sent: unknown[] = [];
    const wake = jobBurstWake({ send: async (...args: unknown[]) => void sent.push(args) });
    const at = new Date('2026-11-04T10:00:20Z');
    await wake.request('b-1', '+972501234567', at);
    expect(sent).toEqual([[INBOUND_BURST_JOB, { businessId: 'b-1', from: '+972501234567' }, { startAfter: at, singletonKey: 'b-1:+972501234567' }]]);
  });

  it('carries the correlationId of the message that asked for it (docs/observability.md, Following one message)', async () => {
    const sent: unknown[] = [];
    const wake = jobBurstWake({ send: async (...args: unknown[]) => void sent.push(args) });
    const at = new Date('2026-11-04T10:00:20Z');
    await wake.request('b-1', '+972501234567', at, 'm-1');
    expect(sent).toEqual([[INBOUND_BURST_JOB, { businessId: 'b-1', from: '+972501234567', correlationId: 'm-1' }, { startAfter: at, singletonKey: 'b-1:+972501234567' }]]);
  });
});
