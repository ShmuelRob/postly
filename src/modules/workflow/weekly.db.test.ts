import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { BusinessProfile } from '../../contracts/business-profile.js';
import { createDatabase } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createWeeklyUpdates, createWorkflow, weeklyCopy as copy, type WeeklyDeps } from './index.js';

// WP-31 review follow-ups (human-review-queue.md item 20), fixed in WP-32: the reminder is sent at
// most once, the cutoff closes a week never reminded, any planning error reaches the console, and a
// failure before an update is recognized gets a neutral reply.

const db = createDatabase(inject('databaseUrls'), { max: 4 });
afterAll(() => db.close());
const workflow = createWorkflow(db, { rejected: () => {} });

/** Local Jerusalem time (UTC+2 in November). */
const at = (local: string) => new Date(`${local}+02:00`);

const profile = BusinessProfile.parse({
  name: 'מאפייה',
  field: 'מאפייה',
  mainProducts: ['חלות'],
  location: { city: 'חולון', address: 'הרצל 12', hours: '7-19', fulfillment: ['pickup'] },
  differentiator: 'בצק',
  channels: ['instagram'],
  style: 'warm',
  approverPhone: '+972501234567',
});

async function activeBusiness() {
  const id = randomUUID();
  const phone = `+9725${Math.floor(1e7 + Math.random() * 9e7)}`;
  await db.withBusiness('workflow', id, async (tx) => {
    await tx.insert(schema.business).values({ id, name: 'מאפייה', status: 'active', approverPhone: phone, profile: { ...profile, approverPhone: phone } });
    await tx.insert(schema.conversationState).values({ businessId: id, step: 'idle' });
  });
  return { id, phone };
}

function setup(model: WeeklyDeps['model'], now = at('2026-11-01T14:00:00')) {
  const sent: { kind: string; text?: string }[] = [];
  const weekly = createWeeklyUpdates({
    db,
    workflow,
    messaging: {
      sendText: async (_b, r) => void sent.push({ kind: 'text', text: r.text }),
      sendTemplate: async () => {
        // Slow enough that two ticks overlap.
        await new Promise((r) => setTimeout(r, 30));
        sent.push({ kind: 'template' });
      },
    },
    model,
    now: () => now,
  });
  return { weekly, sent };
}

const weeks = (b: string) => db.withBusiness('workflow', b, (tx) => tx.select().from(schema.weeklyUpdate));
const noModel: WeeklyDeps['model'] = { run: async () => Promise.reject(new Error('no model in this test')) };
const burst = (businessId: string, from: string, text: string) => ({ businessId, from, text, messages: [{ content: { kind: 'text' }, mediaAssetIds: [] }] });

