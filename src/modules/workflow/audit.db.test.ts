import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { expectDbError } from '../../../test/db/rows.js';
import { createDatabase } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { withLogContext } from '../../shared/logger.js';
import { createWorkflow } from './index.js';

// WP-46: every applied and every rejected workflow event leaves one workflow_event row, written in the
// same transaction (database-schema.md, "workflow_event").

const db = createDatabase(inject('databaseUrls'), { max: 4 });
afterAll(() => db.close());
const workflow = createWorkflow(db, { rejected: () => {} });

async function newBusiness() {
  const id = randomUUID();
  await db.withBusiness('workflow', id, async (tx) => {
    await tx.insert(schema.business).values({ id, name: 'b', status: 'active', approverPhone: `+9725${Math.floor(Math.random() * 1e8)}` });
    await tx.insert(schema.conversationState).values({ businessId: id, step: 'idle' });
  });
  return id;
}

const auditOf = (businessId: string) =>
  db.withSystem('console', (tx) =>
    tx.select().from(schema.workflowEvent).where(eq(schema.workflowEvent.businessId, businessId)).orderBy(schema.workflowEvent.createdAt),
  );

describe('workflow audit trail', () => {
  it('records an applied event with its states, guard result, actor and correlation id', async () => {
    const b = await newBusiness();
    const correlationId = randomUUID();
    await workflow.apply(b, { machine: 'conversation', id: b, event: 'UPDATE_RECEIVED', source: 'inbound', guard: async () => null, correlationId });
    expect(await auditOf(b)).toEqual([
      expect.objectContaining({
        businessId: b,
        machine: 'conversation',
        rowId: b,
        event: 'UPDATE_RECEIVED',
        source: 'inbound',
        role: 'workflow',
        actor: 'owner',
        outcome: 'applied',
        fromState: 'idle',
        toState: 'processing_update',
        guard: 'passed',
        reason: null,
        detail: null,
        correlationId,
      }),
    ]);
  });

  // docs/observability.md, "Following one message": the inbound message's correlationId reaches the audit row.
  it('takes the correlation id from the log context when the caller passes none, and the caller wins over it', async () => {
    const b = await newBusiness();
    const fromContext = randomUUID();
    const explicit = randomUUID();
    await withLogContext({ correlationId: fromContext }, async () => {
      await workflow.apply(b, { machine: 'conversation', id: b, event: 'UPDATE_RECEIVED', source: 'inbound' });
      await workflow.apply(b, { machine: 'conversation', id: b, event: 'QUESTION_ASKED', source: 'system', correlationId: explicit });
    });
    await workflow.apply(b, { machine: 'conversation', id: b, event: 'SCHEDULE_CONFIRMED', source: 'system' });
    expect((await auditOf(b)).map((r) => r.correlationId)).toEqual([fromContext, explicit, null]);
  });

  it('logs every applied event with its machine, states and event, and no content', async () => {
    const b = await newBusiness();
    const applied: unknown[] = [];
    const logged = createWorkflow(db, { rejected: () => {}, applied: (entry) => void applied.push(entry) });
    await logged.apply(b, { machine: 'conversation', id: b, event: 'UPDATE_RECEIVED', source: 'inbound' });
    await logged.apply(b, { machine: 'conversation', id: b, event: 'SCHEDULE_CONFIRMED', source: 'system' });
    expect(applied).toEqual([{ businessId: b, machine: 'conversation', id: b, event: 'UPDATE_RECEIVED', source: 'inbound', from: 'idle', to: 'processing_update' }]);
  });

  it('records each kind of rejection', async () => {
    const b = await newBusiness();
    await workflow.apply(b, { machine: 'conversation', id: b, event: 'SCHEDULE_CONFIRMED', source: 'system' });
    await workflow.apply(b, { machine: 'conversation', id: b, event: 'UPDATE_RECEIVED', source: 'console', actor: 'team:dana', guard: async () => 'not_approver' });
    await workflow.apply(b, { machine: 'post', id: randomUUID(), event: 'DRAFT_READY', source: 'system' });
    await workflow.startHandoff(b);
    await workflow.apply(b, { machine: 'conversation', id: b, event: 'UPDATE_RECEIVED', source: 'inbound' });
    const rows = await auditOf(b);
    expect(rows.map(({ outcome, reason, fromState, toState, guard, detail, actor }) => ({ outcome, reason, fromState, toState, guard, detail, actor }))).toEqual([
      { outcome: 'rejected', reason: 'invalid_transition', fromState: 'idle', toState: null, guard: null, detail: null, actor: 'system' },
      { outcome: 'rejected', reason: 'guard_failed', fromState: 'idle', toState: null, guard: 'blocked', detail: 'not_approver', actor: 'team:dana' },
      { outcome: 'rejected', reason: 'not_found', fromState: null, toState: null, guard: null, detail: null, actor: 'system' },
      { outcome: 'rejected', reason: 'handoff', fromState: null, toState: null, guard: null, detail: null, actor: 'owner' },
    ]);
  });

  it('writes nothing when the transaction fails', async () => {
    const b = await newBusiness();
    const failing = workflow.apply(b, {
      machine: 'conversation',
      id: b,
      event: 'UPDATE_RECEIVED',
      source: 'inbound',
      guard: async () => {
        throw new Error('boom');
      },
    });
    await expect(failing).rejects.toThrow('boom');
    expect(await auditOf(b)).toEqual([]);
  });

  it('a business role cannot write an audit row for another business', async () => {
    const a = await newBusiness();
    const other = await newBusiness();
    const insert = db.withBusiness('workflow', a, (tx) =>
      tx.insert(schema.workflowEvent).values({
        businessId: other,
        machine: 'conversation',
        rowId: other,
        event: 'X',
        source: 'system',
        role: 'workflow',
        actor: 'system',
        outcome: 'applied',
      }),
    );
    await expectDbError(insert, /row-level security/);
  });

  it('keeps the audit rows after the business is erased', async () => {
    const b = await newBusiness();
    await workflow.apply(b, { machine: 'conversation', id: b, event: 'UPDATE_RECEIVED', source: 'inbound' });
    await db.withSystem('console', (tx) =>
      tx.update(schema.business).set({ status: 'cancelled', archiveAfter: sql`now() - interval '1 day'` }).where(eq(schema.business.id, b)),
    );
    await db.withBusiness('deletion', b, (tx) =>
      tx.delete(schema.business).where(and(eq(schema.business.id, b), eq(schema.business.status, 'cancelled'))),
    );
    const gone = await db.withSystem('console', (tx) => tx.select().from(schema.business).where(eq(schema.business.id, b)));
    expect(gone).toEqual([]);
    expect(await auditOf(b)).toHaveLength(1);
  });
});
