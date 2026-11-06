import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { BusinessProfile } from '../../contracts/business-profile.js';
import { WindowClosedError } from '../../contracts/providers/messaging.js';
import { createDatabase } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createDrafts, createWorkflow, draftsCopy as copy, type DraftsDeps } from './index.js';

// Review of PR #43, item 6: an error while drafting that is not a model failure must not leave the
// conversation waiting in processing_update.

const db = createDatabase(inject('databaseUrls'), { max: 4 });
afterAll(() => db.close());
const workflow = createWorkflow(db, { rejected: () => {} });

async function plannedWeek(channels: ('instagram' | 'facebook')[] = ['instagram']) {
  const id = randomUUID();
  const phone = `+9725${Math.floor(1e7 + Math.random() * 9e7)}`;
  const profile = BusinessProfile.parse({
    name: 'מאפייה',
    field: 'מאפייה',
    mainProducts: ['חלות'],
    location: { city: 'חולון', address: 'הרצל 12', hours: '7-19', fulfillment: ['pickup'] },
    differentiator: 'בצק',
    channels,
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

describe('what the owner is shown', { timeout: 30_000 }, () => {
  it('shows a network render that differs from the first, and both captions, before one pair of buttons', async () => {
    const { id, weekId } = await plannedWeek(['instagram', 'facebook']);
    const sent: { kind: string; text: string; mediaUrl?: string; buttons?: number }[] = [];
    await createDrafts({
      db,
      workflow,
      messaging: {
        sendText: async (_b, r) => void sent.push({ kind: 'text', text: r.text, ...(r.mediaUrl ? { mediaUrl: r.mediaUrl } : {}) }),
        sendButtons: async (_b, r) => void sent.push({ kind: 'buttons', text: r.text, ...(r.mediaUrl ? { mediaUrl: r.mediaUrl } : {}), buttons: r.buttons.length }),
      },
      model: {
        run: async () =>
          ({ captions: { instagram: { text: 'הבצק שלנו', hashtags: [] }, facebook: { text: 'הבצק שלנו, בפייסבוק', hashtags: [] } }, usedFactIds: [] }) as never,
      },
      render: async () => ({
        instagram: [{ storagePath: 'r/ig.png', width: 1080, height: 1350, mimeType: 'image/png' }],
        facebook: [{ storagePath: 'r/fb.png', width: 1200, height: 630, mimeType: 'image/png' }],
      }),
      mediaUrl: async (_b, a) => `https://media.test/${a}`,
      urlFor: (p) => `https://media.test/${p}`,
      readFile: async (p) => new TextEncoder().encode(p),
      invalidate: async () => {},
    samplePhotoUrl: 'https://media.test/sample.png',
    }).draftWeek(id, weekId);

    expect(sent.map((m) => [m.kind, m.text.split('\n')[0], m.mediaUrl, m.buttons])).toEqual([
      ['text', copy.networkRender('facebook', 1, 1), 'https://media.test/r/fb.png', undefined],
      ['buttons', 'טיוטה: הבצק', 'https://media.test/r/ig.png', 2],
    ]);
    expect(sent[1]!.text).toContain(`${copy.NETWORK_NAMES.instagram}:\nהבצק שלנו`);
    expect(sent[1]!.text).toContain(`${copy.NETWORK_NAMES.facebook}:\nהבצק שלנו, בפייסבוק`);
  });
});

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
      invalidate: async () => {},
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

describe('the closed-window mark (review of PR #52, item c)', { timeout: 30_000 }, () => {
  it('does not leak from a run that threw into the next run of the same business', async () => {
    const { id, weekId, phone } = await plannedWeek();
    // A second post in the first week, whose send throws after the first draft hit a closed window.
    await db.withBusiness('workflow', id, (tx) =>
      tx.insert(schema.post).values({
        businessId: id,
        weeklyUpdateId: weekId,
        position: 1,
        format: 'single',
        plan: { topic: 'החלות', contentType: 'products', format: 'single', factIds: [], mediaAssetIds: [], brief: 'b' },
      }),
    );
    let windowOpen = false;
    let renders = 0;
    let sends = 0;
    const templates: string[] = [];
    const drafts = createDrafts({
      db,
      workflow,
      messaging: {
        sendText: async () => {},
        sendButtons: async () => {
          sends += 1;
          if (windowOpen) return;
          // The first draft meets a closed window; the second send fails outright, so the run throws.
          throw sends === 1 ? new WindowClosedError(phone, null) : new Error('provider down');
        },
        sendTemplate: async (_b, r) => void templates.push(r.templateName),
      },
      model: { run: async () => ({ captions: { instagram: { text: 'הבצק שלנו', hashtags: [] } }, usedFactIds: [] }) as never },
      render: async () => {
        renders += 1;
        return { instagram: [{ storagePath: `r/${renders}.png`, width: 1080, height: 1080, mimeType: 'image/png' }] };
      },
      mediaUrl: async (_b, a) => `https://media.test/${a}`,
      urlFor: (p) => `https://media.test/${p}`,
      readFile: async () => new Uint8Array([1, 2, 3]),
      invalidate: async () => {},
      samplePhotoUrl: 'https://media.test/sample.png',
    });
    await drafts.draftWeek(id, weekId);
    expect(templates).toEqual([]);

    // The next run, with the window open: every draft goes out, so no drafts-waiting template.
    windowOpen = true;
    const nextWeek = randomUUID();
    await db.withBusiness('workflow', id, async (tx) => {
      await tx.update(schema.conversationState).set({ step: 'processing_update', handoffAt: null }).where(eq(schema.conversationState.businessId, id));
      await tx.insert(schema.weeklyUpdate).values({ id: nextWeek, businessId: id, weekStart: '2026-11-08', status: 'planned', extractedFacts: { facts: [], missingDetails: [] } });
      await tx.insert(schema.post).values({
        businessId: id,
        weeklyUpdateId: nextWeek,
        position: 0,
        format: 'single',
        plan: { topic: 'העוגות', contentType: 'products', format: 'single', factIds: [], mediaAssetIds: [], brief: 'b' },
      });
    });
    await drafts.draftWeek(id, nextWeek);
    expect(templates).toEqual([]);
  });
});

describe('a version is checked against its own facts (WP-94)', { timeout: 30_000 }, () => {
  it('blocks a fix that changes a price: nothing is written or sent; a fix with a sourced detail records its own facts', async () => {
    const { id, phone, weekId } = await plannedWeek();
    const price = { id: 'f1', type: 'price', value: '25 ₪', sourceQuote: '25 ₪' };
    const date = { id: 'f2', type: 'date', value: 'עד יום שישי', sourceQuote: 'עד יום שישי' };
    await db.withBusiness('workflow', id, async (tx) => {
      await tx.update(schema.weeklyUpdate).set({ extractedFacts: { facts: [price, date], missingDetails: [] } }).where(eq(schema.weeklyUpdate.id, weekId));
      await tx.update(schema.post).set({ plan: { topic: 'הבצק', contentType: 'products', format: 'single', factIds: ['f1', 'f2'], mediaAssetIds: [], brief: 'b' } }).where(eq(schema.post.weeklyUpdateId, weekId));
    });
    const sent: string[] = [];
    const drafts = createDrafts({
      db,
      workflow,
      messaging: { sendText: async (_b, r) => void sent.push(r.text), sendButtons: async (_b, r) => void sent.push(r.text) },
      model: { run: async () => ({}) as never },
      render: async () => ({ instagram: [{ storagePath: `r/${randomUUID()}.png`, width: 1080, height: 1080, mimeType: 'image/png' }] }),
      mediaUrl: async (_b, a) => `https://media.test/${a}`,
      urlFor: (p) => `https://media.test/${p}`,
      readFile: async () => new Uint8Array([1, 2, 3]),
      invalidate: async () => {},
      samplePhotoUrl: 'https://media.test/sample.png',
    });
    const [post] = await db.withBusiness('workflow', id, (tx) => tx.select().from(schema.post).where(eq(schema.post.weeklyUpdateId, weekId)));
    const design = { photos: [{ assetId: randomUUID() }], title: 'חלות' };
    const caption = (text: string) => ({ instagram: { text, hashtags: [] } });
    const made = await drafts.agentDraft(id, { postId: post!.id, captions: caption('חלה ב-25 ₪'), usedFactIds: ['f1'], design });
    expect(made.status).toBe('ok');
    const versions = () => db.withBusiness('content', id, (tx) => tx.select().from(schema.postVersion).where(eq(schema.postVersion.postId, post!.id)).orderBy(schema.postVersion.versionNumber));
    const sentBefore = sent.length;

    // A price that no fact has: the version is neither written nor sent, and the post is untouched.
    const blocked = await drafts.agentChange(id, { postId: post!.id, ownerQuote: 'x', captions: caption('חלה ב-30 ₪') });
    expect(blocked).toMatchObject({ status: 'refused', reason: 'fact_mismatch' });
    expect(await versions()).toHaveLength(1);
    expect(sent).toHaveLength(sentBefore);
    const [after] = await db.withBusiness('workflow', id, (tx) => tx.select().from(schema.post).where(eq(schema.post.id, post!.id)));
    expect(after!.status).toBe('awaiting_approval');

    // A fix that uses the date fact: the new version's fact_sources are the facts it uses now.
    const fixed = await drafts.agentChange(id, { postId: post!.id, ownerQuote: 'x', captions: caption('חלה ב-25 ₪ עד יום שישי') });
    expect(fixed.status).toBe('ok');
    const [first, second] = await versions();
    expect((first!.factSources as { factId: string }[]).map((f) => f.factId)).toEqual(['f1']);
    expect((second!.factSources as { factId: string }[]).map((f) => f.factId).sort()).toEqual(['f1', 'f2']);
    void phone;
  });
});
