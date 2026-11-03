import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { BusinessProfile } from '../../contracts/business-profile.js';
import { createDatabase } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createDrafts, createWorkflow, draftsCopy as copy, type DraftsDeps } from './index.js';

// Review of PR #43, item 6: an error while drafting that is not a model failure must not leave the
// conversation waiting in processing_update.

const db = createDatabase(inject('databaseUrls'), { max: 4 });
afterAll(() => db.close());
const workflow = createWorkflow(db, { rejected: () => {} });

async function plannedWeek() {
  const id = randomUUID();
  const phone = `+9725${Math.floor(1e7 + Math.random() * 9e7)}`;
  const profile = BusinessProfile.parse({
    name: 'מאפייה',
    field: 'מאפייה',
    mainProducts: ['חלות'],
    location: { city: 'חולון', address: 'הרצל 12', hours: '7-19', fulfillment: ['pickup'] },
    differentiator: 'בצק',
    channels: ['instagram'],
    style: 'warm',
    approverPhone: phone,
  });
  const weekId = randomUUID();
  await db.withBusiness('workflow', id, async (tx) => {
    await tx.insert(schema.business).values({ id, name: 'מאפייה', status: 'active', approverPhone: phone, profile });
    await tx.insert(schema.conversationState).values({ businessId: id, step: 'processing_update' });
    await tx.insert(schema.weeklyUpdate).values({ id: weekId, businessId: id, weekStart: '2026-11-01', status: 'planned', extractedFacts: { facts: [], missingDetails: [] } });
    await tx.insert(schema.post).values({
      businessId: id,
      weeklyUpdateId: weekId,
      position: 0,
      format: 'single',
      plan: { topic: 'הבצק', contentType: 'products', format: 'single', factIds: [], mediaAssetIds: [], brief: 'b' },
    });
  });
  return { id, phone, weekId };
}

describe('drafting errors', { timeout: 30_000 }, () => {
  it('routes a non-model error to the console and hands the conversation to a person', async () => {
    const { id, weekId } = await plannedWeek();
    const sent: string[] = [];
    const deps: DraftsDeps = {
      db,
      workflow,
      messaging: {
        sendText: async (_b, r) => void sent.push(r.text),
        sendButtons: async () => Promise.reject(new Error('provider down')),
      },
      model: { run: async () => ({ captions: { instagram: { text: 'הבצק שלנו', hashtags: [] } }, usedFactIds: [] }) as never },
      render: async () => ({ instagram: [{ storagePath: 'r/1.png', width: 1080, height: 1080, mimeType: 'image/png' }] }),
      mediaUrl: async (_b, a) => `https://media.test/${a}`,
      urlFor: (p) => `https://media.test/${p}`,
      readFile: async () => new Uint8Array([1, 2, 3]),
      samplePhotoUrl: 'https://media.test/sample.png',
    };
    await createDrafts(deps).draftWeek(id, weekId);

    const items = await db.withSystem('console', (tx) => tx.select().from(schema.consoleItem).where(eq(schema.consoleItem.businessId, id)));
    expect(items.map((i) => [i.kind, i.referenceId]).sort()).toEqual([
      ['draft_failed', weekId],
      ['handoff', id],
    ]);
    const [state] = await db.withBusiness('workflow', id, (tx) => tx.select().from(schema.conversationState));
    expect(state?.handoffAt).not.toBeNull();
    expect(sent).toEqual([copy.draftsNeedReview]);
  });
});
