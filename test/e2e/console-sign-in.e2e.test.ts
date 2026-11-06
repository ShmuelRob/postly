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
import { createTestIap, TEST_CLOUD_RUN_IAP_AUDIENCE, TEST_IAP_AUDIENCE } from './harness/iap.js';

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

// Dev's console sits behind Cloud Run's built-in IAP (docs/security.md, "Console exposure"), with no
// load balancer: IAP signs the assertion for the Cloud Run service, and the browser's Host is the
// service's run.app URL. The console accepts only that audience and that host.
const CLOUD_RUN_HOST = 'postly-dev-console-123456789012.me-west1.run.app';
const SANDBOX_AUDIENCE = '/projects/123456789012/locations/me-west1/services/postly-dev-sandbox';

e2eTest('dev console behind Cloud Run IAP: only an assertion for the console service on its run.app URL gets in, and the action names the signed-in account', { timeout: 90_000 }, async ({ e2e }) => {
  const clock = () => new Date(START);
  const messaging = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });
  const db = openH5Db();
  let world: H5World | undefined;
  await e2e.start({
    providers: { messaging, publishing: new PublishingSimulator({ now: clock }), model, payment, renderer },
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
    auth: { mode: 'iap', verifier: createIapVerifier({ audience: TEST_CLOUD_RUN_IAP_AUDIENCE, fetchKeys: async () => iap.keys }) },
    allowedHosts: [CLOUD_RUN_HOST],
    log: (line) => void actions.push(line),
  });
  const control = async () => (await db.db.withSystem('console', (tx) => tx.select().from(schema.systemControl)))[0];
  const consolePost = (path: string, assertion: string, host = CLOUD_RUN_HOST) =>
    server.inject({ method: 'POST', url: `/console/api${path}`, headers: { host, origin: `https://${host}`, 'content-type': 'application/json', [IAP_HEADER]: assertion }, payload: JSON.stringify({ reason: 'checking dev sign-in' }) });
  const forConsole = (email = TEAM_MEMBER) => iap.assertion(email, { claims: { aud: TEST_CLOUD_RUN_IAP_AUDIENCE } });

  try {
    // A real IAP assertion, but for the sandbox service: refused, nothing changes.
    expect((await consolePost('/system/pause', iap.assertion(TEAM_MEMBER, { claims: { aud: SANDBOX_AUDIENCE } }))).statusCode).toBe(401);
    // The load balancer's audience is not this console's either.
    expect((await consolePost('/system/pause', iap.assertion(TEAM_MEMBER))).statusCode).toBe(401);
    // The service's other URL (Cloud Run's hashed one) is not the console's host.
    expect((await consolePost('/system/pause', forConsole(), 'postly-dev-console-abcdefghij-zf.a.run.app')).statusCode).toBe(403);
    expect((await control())?.publishingPaused ?? false).toBe(false);

    // Signed in on the run.app URL: the page names the account, and the pause is recorded with it.
    const page = await server.inject({ method: 'GET', url: '/console', headers: { host: CLOUD_RUN_HOST, [IAP_HEADER]: forConsole() } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`Signed in as ${TEAM_MEMBER}`);
    expect((await consolePost('/system/pause', forConsole())).statusCode).toBe(200);
    expect(await control()).toMatchObject({ publishingPaused: true, pausedBy: TEAM_MEMBER });
    expect((await consolePost('/system/resume', forConsole())).statusCode).toBe(200);
    expect(await control()).toMatchObject({ publishingPaused: false });

    expect(actions).toEqual([
      expect.objectContaining({ msg: 'console action', actor: TEAM_MEMBER, path: '/console/api/system/pause', status: 200 }),
      expect.objectContaining({ msg: 'console action', actor: TEAM_MEMBER, path: '/console/api/system/resume', status: 200 }),
    ]);
  } finally {
    await server.close();
    await db.setGlobalPause(false);
    await world?.close();
    await db.close();
  }
});
