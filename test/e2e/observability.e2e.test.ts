/**
 * Metrics and traces of the approval and publishing flow (WP-48; docs/observability.md, Metrics and
 * Tracing). The owner taps an old version's approve button (refused), approves the current one,
 * confirms the proposed time, and the publishing job publishes on both simulated networks. The
 * dashboards would show one refused and one approved approval, two published publications, the
 * messages in and out, and the job spans, and no label or span attribute carries the caption, the
 * owner's words or a phone number. The app is real (the H5 world on the simulators).
 */
import { expect, inject, onTestFinished } from 'vitest';
import type { ModelProvider, PaymentProvider, TemplateRenderer } from '../../src/contracts/providers/index.js';
import type { Publishing } from '../../src/modules/publishing/index.js';
import { memoryTelemetry } from '../../src/shared/telemetry-memory.js';
import { MessagingSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { createH5World, type H5World } from '../h5/world.js';
import { e2eTest } from './harness/index.js';

const OWNER = '+972501233377';
const BUSINESS_PHONE = '+972501234560';
const CAPTION = 'צבעונים חדשים הגיעו, 25 ₪ לזר';
const CHANGED = 'צבעונים חדשים הגיעו, 30 ₪ לזר';
const START = '2026-11-03T08:00:00.000Z';

const notUsed = (what: string) => () => Promise.reject(new Error(`${what} is not used in this test`));
const model: ModelProvider = { name: 'unused', generateStructured: notUsed('model'), analyzeImage: notUsed('model'), transcribeAudio: notUsed('model') };
const payment: PaymentProvider = { name: 'unused', createPaymentLink: notUsed('payment'), getSubscriptionStatus: notUsed('payment'), cancelSubscription: notUsed('payment') };
const renderer: TemplateRenderer = { render: notUsed('renderer') };

e2eTest('approvals and publications show on the metrics by outcome and network, with no customer content in any label or span', { timeout: 90_000 }, async ({ e2e }) => {
  let now = new Date(START);
  const clock = () => now;
  const publishing = new PublishingSimulator({ now: clock });
  let world: H5World | undefined;
  const run = await e2e.start({
    providers: { messaging: new MessagingSimulator({ businessNumber: BUSINESS_PHONE }), publishing, model, payment, renderer },
    app: async (p) => {
      world = await createH5World({ messaging: p.messaging, publishing: p.publishing, now: clock, databaseUrls: inject('databaseUrls') });
      return world.app;
    },
    ownerPhone: OWNER,
    businessPhone: BUSINESS_PHONE,
    now: clock,
  });
  onTestFinished(async () => world?.close());
  const businessId = await world!.createBusiness(OWNER);
  await world!.connectChannel(businessId, 'instagram');
  await world!.connectChannel(businessId, 'facebook');

  const first = await world!.createDraft(businessId, CAPTION);
  const current = await world!.requestChange(businessId, first.postId, CHANGED);
  // Recording starts here, so the counts are the owner's actions only (setup sends messages too).
  const telemetry = memoryTelemetry();
  onTestFinished(() => telemetry.stop());
  // The old version's button is refused; the current one approves.
  await run.owner.tapsButton(first.buttons.approve, { action: 'approve', postId: first.postId, versionHash: first.versionHash });
  await run.owner.tapsButton(current.buttons.approve, { action: 'approve', postId: current.postId, versionHash: current.versionHash });
  await run.owner.sendsText('כן');
  now = new Date('2026-11-04T08:01:00.000Z');
  expect((await (world!.publishingJob as Publishing).tick(now, { businessId })).ran).toBe(2);
  expect(run.networkPosts().map((p) => p.network).sort()).toEqual(['facebook', 'instagram']);

  expect(await telemetry.points('postly.approvals.count')).toEqual(
    expect.arrayContaining([
      { labels: { outcome: 'refused', reason: 'stale_version' }, value: 1 },
      { labels: { outcome: 'approved', reason: 'none' }, value: 1 },
    ]),
  );
  expect(await telemetry.points('postly.publications.count')).toEqual(
    expect.arrayContaining([
      { labels: { outcome: 'published', network: 'instagram' }, value: 1 },
      { labels: { outcome: 'published', network: 'facebook' }, value: 1 },
    ]),
  );
  const messages = await telemetry.points('postly.messages.count');
  expect(messages).toEqual(
    expect.arrayContaining([
      { labels: { direction: 'in', kind: 'button_reply', outcome: 'accepted' }, value: 2 },
      { labels: { direction: 'in', kind: 'text', outcome: 'accepted' }, value: 1 },
      expect.objectContaining({ labels: { direction: 'out', kind: 'template', outcome: 'sent' } }),
    ]),
  );
  const runs = telemetry.spans().filter((s) => s.name === 'publication run');
  expect(runs.map((s) => [s.attributes.network, s.attributes.outcome].join(':')).sort()).toEqual(['facebook:published', 'instagram:published']);

  const exported = JSON.stringify(await telemetry.allPoints()) + JSON.stringify(telemetry.spans().map((s) => [s.name, s.attributes, s.statusMessage]));
  for (const forbidden of [OWNER, BUSINESS_PHONE, CAPTION, CHANGED, 'צבעונים', 'כן']) expect(exported).not.toContain(forbidden);
});