describe('weekly update follow-ups', { timeout: 30_000 }, () => {
  it('(a) sends the reminder once when two ticks overlap', async () => {
    const { id } = await activeBusiness();
    const { weekly, sent } = setup(noModel);
    await weekly.tickBusiness(id, at('2026-11-01T08:00:00'));
    await Promise.all([weekly.tickBusiness(id, at('2026-11-02T10:00:00')), weekly.tickBusiness(id, at('2026-11-02T10:00:00'))]);
    await weekly.tickBusiness(id, at('2026-11-02T11:00:00'));
    expect(sent.filter((m) => m.kind === 'template')).toHaveLength(1);
    expect((await weeks(id))[0]?.status).toBe('reminded');
  });

  it('(b) closes a week still awaiting at the Thursday cutoff', async () => {
    const { id } = await activeBusiness();
    const { weekly, sent } = setup(noModel);
    // Activated on Thursday after the cutoff: the first tick creates the week and must also close it.
    await weekly.tickBusiness(id, at('2026-11-05T12:30:00'));
    expect((await weeks(id)).map((w) => w.status)).toEqual(['skipped']);
    expect(sent).toEqual([]);
  });

  it('(d) routes any planning error to the console and moves the week to needs_review', async () => {
    const { id, phone } = await activeBusiness();
    const model: WeeklyDeps['model'] = {
      run: async (_b, task) => {
        if (task === 'intent_detection') return { intent: 'weekly_update', confidence: 0.9 } as never;
        throw new TypeError('unexpected bug');
      },
    };
    const { weekly, sent } = setup(model);
    await weekly.handle(burst(id, phone, 'השבוע מבצע על חלות'));
    expect((await weeks(id)).map((w) => w.status)).toEqual(['needs_review']);
    const items = await db.withSystem('console', (tx) => tx.select().from(schema.consoleItem).where(eq(schema.consoleItem.businessId, id)));
    expect(items.map((i) => i.kind)).toEqual(['extraction_failed']);
    expect(sent.map((m) => m.text)).toEqual([copy.updateNeedsReview]);
  });

  it('(e) answers a failed intent with a neutral handoff line, not "update received"', async () => {
    const { id, phone } = await activeBusiness();
    const failed = Object.assign(new Error('intent_detection failed'), { name: 'ModelTaskFailedError' });
    const { weekly, sent } = setup({ run: async () => Promise.reject(failed) });
    await weekly.handle(burst(id, phone, 'היי, מה שלומך'));
    expect(sent.map((m) => m.text)).toEqual([copy.handoffNeutral]);
    const [state] = await db.withBusiness('workflow', id, (tx) => tx.select().from(schema.conversationState));
    expect(state?.handoffAt).not.toBeNull();
  });

  it('(c) a second update while drafting gets a reply and changes nothing', async () => {
    const { id, phone } = await activeBusiness();
    await db.withBusiness('workflow', id, (tx) => tx.update(schema.conversationState).set({ step: 'processing_update' }).where(eq(schema.conversationState.businessId, id)));
    const { weekly, sent } = setup({ run: async () => ({ intent: 'weekly_update', confidence: 0.9 }) as never });
    await weekly.handle(burst(id, phone, 'עוד משהו לשבוע הזה'));
    expect(sent.map((m) => m.text)).toEqual([copy.stillWorking]);
    expect(await weeks(id)).toEqual([]);
  });

  it('(c) a second update after the week was planned counts for next week', async () => {
    const { id, phone } = await activeBusiness();
    const model: WeeklyDeps['model'] = {
      run: async (_b, task) =>
        (({
          intent_detection: { intent: 'weekly_update', confidence: 0.9 },
          fact_extraction: { facts: [], missingDetails: [] },
          weekly_planning: { posts: [0, 1, 2].map((i) => ({ topic: `פוסט ${i}`, contentType: 'products', format: 'single', factIds: [], mediaAssetIds: [], brief: 'b' })) },
        }) as Record<string, unknown>)[task] as never,
    };
    const { weekly, sent } = setup(model);
    await weekly.handle(burst(id, phone, 'העדכון של השבוע'));
    // The schedule was confirmed (WP-34) and the conversation is idle again.
    await db.withBusiness('workflow', id, (tx) => tx.update(schema.conversationState).set({ step: 'idle' }).where(eq(schema.conversationState.businessId, id)));
    await weekly.handle(burst(id, phone, 'ועוד עדכון'));
    expect(sent.map((m) => m.text)).toEqual([copy.updateReceived(3), copy.updateCountsForNextWeek(3)]);
    expect((await weeks(id)).map((w) => [w.weekStart, w.status]).sort()).toEqual([
      ['2026-11-01', 'planned'],
      ['2026-11-08', 'planned'],
    ]);
    // A third one finds next week taken too.
    await db.withBusiness('workflow', id, (tx) => tx.update(schema.conversationState).set({ step: 'idle' }).where(eq(schema.conversationState.businessId, id)));
    await weekly.handle(burst(id, phone, 'ועוד אחד'));
    expect(sent.at(-1)?.text).toBe(copy.nextWeekAlreadyIn);
  });
});
