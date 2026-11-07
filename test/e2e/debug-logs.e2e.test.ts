/**
 * Following one owner message in the logs (docs/observability.md, "Following one message" and "How to
 * debug a message"). A new owner writes twice; the onboarding agent answers each (the scripted agent:
 * no real model), and its second turn has one refused tool call. Every log line of one message's path,
 * from the webhook to the reply, carries that message's correlationId label, in order: stored,
 * workflow events, agent turn, tool calls, outbound sends. The refusal is an INFO line with its code
 * word, and no line carries what the owner wrote, the agent's questions or a phone number.
 */
import { eq } from 'drizzle-orm';
import { afterAll, expect, inject, onTestFinished } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { createDesignRenderer } from '../../src/modules/design/index.js';
import { WEBHOOK_PATH } from '../../src/modules/messaging/index.js';
import { buildServer } from '../../src/server.js';
import { setLogSink } from '../../src/shared/logger.js';
import { call, step } from '../../src/simulators/scripted-agent.js';
import { MessagingSimulator, ModelSimulator, PaymentSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { e2eTest, type AppFactory, type Providers } from './harness/index.js';

const OWNER = '+972501230093';
const BUSINESS_PHONE = '+972521111193';
const SAY = { hello: 'היי, נרשמתי לפוסטלי', business: 'קוראים לנו מאפיית בן עמי, אנחנו אופים חלות' };
const ASK = { business: 'נעים מאוד! איך קוראים לעסק, ומה אתם מוכרים?', where: 'איפה המאפייה נמצאת?' };
// A quote the owner never wrote: set_profile_field refuses it (agent.md, verbatim quotes).
const NOT_SAID = 'מאפייה בתל אביב';

const db = createDatabase(inject('databaseUrls'), { max: 3 });
afterAll(() => db.close());

const MEDIA_ORIGIN = 'https://media.postly.test/';
function memoryStorage() {
  const files = new Map<string, { mimeType: string; data: Uint8Array }>();
  return {
    async put(path: string, data: Uint8Array, mimeType: string) {
      files.set(path, { mimeType, data });
    },
    urlFor: (path: string) => MEDIA_ORIGIN + path,
    read: async (ref: string) => files.get(ref.startsWith(MEDIA_ORIGIN) ? ref.slice(MEDIA_ORIGIN.length) : ref),
  };
}

type Line = { severity: string; message: string; labels: Record<string, string>; [key: string]: unknown };

e2eTest('one owner message can be followed in the logs from the webhook to the reply by its correlationId, with no content in any line', { timeout: 120_000 }, async ({ e2e }) => {
  const messagingSim = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });
  const modelSim = new ModelSimulator();
  const paymentSim = new PaymentSimulator();
  modelSim.scriptAgent(
    'onboarding',
    [step(call.askOwner(ASK.business, { topic: 'profile:name' }))],
    [
      step(call.setProfileField('name', 'מאפיית בן עמי', 'מאפיית בן עמי'), call.setProfileField('location.city', 'תל אביב', NOT_SAID)),
      step(call.askOwner(ASK.where, { topic: 'profile:location' })),
    ],
  );
  const storage = memoryStorage();
  const design = createDesignRenderer({
    assets: {
      load: async (url) => {
        const file = await storage.read(url);
        if (!file) throw new Error(`no stored file at ${url}`);
        return file.data;
      },
    },
    store: { put: (path, bytes, mimeType) => storage.put(path, bytes, mimeType) },
  });
  const providers = { messaging: messagingSim, publishing: new PublishingSimulator(), model: modelSim, payment: paymentSim, renderer: { render: async () => ({}) }, design } satisfies Providers;
  await db.withSystem('console', (tx) => tx.update(schema.business).set({ approverPhone: `+9720${Date.now()}` }).where(eq(schema.business.approverPhone, OWNER)));

  let onboarding: ReturnType<typeof createApp>['onboarding'] | undefined;
  const app: AppFactory = ({ messaging: messagingProvider, publishing, model, design: recordedDesign }) => {
    const postly = createApp({
      db,
      oneShotFlows: false,
      providers: { messaging: messagingProvider, publishing, models: { google: model }, payment: paymentSim },
      design: recordedDesign!,
      media: storage,
      businessNumber: BUSINESS_PHONE,
      samplePhotoUrl: storage.urlFor('bundled/sample.jpg'),
    });
    onboarding = postly.onboarding;
    const server = buildServer({ messaging: postly.messaging, billing: postly.billing!, publicBaseUrl: 'https://postly.example.test' });
    return {
      async deliverInbound(message) {
        const hook = messagingSim.webhook(message);
        const res = await server.inject({ method: 'POST', url: WEBHOOK_PATH, headers: hook.headers, payload: hook.body });
        expect(res.statusCode).toBe(200);
        await postly.messaging.flushBursts();
      },
      close: async () => {
        await server.close();
        await design.close();
      },
    };
  };
  const run = await e2e.start({ providers, app, ownerPhone: OWNER, businessPhone: BUSINESS_PHONE, readMedia: storage.read });
  const businessId = await onboarding!.createBusiness({ approverPhone: OWNER });

  const raw: string[] = [];
  setLogSink((line) => raw.push(line));
  onTestFinished(() => setLogSink(undefined));
  await run.owner.sendsText(SAY.hello);
  await run.owner.sendsText(SAY.business);
  setLogSink(undefined);
  expect(run.owner.received().map((m) => m.text).at(-1)).toBe(ASK.where);

  const lines = raw.map((l) => JSON.parse(l) as Record<string, unknown>).map((l) => ({ ...l, labels: (l['logging.googleapis.com/labels'] ?? {}) as Record<string, string> }) as Line);
  const inbound = await db.withBusiness('messaging', businessId, (tx) =>
    tx.select({ id: schema.message.id, body: schema.message.body }).from(schema.message).where(eq(schema.message.direction, 'inbound')),
  );
  const second = inbound.find((m) => m.body === SAY.business)!.id;

  // Everything about the second message, by its correlationId, in order.
  const path = lines.filter((l) => l.labels.correlationId === second);
  const events = path.map((l) => l.message);
  const order = ['inbound message stored', 'agent turn started', 'agent tool call', 'outbound message sent'];
  for (const name of order) expect(events).toContain(name);
  expect(order.map((name) => events.indexOf(name))).toEqual([...order.map((name) => events.indexOf(name))].sort((a, b) => a - b));
  for (const line of path) expect(line.labels.businessId).toBe(businessId);

  // The turn's lines carry its id; the tool calls show the refused one with its code word, at INFO.
  const started = path.find((l) => l.message === 'agent turn started')!;
  expect(started).toMatchObject({ agent: 'onboarding', trigger: 'burst' });
  const turnId = started.labels.agentTurnId!;
  expect(turnId).toMatch(/^[0-9a-f-]{36}$/);
  const tools = path.filter((l) => l.message === 'agent tool call');
  expect(tools.every((l) => l.labels.agentTurnId === turnId)).toBe(true);
  expect(tools.map((l) => [l.tool, l.outcome])).toEqual([
    ['set_profile_field', 'ok'],
    ['set_profile_field', 'refused'],
    ['ask_owner', 'ok'],
  ]);
  const refused = tools[1]!;
  expect(refused.severity).toBe('INFO');
  expect(typeof refused.reason).toBe('string');
  expect(typeof refused.durationMs).toBe('number');
  expect(path.find((l) => l.message === 'outbound message sent')).toMatchObject({ kind: 'text', durationMs: expect.any(Number) });

  // The first message has its own correlationId; nothing of the second's path carries it.
  const first = inbound.find((m) => m.body === SAY.hello)!.id;
  const firstPath = lines.filter((l) => l.labels.correlationId === first);
  // The first message starts onboarding: its workflow events are on its path, with their states.
  expect(firstPath.map((l) => l.message)).toEqual(expect.arrayContaining(['inbound message stored', 'workflow event applied', 'agent turn started', 'outbound message sent']));
  expect(firstPath.find((l) => l.message === 'workflow event applied')).toMatchObject({ machine: expect.any(String), event: expect.any(String), fromState: expect.any(String), toState: expect.any(String) });
  expect(path.some((l) => l.labels.correlationId === first)).toBe(false);

  // No content and no phone in any line.
  const text = raw.join('\n');
  for (const forbidden of [OWNER, BUSINESS_PHONE, SAY.hello, SAY.business, ASK.business, ASK.where, NOT_SAID, 'מאפיית בן עמי', 'חלות']) expect(text).not.toContain(forbidden);
});
