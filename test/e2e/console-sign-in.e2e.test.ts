/**
 * Console sign-in (WP-82, docs/security.md "Console exposure"): the team reaches the console only
 * through IAP, the console checks IAP's signed header itself, and the signed-in email is the actor
 * of the action. The flow: a post is scheduled, a request without a valid IAP assertion is refused
 * and changes nothing, a signed-in team member pauses all publishing (recorded with their email,
 * not the `by` they typed), the proposed time passes and nothing reaches the networks; after the
 * resume, the post goes live. Runs the real console server (src/console-server.ts) on the H5 world.
 */
import { eq } from 'drizzle-orm';
import { expect, inject } from 'vitest';
import type { ModelProvider, PaymentProvider, TemplateRenderer } from '../../src/contracts/providers/index.js';
import * as schema from '../../src/db/schema.js';
import { buildConsoleServer } from '../../src/console-server.js';
import { createConsole, createIapVerifier, IAP_HEADER } from '../../src/modules/console/index.js';
import type { Publishing } from '../../src/modules/publishing/index.js';
import { MessagingSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { openH5Db } from '../h5/db.js';
import { subjectApp, subjectExtras } from '../h5/subject.js';
import { createH5World, type H5World } from '../h5/world.js';
import { e2eTest } from './harness/index.js';
import { createTestIap, TEST_IAP_AUDIENCE } from './harness/iap.js';

const OWNER = '+972501233441';
const BUSINESS_PHONE = '+972501234561';
const CAPTION = 'פוקצ׳ה טרייה כל בוקר, 18 ₪';
// Tuesday 2026-11-03 10:00 in Israel. The first proposed time is Wednesday 10:00 (08:00Z).
const START = '2026-11-03T08:00:00.000Z';
const AFTER_PROPOSED = '2026-11-04T08:01:00.000Z';
const TEAM_MEMBER = 'dana@postly.test';

const notUsed = (what: string) => () => Promise.reject(new Error(`${what} is not used in this test`));
const model: ModelProvider = { name: 'unused', generateStructured: notUsed('model'), analyzeImage: notUsed('model'), transcribeAudio: notUsed('model') };
const payment: PaymentProvider = { name: 'unused', createPaymentLink: notUsed('payment'), getSubscriptionStatus: notUsed('payment'), cancelSubscription: notUsed('payment') };
const renderer: TemplateRenderer = { render: notUsed('renderer') };

e2eTest('a team member signed in through IAP pauses all publishing: the pause names them, and nothing goes live until they resume', { timeout: 90_000 }, async ({ e2e }) => {
  let now = new Date(START);
  const clock = () => now;
  const publishing = new PublishingSimulator({ now: clock });
  const messaging = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });
  const db = openH5Db();
  let world: H5World | undefined;
  const run = await e2e.start({
    providers: { messaging, publishing, model, payment, renderer },
    app: async (p) => {
      world = await createH5World({ messaging: p.messaging, publishing: p.publishing, now: clock, databaseUrls: inject('databaseUrls') });
      return world.app;
    },
    ownerPhone: OWNER,
    businessPhone: BUSINESS_PHONE,
    now: clock,
  });
  const iap = createTestIap();
  const actions: object[] = [];
  const server = buildConsoleServer({
    console: createConsole(db.db, subjectApp(world!).workflow),
    auth: { mode: 'iap', verifier: createIapVerifier({ audience: TEST_IAP_AUDIENCE, fetchKeys: async () => iap.keys }) },
    allowedHosts: ['console.postly.test'],
    log: (line) => void actions.push(line),
  });
  const control = async () => (await db.db.withSystem('console', (tx) => tx.select().from(schema.systemControl)))[0];
  const publications = (postId: string) => db.db.withSystem('console', (tx) => tx.select().from(schema.publication).where(eq(schema.publication.postId, postId)));
  const consolePost = (path: string, payload: object, headers: Record<string, string> = {}) =>
    server.inject({ method: 'POST', url: `/console/api${path}`, headers: { host: 'console.postly.test', 'content-type': 'application/json', ...headers }, payload: JSON.stringify(payload) });

  try {
    const businessId = await world!.createBusiness(OWNER);
    await world!.connectChannel(businessId, 'instagram');
    await world!.connectChannel(businessId, 'facebook');
    const app = subjectApp(world!);
    const { payment: paymentSim } = subjectExtras(world!);
    await app.billing!.sendPaymentLink(businessId);
    const subscriptionId = paymentSim.completePayment(paymentSim.links.at(-1)!.link.providerCustomerId);
    expect(await app.billing!.handleWebhook(paymentSim.webhook(subscriptionId))).toMatchObject({ kind: 'applied', to: 'active' });
    const job = world!.publishingJob as Publishing;

    // The owner approves a draft and confirms the proposed time.
    const draft = await world!.createDraft(businessId, CAPTION);
    await run.owner.tapsButton(draft.buttons.approve, { action: 'approve', postId: draft.postId, versionHash: draft.versionHash });
    await run.owner.sendsText('כן');
    expect((await publications(draft.postId)).map((p) => p.status)).toEqual(['scheduled', 'scheduled']);

    // Without a valid IAP assertion the console refuses, and nothing changes.
    expect((await consolePost('/system/pause', { reason: 'no sign-in' })).statusCode).toBe(401);
    const forged = createTestIap(iap.kid).assertion(TEAM_MEMBER);
    expect((await consolePost('/system/pause', { reason: 'forged' }, { [IAP_HEADER]: forged })).statusCode).toBe(401);
    expect((await consolePost('/system/pause', { reason: 'unsigned' }, { 'x-goog-authenticated-user-email': `accounts.google.com:${TEAM_MEMBER}` })).statusCode).toBe(401);
    // (The system_control row exists only once a pause was ever set.)
    expect((await control())?.publishingPaused ?? false).toBe(false);

    // Signed in: the pause is recorded with the email from the assertion, not the typed `by`.
    const signedIn = { [IAP_HEADER]: iap.assertion(TEAM_MEMBER) };
    expect((await consolePost('/system/pause', { by: 'someone else', reason: 'provider outage' }, signedIn)).statusCode).toBe(200);
    expect(await control()).toMatchObject({ publishingPaused: true, pausedBy: TEAM_MEMBER, pausedReason: 'provider outage (by: someone else)' });
    const page = await server.inject({ method: 'GET', url: '/console', headers: { host: 'console.postly.test', ...signedIn } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`Signed in as ${TEAM_MEMBER}`);
    expect(page.body).toContain(`by ${TEAM_MEMBER}`);

    // The proposed time passes while paused: nothing reaches the networks.
    now = new Date(AFTER_PROPOSED);
    await job.tick(now, { businessId });
    expect(run.networkPosts()).toEqual([]);

    // The team member resumes; the next tick publishes the approved version on both networks.
    expect((await consolePost('/system/resume', {}, { [IAP_HEADER]: iap.assertion(TEAM_MEMBER) })).statusCode).toBe(200);
    expect(await control()).toMatchObject({ publishingPaused: false });
    await job.tick(now, { businessId });
    expect(run.networkPosts().map((p) => p.network).sort()).toEqual(['facebook', 'instagram']);
    expect(run.networkPosts().every((p) => p.caption === CAPTION)).toBe(true);

    expect(actions).toEqual([
      expect.objectContaining({ msg: 'console action', actor: TEAM_MEMBER, path: '/console/api/system/pause', status: 200 }),
      expect.objectContaining({ msg: 'console action', actor: TEAM_MEMBER, path: '/console/api/system/resume', status: 200 }),
    ]);
    run.recordConsoleItems(actions.map((details) => ({ kind: 'console action', details })));
  } finally {
    await server.close();
    // The pause is shared by the whole database: never leave it on for the next case.
    await db.setGlobalPause(false);
    await world?.close();
    await db.close();
  }
});
