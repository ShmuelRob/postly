import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPostgresSimulatorStore } from '../../src/db/index.js';
import { simulatedWorld } from '../../src/simulated.js';
import { createSandbox, type Sandbox } from './sandbox.js';

// The dev sandbox's "new sign-up from this number" (docs/deployment.md, "The sandbox"), on the
// Postgres simulator store as dev runs it: the new sign-up's chat starts empty, both sides.

const OWNER = '+972501234577';
const OTHER = '+972501234578';
const BUSINESS_PHONE = '+972521111177';
const PUBLIC_BASE_URL = 'https://postly-dev-web.example.test';
const SECRET = 'test-only';
const NAMESPACE = `sandbox-db-${Date.now()}`;

const store = createPostgresSimulatorStore(inject('simulatorStoreUrl'));
// Web plays the other side of the webhook; this test needs only that it accepts the posts.
let web: Server;
let sandbox: Sandbox;
const world = simulatedWorld({ store, namespace: NAMESPACE, webhookSecret: SECRET, publicBaseUrl: PUBLIC_BASE_URL, businessNumber: BUSINESS_PHONE });

beforeAll(async () => {
  web = createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(200).end());
  });
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
  sandbox = await createSandbox({
    databaseUrls: inject('databaseUrls'),
    store,
    namespace: NAMESPACE,
    webhookSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE_URL,
    webUrl: `http://127.0.0.1:${(web.address() as AddressInfo).port}`,
    businessNumber: BUSINESS_PHONE,
    ownerPhone: OWNER,
  });
});

afterAll(async () => {
  await sandbox?.close();
  await new Promise((resolve) => web?.close(resolve));
  await store.close();
});

describe('sandbox sign-up', () => {
  it('a new sign-up from the number starts an empty chat: no messages from it and none to it; other numbers keep theirs', async () => {
    const first = await sandbox.signUp();
    await sandbox.send({ kind: 'text', text: 'היי, נרשמתי לפוסטלי' });
    await world.messaging.run((sim) => sim.sendText({ to: OWNER, text: 'שלום! איך קוראים לעסק?' }));
    await world.messaging.run((sim) => sim.sendText({ to: OTHER, text: 'הודעה למספר אחר' }));
    expect((await sandbox.state()).messages.map((m) => m.direction)).toEqual(['from_owner', 'to_owner']);

    const second = await sandbox.signUp();

    expect(second).not.toBe(first);
    const state = await sandbox.state();
    expect(state.business).toMatchObject({ id: second, status: 'onboarding' });
    expect(state.messages).toEqual([]);
    expect(await sandbox.transcript()).toEqual([]);
    expect((await world.messaging.run((sim) => sim.sentTo(OTHER))).map((m) => m.request)).toEqual([{ to: OTHER, text: 'הודעה למספר אחר' }]);

    // The new onboarding's chat holds only what comes after the sign-up.
    await sandbox.send({ kind: 'text', text: 'שוב שלום' });
    await world.messaging.run((sim) => sim.sendText({ to: OWNER, text: 'ברוכים הבאים' }));
    expect((await sandbox.state()).messages.map((m) => m.text)).toEqual(['שוב שלום', 'ברוכים הבאים']);
  });

  it("the feed shows only the current sign-up's posts; the earlier ones stay on the publishing simulator", async () => {
    const first = await sandbox.signUp();
    await world.publishing.run(async (sim) => {
      const providerAccountId = sim.connect(first, 'instagram');
      await sim.publish({
        idempotencyKey: randomUUID(),
        providerAccountId,
        network: 'instagram',
        caption: 'חלות לשבת',
        mediaUrls: ['https://storage.example.test/challah.png'],
        format: 'single',
        scheduledFor: new Date().toISOString(),
      });
    });
    expect((await sandbox.state()).feed.instagram.map((p) => p.caption)).toEqual(['חלות לשבת']);

    await sandbox.signUp();

    expect((await sandbox.state()).feed).toEqual({ instagram: [], facebook: [] });
    expect((await world.publishing.run((sim) => sim.posts)).map((p) => p.request.caption)).toContain('חלות לשבת');
  });
});
