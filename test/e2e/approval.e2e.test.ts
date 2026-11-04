/**
 * Approval (WP-33; PRD approval rules; state-machines.md, Approval guard; technical-design.md,
 * Approval flow). The owner gets a draft with אישור and שינוי buttons. Only the approver's tap on
 * the current version approves; free text, a stranger's tap, and an old draft's button do not; a
 * change after approval invalidates it. The app is real (the H5 world in test/h5/subject.ts wires it
 * on the simulators, with a placeholder renderer); the copy is provisional (H6).
 */
import { expect, inject } from 'vitest';
import type { ModelProvider, PaymentProvider, TemplateRenderer } from '../../src/contracts/providers/index.js';
import { draftsCopy } from '../../src/modules/workflow/index.js';
import { MessagingSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { openH5Db, type H5Db } from '../h5/db.js';
import { createH5World, type H5World } from '../h5/world.js';
import { e2eTest, type E2eHarness, type E2eRun } from './harness/index.js';

const OWNER = '+972501233301';
const STRANGER = '+972501233399';
const BUSINESS_PHONE = '+972501234560';
const CAPTION = 'צבעונים חדשים הגיעו, 25 ₪ לזר';
const CHANGED = 'צבעונים חדשים הגיעו, 30 ₪ לזר';

const notUsed = (what: string) => () => Promise.reject(new Error(`${what} is not used in this test`));
const model: ModelProvider = { name: 'unused', generateStructured: notUsed('model'), analyzeImage: notUsed('model'), transcribeAudio: notUsed('model') };
const payment: PaymentProvider = { name: 'unused', createPaymentLink: notUsed('payment'), getSubscriptionStatus: notUsed('payment'), cancelSubscription: notUsed('payment') };
const renderer: TemplateRenderer = { render: notUsed('renderer') };

interface Ctx {
  run: E2eRun;
  world: H5World;
  db: H5Db;
  messaging: MessagingSimulator;
  businessId: string;
}

/** A business with one draft sent to the owner, then `body`. */
async function withDraft(e2e: E2eHarness, body: (ctx: Ctx, draft: Awaited<ReturnType<H5World['createDraft']>>) => Promise<void>) {
  const clock = () => new Date('2026-11-03T08:00:00.000Z');
  const messaging = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });
  const db = openH5Db();
  let world: H5World | undefined;
  const run = await e2e.start({
    providers: { messaging, publishing: new PublishingSimulator({ now: clock }), model, payment, renderer },
    app: async (p) => {
      world = await createH5World({ messaging: p.messaging, publishing: p.publishing, now: clock, databaseUrls: inject('databaseUrls') });
      return world.app;
    },
    ownerPhone: OWNER,
    businessPhone: BUSINESS_PHONE,
    now: clock,
  });
  try {
    const businessId = await world!.createBusiness(OWNER);
    const draft = await world!.createDraft(businessId, CAPTION);
    const sent = run.owner.received().at(-1);
    expect(sent?.text).toContain(CAPTION);
    expect(sent?.buttons?.map((b) => b.title)).toEqual([draftsCopy.APPROVE_TITLE, draftsCopy.CHANGE_TITLE]);
    await body({ run, world: world!, db, messaging, businessId }, draft);
  } finally {
    await world?.close();
    await db.close();
  }
}

e2eTest('the owner taps אישור on the draft: the post is approved and the owner is told', { timeout: 60_000 }, async ({ e2e }) => {
  await withDraft(e2e, async ({ run, db }, draft) => {
    await run.owner.tapsButton(draft.buttons.approve, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });

    expect(await db.postStatus(draft.postId)).toBe('approved');
    expect(await db.approvals(draft.postId)).toEqual([expect.objectContaining({ versionHash: draft.versionHash, invalidated: false, approverPhone: OWNER })]);
    expect(run.owner.received().at(-1)?.text).toContain('אושר');
  });
});

e2eTest('free text that says "approved" never approves: the draft comes back with its buttons', { timeout: 60_000 }, async ({ e2e }) => {
  await withDraft(e2e, async ({ run, db }, draft) => {
    for (const text of ['מאשר', 'אישור', 'ok', '👍']) {
      await run.owner.sendsText(text);
      expect(run.owner.received().at(-1)?.buttons?.map((b) => b.title)).toContain(draftsCopy.APPROVE_TITLE);
    }

    expect(await db.postStatus(draft.postId)).toBe('awaiting_approval');
    expect(await db.approvals(draft.postId)).toEqual([]);
    expect(run.owner.received().some((m) => m.text === draftsCopy.notAnApproval)).toBe(true);
  });
});

e2eTest("an approve tap from another number is rejected: nothing is approved and the stranger gets no reply", { timeout: 60_000 }, async ({ e2e }) => {
  await withDraft(e2e, async ({ run, world, db, messaging }, draft) => {
    await world.app.deliverInbound(messaging.inboundButtonTap(STRANGER, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash }));

    expect(await db.postStatus(draft.postId)).toBe('awaiting_approval');
    expect(await db.approvals(draft.postId)).toEqual([]);
    expect(run.sender(STRANGER).received()).toEqual([]);
  });
});

e2eTest('a change after approval invalidates it; the old button is refused and only the new draft approves', { timeout: 60_000 }, async ({ e2e }) => {
  await withDraft(e2e, async ({ run, world, db, businessId }, draft) => {
    await run.owner.tapsButton(draft.buttons.approve, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });
    expect(await db.postStatus(draft.postId)).toBe('approved');

    const changed = await world.requestChange(businessId, draft.postId, CHANGED);
    expect(await db.approvals(draft.postId)).toEqual([expect.objectContaining({ versionHash: draft.versionHash, invalidated: true })]);
    expect(await db.postStatus(draft.postId)).toBe('awaiting_approval');
    expect(run.owner.received().at(-1)?.text).toContain(CHANGED);

    // The first draft's אישור carries the old hash: refused, and the open draft is sent again.
    await run.owner.tapsButton(draft.buttons.approve, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });
    expect(await db.postStatus(draft.postId)).toBe('awaiting_approval');
    expect(run.owner.received().some((m) => m.text === draftsCopy.notCurrentDraft)).toBe(true);

    await run.owner.tapsButton(changed.buttons.approve, { action: 'approve', postId: draft.postId, versionHash: changed.versionHash });
    expect(await db.postStatus(draft.postId)).toBe('approved');
    const approvals = await db.approvals(draft.postId);
    expect(approvals.map((a) => [a.versionHash, a.invalidated])).toEqual([
      [draft.versionHash, true],
      [changed.versionHash, false],
    ]);
  });
});
