import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createDatabase } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createWorkflow, type RejectionLog } from './index.js';

const db = createDatabase(inject('databaseUrls'), { max: 4 });
afterAll(() => db.close());

const logged: RejectionLog[] = [];
const workflow = createWorkflow(db, { rejected: (entry) => logged.push(entry) });

async function newBusiness(step: 'intro' | 'idle' = 'idle', status: 'onboarding' | 'active' = 'active') {
  const id = randomUUID();
  await db.withSystem('console', async (tx) => {
    await tx.insert(schema.business).values({ id, name: 'b', status, approverPhone: `+9725${Math.floor(Math.random() * 1e8)}` });
    await tx.insert(schema.conversationState).values({ businessId: id, step });
  });
  return id;
}

const stepOf = (id: string) =>
  db.withBusiness(id, async (tx) => (await tx.select().from(schema.conversationState).where(eq(schema.conversationState.businessId, id)))[0]);

beforeEach(() => void (logged.length = 0));

describe('apply', () => {
  it('applies a valid transition and persists the new state', async () => {
    const b = await newBusiness();
    const result = await workflow.apply(b, { machine: 'conversation', id: b, event: 'UPDATE_RECEIVED', source: 'inbound' });
    expect(result).toEqual({ ok: true, from: 'idle', to: 'processing_update' });
    expect((await stepOf(b))?.step).toBe('processing_update');
    expect(logged).toEqual([]);
  });

  it('rejects and logs an invalid transition without changing state', async () => {
    const b = await newBusiness();
    const result = await workflow.apply(b, { machine: 'conversation', id: b, event: 'SCHEDULE_CONFIRMED', source: 'inbound' });
    expect(result).toEqual({ ok: false, reason: 'invalid_transition', from: 'idle' });
    expect((await stepOf(b))?.step).toBe('idle');
    expect(logged).toEqual([
      { businessId: b, machine: 'conversation', id: b, event: 'SCHEDULE_CONFIRMED', source: 'inbound', reason: 'invalid_transition', from: 'idle' },
    ]);
  });

  it('rejects an event of the other step machine', async () => {
    const b = await newBusiness('intro', 'onboarding');
    const result = await workflow.apply(b, { machine: 'conversation', id: b, event: 'UPDATE_RECEIVED', source: 'inbound' });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_transition', from: 'intro' });
    expect(await workflow.apply(b, { machine: 'onboarding', id: b, event: 'INTRO_SENT', source: 'system' })).toMatchObject({ ok: true, to: 'profile_questions' });
  });

  it('keeps the state when a guard blocks, and logs the reason', async () => {
    const b = await newBusiness();
    const result = await workflow.apply(b, {
      machine: 'conversation',
      id: b,
      event: 'UPDATE_RECEIVED',
      source: 'inbound',
      guard: async () => 'not the approver number',
    });
    expect(result).toEqual({ ok: false, reason: 'guard_failed', from: 'idle', detail: 'not the approver number' });
    expect((await stepOf(b))?.step).toBe('idle');
    expect(logged[0]).toMatchObject({ reason: 'guard_failed', detail: 'not the approver number' });
  });

  it('rolls back everything the guard wrote when the transaction fails', async () => {
    const b = await newBusiness();
    const failing = workflow.apply(b, {
      machine: 'conversation',
      id: b,
      event: 'UPDATE_RECEIVED',
      source: 'inbound',
      guard: async (tx) => {
        await tx.insert(schema.consoleItem).values({ businessId: b, kind: 'handoff' });
        throw new Error('boom');
      },
    });
    await expect(failing).rejects.toThrow('boom');
    const items = await db.withBusiness(b, (tx) => tx.select().from(schema.consoleItem));
    expect(items).toEqual([]);
    expect((await stepOf(b))?.step).toBe('idle');
  });

  it("does not see another business's row", async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    expect(await workflow.apply(a, { machine: 'conversation', id: b, event: 'UPDATE_RECEIVED', source: 'system' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect((await stepOf(b))?.step).toBe('idle');
  });

  it('serializes concurrent events on one row', async () => {
    const b = await newBusiness();
    const event = { machine: 'conversation', id: b, event: 'UPDATE_RECEIVED', source: 'system' } as const;
    const results = await Promise.all([workflow.apply(b, event), workflow.apply(b, event)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'invalid_transition', from: 'processing_update' }]);
  });
});

describe('handoff', () => {
  it('stops auto replies and inbound events until cleared, then resumes the same step', async () => {
    const b = await newBusiness();
    await workflow.startHandoff(b, { reason: 'owner asked for a person' });
    await workflow.startHandoff(b);
    expect(await workflow.mayAutoReply(b)).toBe(false);
    expect(await workflow.apply(b, { machine: 'conversation', id: b, event: 'UPDATE_RECEIVED', source: 'inbound' })).toEqual({
      ok: false,
      reason: 'handoff',
    });
    expect(logged[0]).toMatchObject({ reason: 'handoff', source: 'inbound' });
    const open = await db.withBusiness(b, (tx) => tx.select().from(schema.consoleItem));
    expect(open).toMatchObject([{ kind: 'handoff', status: 'open', details: { reason: 'owner asked for a person' } }]);

    await workflow.clearHandoff(b);
    expect(await workflow.mayAutoReply(b)).toBe(true);
    expect((await stepOf(b))?.step).toBe('idle');
    const items = await db.withBusiness(b, (tx) => tx.select().from(schema.consoleItem));
    expect(items).toMatchObject([{ kind: 'handoff', status: 'resolved' }]);
    expect(await workflow.apply(b, { machine: 'conversation', id: b, event: 'UPDATE_RECEIVED', source: 'inbound' })).toMatchObject({ ok: true });
  });

  it('still applies system events while handed off', async () => {
    const b = await newBusiness();
    await workflow.startHandoff(b);
    expect(await workflow.apply(b, { machine: 'conversation', id: b, event: 'UPDATE_RECEIVED', source: 'console' })).toMatchObject({ ok: true });
  });
});

describe('pause', () => {
  it('reports the business pause from the business machine and the global pause from system_control', async () => {
    const b = await newBusiness();
    expect(await workflow.pauseState(b)).toEqual({ global: false, business: false });
    expect(await workflow.apply(b, { machine: 'business', id: b, event: 'PAUSE', source: 'console' })).toMatchObject({ ok: true, to: 'paused' });
    expect(await workflow.pauseState(b)).toEqual({ global: false, business: true });

    await workflow.setGlobalPause(true, 'team@postly', 'provider outage');
    try {
      expect(await workflow.pauseState(b)).toEqual({ global: true, business: true });
      const [row] = await db.withSystem('console', (tx) => tx.select().from(schema.systemControl));
      expect(row).toMatchObject({ publishingPaused: true, pausedBy: 'team@postly', pausedReason: 'provider outage' });
    } finally {
      await workflow.setGlobalPause(false, 'team@postly');
    }
    expect(await workflow.pauseState(b)).toEqual({ global: false, business: true });
  });
});
