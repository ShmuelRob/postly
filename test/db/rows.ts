import { randomUUID } from 'node:crypto';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { expect } from 'vitest';
import { BUSINESS_ROLES, type BusinessRole, type Database } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { roleWith } from './grant-matrix.js';

// Shared seed data for the db tests: one valid row per business-owned table, inserted through the
// business role the grant matrix allows to insert it.

export const tableName = (t: PgTable) => getTableConfig(t).name;

/** One valid row per business-owned table (except business), in insert order, for business `b`. */
export function rowsFor(b: string): [PgTable, Record<string, unknown>][] {
  const k = () => randomUUID();
  const [channel, msg, media, rule, week, post, version, approval, publication, sub, run, item] = Array.from({ length: 12 }, k);
  const tag = k();
  return [
    [schema.channelConnection, { id: channel, businessId: b, network: 'instagram', provider: 'zernio' }],
    [schema.conversationState, { businessId: b }],
    [
      schema.message,
      {
        id: msg,
        businessId: b,
        direction: 'inbound',
        kind: 'button_reply',
        provider: 'sim',
        providerMessageId: tag,
        fromPhone: '+972501234560',
        toPhone: '+972501234561',
      },
    ],
    [schema.mediaAsset, { id: media, businessId: b, kind: 'photo', source: 'owner', storagePath: `p/${tag}`, mimeType: 'image/jpeg', sha256: 'x' }],
    [schema.preferenceRule, { id: rule, businessId: b, scope: 'caption', rule: 'r', sourceMessageId: msg }],
    [schema.weeklyUpdate, { id: week, businessId: b, weekStart: '2026-11-01' }],
    [schema.post, { id: post, businessId: b, weeklyUpdateId: week, position: 1, format: 'single', plan: {} }],
    [
      schema.postVersion,
      {
        id: version,
        businessId: b,
        postId: post,
        versionNumber: 1,
        captions: {},
        renderedMedia: {},
        factSources: [],
        factCheckPassed: true,
        contentHash: 'h',
      },
    ],
    [
      schema.approval,
      {
        id: approval,
        businessId: b,
        postId: post,
        postVersionId: version,
        approvedVersionHash: 'h',
        approverPhone: '+972501234560',
        messageId: msg,
        approvedAt: new Date(),
      },
    ],
    [
      schema.publication,
      {
        id: publication,
        businessId: b,
        postId: post,
        approvalId: approval,
        approvedVersionHash: 'h',
        channelConnectionId: channel,
        network: 'instagram',
        scheduledFor: new Date(),
      },
    ],
    [schema.subscription, { id: sub, businessId: b, plan: 'basic', provider: 'placeholder' }],
    [schema.modelRun, { id: run, businessId: b, task: 'fact_extraction', promptVersion: 1, provider: 'sim', model: 'm', input: {}, valid: true }],
    [schema.consoleItem, { id: item, businessId: b, kind: 'handoff' }],
    [schema.workflowEvent, { id: k(), businessId: b, machine: 'conversation', rowId: b, event: 'UPDATE_RECEIVED', source: 'inbound', role: 'workflow', actor: 'owner', outcome: 'applied' }],
    [schema.agentTurn, { id: k(), businessId: b, agent: 'weekly', trigger: { kind: 'event', name: 'test' } }],
  ];
}

/** The business role that may insert into table, per the grant matrix. */
export function inserter(table: string): BusinessRole {
  const role = roleWith(table, 'INSERT', BUSINESS_ROLES);
  if (!role) throw new Error(`no business role inserts into ${table}`);
  return role as BusinessRole;
}

let phone = 0;
/** A new business, created the way database-schema.md says: by workflow, in the new id's context. */
export async function newBusiness(db: Database): Promise<string> {
  const id = randomUUID();
  const approverPhone = `+97250${Date.now() % 1e6}${phone++}`;
  await db.withBusiness('workflow', id, (tx) => tx.insert(schema.business).values({ id, name: `b-${id}`, approverPhone }));
  return id;
}

/** A business and its rows: the key of its row in each business-owned table, and the rows. */
export type Seeded = { id: string; keys: Map<string, string>; rows: Map<string, Record<string, unknown>> };

export async function seed(db: Database): Promise<Seeded> {
  const id = await newBusiness(db);
  const keys = new Map<string, string>([['business', id]]);
  const rows = new Map<string, Record<string, unknown>>();
  for (const [table, row] of rowsFor(id)) {
    const name = tableName(table);
    await db.withBusiness(inserter(name), id, (tx) => tx.insert(table).values(row));
    keys.set(name, String(row[name === 'conversation_state' ? 'businessId' : 'id']));
    rows.set(name, row);
  }
  return { id, keys, rows };
}

/** The Postgres message of a failed query; Drizzle wraps the error, with the message in cause. */
export async function dbError(run: Promise<unknown>): Promise<string> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  const cause = (error as Error).cause;
  return cause instanceof Error ? cause.message : (error as Error).message;
}

export async function expectDbError(run: Promise<unknown>, pattern: RegExp) {
  expect(await dbError(run)).toMatch(pattern);
}
