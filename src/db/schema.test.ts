import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { MODEL_TASK_NAMES } from '../contracts/model-tasks.js';
import {
  CONVERSATION_STEP_VALUES,
  businessMachine,
  channelConnectionMachine,
  postMachine,
  publicationMachine,
  subscriptionMachine,
  weeklyUpdateMachine,
} from '../contracts/state-machines/index.js';
import * as schema from './schema.js';

const tables = Object.values(schema as Record<string, unknown>)
  .filter((value): value is PgTable => value instanceof PgTable)
  .map((table) => getTableConfig(table));

const byName = (name: string) => {
  const config = tables.find((t) => t.name === name);
  if (!config) throw new Error(`table ${name} not found`);
  return config;
};

const columnNames = (name: string) => byName(name).columns.map((c) => c.name);

const uniqueSets = (name: string) => {
  const config = byName(name);
  return [
    ...config.columns.filter((c) => c.isUnique || c.primary).map((c) => [c.name]),
    ...config.uniqueConstraints.map((u) => u.columns.map((c) => c.name)),
    ...config.primaryKeys.map((pk) => pk.columns.map((c) => c.name)),
  ].map((cols) => [...cols].sort().join(','));
};

describe('tables', () => {
  it('has exactly the tables in database-schema.md', () => {
    expect(tables.map((t) => t.name).sort()).toEqual(
      [
        'business',
        'channel_connection',
        'conversation_state',
        'message',
        'media_asset',
        'preference_rule',
        'weekly_update',
        'post',
        'post_version',
        'approval',
        'publication',
        'subscription',
        'model_run',
        'console_item',
        'model_task_config',
        'prompt_template',
        'system_control',
      ].sort(),
    );
  });
});

describe('tenant isolation', () => {
  const businessOwned = tables.filter((t) => t.columns.some((c) => c.name === 'business_id'));

  it('covers every table except the system tables', () => {
    expect(
      tables
        .filter((t) => !businessOwned.includes(t))
        .map((t) => t.name)
        .sort(),
    ).toEqual(['business', 'model_task_config', 'prompt_template', 'system_control']);
  });

  it.each([...businessOwned.map((t) => t.name), 'business'])('%s has RLS and a tenant policy for app_user', (name) => {
    const config = byName(name);
    expect(config.enableRLS || config.policies.length > 0).toBe(true);
    const policy = config.policies.find((p) => p.name === 'tenant_isolation');
    expect(policy).toBeDefined();
    expect(policy?.for ?? 'all').toBe('all');
    expect(policy?.to).toEqual([schema.appUser]);
    expect(policy?.using).toBeDefined();
    expect(policy?.withCheck).toBeDefined();
  });

  // BYPASSRLS for app_system is granted in a hand-written, human-reviewed migration.
  it('declares app_user and app_system as roles managed outside Drizzle', () => {
    expect(schema.appUser.name).toBe('app_user');
    expect(schema.appSystem.name).toBe('app_system');
    // `_existing` is how Drizzle marks a role it must not create.
    const isExisting = (role: object) => (role as { _existing?: boolean })._existing;
    expect(isExisting(schema.appUser)).toBe(true);
    expect(isExisting(schema.appSystem)).toBe(true);
  });
});

describe('enums', () => {
  const pairs: Array<[{ enumName: string; enumValues: readonly string[] }, readonly string[]]> = [
    [schema.businessStatus, businessMachine.states],
    [schema.weeklyUpdateStatus, weeklyUpdateMachine.states],
    [schema.postStatus, postMachine.states],
    [schema.publicationStatus, publicationMachine.states],
    [schema.channelConnectionStatus, channelConnectionMachine.states],
    [schema.subscriptionStatus, subscriptionMachine.states],
    [schema.conversationStep, CONVERSATION_STEP_VALUES],
    [schema.modelTask, MODEL_TASK_NAMES],
  ];

  it.each(pairs.map(([pgEnum, values]) => [pgEnum.enumName, pgEnum.enumValues, values] as const))(
    '%s matches its contract',
    (_name, enumValues, values) => {
      expect(enumValues).toEqual([...values]);
    },
  );
});

describe('integrity rules', () => {
  it.each([
    ['business', 'approver_phone'],
    ['channel_connection', 'business_id,network'],
    ['conversation_state', 'business_id'],
    ['message', 'provider,provider_message_id'],
    ['weekly_update', 'business_id,week_start'],
    ['post_version', 'post_id,version_number'],
    ['approval', 'message_id'],
    ['publication', 'approval_id,network'],
    ['subscription', 'business_id'],
    ['prompt_template', 'task,version'],
    ['model_task_config', 'task'],
  ])('%s is unique on %s', (table, cols) => {
    expect(uniqueSets(table)).toContain(cols);
  });

  it('requires every publication to reference an approval and its hash', () => {
    const cols = byName('publication').columns;
    expect(cols.find((c) => c.name === 'approval_id')?.notNull).toBe(true);
    expect(cols.find((c) => c.name === 'approved_version_hash')?.notNull).toBe(true);
  });

  it('requires approvals to record the hash and approver phone', () => {
    const cols = byName('approval').columns;
    for (const name of ['post_version_id', 'approved_version_hash', 'approver_phone', 'message_id']) {
      expect(cols.find((c) => c.name === name)?.notNull, name).toBe(true);
    }
  });

  it('requires every post version to carry a content hash', () => {
    expect(byName('post_version').columns.find((c) => c.name === 'content_hash')?.notNull).toBe(true);
  });

  it('keeps business_id nullable only where unknown numbers or example runs need it', () => {
    const nullable = tables
      .filter((t) => t.columns.some((c) => c.name === 'business_id' && !c.notNull))
      .map((t) => t.name)
      .sort();
    expect(nullable).toEqual(['console_item', 'message', 'model_run']);
  });

  it('stores no payment card fields', () => {
    expect(columnNames('subscription').filter((c) => /card|cvv|pan/.test(c))).toEqual([]);
  });
});
