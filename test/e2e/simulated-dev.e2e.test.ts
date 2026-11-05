/**
 * Simulated mode for the deployed dev (WP-51, docs/deployment.md "Simulated mode"): web and worker are
 * separate compositions, each with its own simulator objects, sharing one outside world through the
 * Postgres simulator store, as the separate Cloud Run services do. The human plays the owner in the
 * dev sandbox: every message is signed and posted over HTTP to the web service's webhook, the payment
 * link opens the sandbox's mock checkout, and the worker's publishing job puts the approved posts on
 * the mock feed. The web service restarts midway and nothing is lost.
 */
import { mkdirSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, expect, inject } from 'vitest';
import { createSandbox, type Sandbox } from '../../playground/sandbox/sandbox.js';
import { startSandboxUi, type SandboxUi } from '../../playground/sandbox/ui.js';
import { createDatabase } from '../../src/db/index.js';
import { createPostgresSimulatorStore } from '../../src/db/simulator-store.js';
import * as schema from '../../src/db/schema.js';
import { BILLING_COPY } from '../../src/modules/billing/index.js';
import { draftsCopy, onboardingCopy as copy, scheduleCopy } from '../../src/modules/workflow/index.js';
import { startSimulatedProcess, type SimulatedProcess } from '../../src/simulated.js';
import { e2eTest } from './harness/index.js';
import type { E2eRecord } from './harness/record.js';

const SHOTS = 'reports/simulated-dev';
const OWNER = '+972501234588';
const BUSINESS_PHONE = '+972521111188';
const PUBLIC_BASE_URL = 'https://postly-dev-web.example.test';
const SECRET = 'dev-webhook-secret-from-secret-manager';
// Each run gets its own outside world in the shared test database.
const NAMESPACE = `e2e-${Date.now()}`;

const store = createPostgresSimulatorStore(inject('simulatorStoreUrl'));
const db = createDatabase(inject('databaseUrls'), { max: 2 });
/** The dev clock: real time, moved forward to the scheduled time so the posts can go live in the test. */
let skewMs = 0;
const clock = () => new Date(Date.now() + skewMs);

let web: SimulatedProcess;
let worker: SimulatedProcess;
let sandbox: Sandbox;
let ui: SandboxUi;
let browser: Browser;

const processOptions = (role: 'web' | 'worker') => ({
  role,
  databaseUrls: inject('databaseUrls'),
  store,
  namespace: NAMESPACE,
  webhookSecret: SECRET,
  publicBaseUrl: PUBLIC_BASE_URL,
  businessNumber: BUSINESS_PHONE,
  sandboxUrl: 'http://sandbox.dev.test',
  burstQuietMs: 300,
  // The database is shared with the other e2e tests; the sweep would take their pending messages.
  sweep: false,
  now: clock,
});

beforeAll(async () => {
  web = await startSimulatedProcess(processOptions('web'));
  worker = await startSimulatedProcess(processOptions('worker'));
  sandbox = await createSandbox({
    databaseUrls: inject('databaseUrls'),
    store,
    namespace: NAMESPACE,
    webhookSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE_URL,
    webUrl: web.url!,
    businessNumber: BUSINESS_PHONE,
    ownerPhone: OWNER,
    now: clock,
  });
  ui = await startSandboxUi(sandbox, { port: 0 });
  browser = await chromium.launch();
  mkdirSync(SHOTS, { recursive: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await ui?.close();
  await sandbox?.close();
  await worker?.close();
  await web?.close();
  await db.close();
  await store.close();
});

e2eTest('dev on the simulators: onboarding, payment, drafts, approval and publishing across web, worker and the sandbox', async ({ task, e2e }) => {
  void e2e;
  const record = task.meta.e2e!;
  const timeout = { timeout: 30_000 };
  const replies = async () => (await sandbox.state()).messages.filter((m) => m.direction === 'to_owner');
  const lastReply = async () => (await replies()).at(-1)?.text ?? '';
  const write = (text: string) => sandbox.send({ kind: 'text', text });

  // 1. Onboarding, the owner typing in the sandbox's chat.
  const businessId = await sandbox.signUp();
  await write('היי, נרשמתי לפוסטלי');
  await expect.poll(lastReply, timeout).toContain(copy.questions.business);
  await write('מאפיית השכונה, מאפייה, חלות ועוגות שמרים');
  await expect.poll(lastReply, timeout).toContain(copy.questions.location);
  await write('רחוב הרצל 12 בחולון, פתוחים א׳-ה׳ 7:00-19:00, רק איסוף עצמי');
  await expect.poll(lastReply, timeout).toContain(copy.questions.audience);
  await write('משפחות מהשכונה. הבצק שלנו תופח 24 שעות');
  await expect.poll(lastReply, timeout).toContain(copy.questions.channels);
  await write('אינסטגרם ופייסבוק. בשבת לא מפרסמים');
  await expect.poll(lastReply, timeout).toContain(copy.askLogo);
  await sandbox.send({ kind: 'image', mimeType: 'image/png', dataBase64: onePixelPng().toString('base64') });
  await expect.poll(lastReply, timeout).toContain(copy.askPhotos);
  await write('סיימתי');
  await expect.poll(lastReply, { timeout: 90_000 }).toContain(copy.chooseStyle);
  await write('2');
  await expect.poll(lastReply, timeout).toContain('סגנון: חם');
  await write('מאשר');
  await expect.poll(lastReply, timeout).toMatch(/^מצוין! הצעד האחרון: חיבור הרשתות/);
  await sandbox.connect();
  await write('חיברתי');
  await expect.poll(async () => (await replies()).some((r) => r.text?.includes(copy.activated)), timeout).toBe(true);
  expect((await sandbox.state()).business.status).toBe('active');

  // 2. Payment: onboarding sent the link after activation (T1); it opens the sandbox's checkout, and
  // Pay sends the provider's signed callback to web.
  await expect.poll(async () => (await replies()).some((r) => r.text?.includes('http://sandbox.dev.test/checkout/')), timeout).toBe(true);
  const checkout = (await sandbox.state()).payment;
  expect(checkout?.status).toBe('awaiting_payment');
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(`${ui.url}checkout/${checkout!.customerId}`);
  await shot(page, record, 'checkout', 'The mock checkout page for the payment link');
  await page.getByRole('button', { name: 'Pay' }).click();
  await expect.poll(() => page.getByTestId('checkout-result').innerText(), timeout).toContain('active');
  await expect.poll(lastReply, timeout).toBe(BILLING_COPY.active);
  const [subscription] = await db.withSystem('console', (tx) => tx.select().from(schema.subscription).where(eq(schema.subscription.businessId, businessId)));
  expect(subscription?.status).toBe('active');

  // 3. Web restarts (a new revision): the outside world is still there.
  await web.close();
  web = await startSimulatedProcess({ ...processOptions('web'), port: Number(new URL(sandbox.webUrl).port) });
  expect((await sandbox.state()).messages.length).toBeGreaterThan(10);

  // 4. The weekly update: drafts with buttons; the owner approves each, then confirms the times.
  await write('השבוע יש לנו עוגות שמרים חדשות, ובשישי מבצע על חלות לשבת');
  await expect.poll(async () => (await sandbox.state()).conversation?.step, { timeout: 90_000 }).toBe('reviewing_drafts');
  const approveButtons = (await replies()).flatMap((m) => m.buttons ?? []).filter((b) => b.title === draftsCopy.APPROVE_TITLE);
  expect(approveButtons.length).toBeGreaterThan(0);
  for (const [i, button] of approveButtons.entries()) {
    await sandbox.send({ kind: 'button', buttonId: button.id });
    await expect.poll(async () => (await replies()).filter((r) => r.text?.includes('אושר')).length, timeout).toBeGreaterThan(i);
  }
  await expect.poll(lastReply, timeout).toContain('אלה הזמנים שאני מציע');
  await write('כן');
  await expect.poll(lastReply, timeout).toContain('מתוזמן');
  expect(Object.values((await sandbox.state()).feed).flat()).toEqual([]);

  // 5. The scheduled time comes; the worker (a separate composition) publishes to the shared simulator.
  const scheduled = await db.withSystem('console', (tx) => tx.select().from(schema.publication).where(eq(schema.publication.businessId, businessId)));
  const last = Math.max(...scheduled.map((p) => new Date(p.scheduledFor).getTime()));
  skewMs = last + 60_000 - Date.now();
  await worker.app.publishing.tick(clock(), { businessId });
  const feed = (await sandbox.state()).feed;
  expect({ instagram: feed.instagram.length, facebook: feed.facebook.length }).toEqual({ instagram: approveButtons.length, facebook: approveButtons.length });
  expect([...feed.instagram, ...feed.facebook].every((p) => p.status === 'published')).toBe(true);
  await expect.poll(async () => (await replies()).some((r) => r.text?.includes(scheduleCopy.PUBLISHED_TEMPLATE)), timeout).toBe(true);

  // 6. The sandbox UI shows the conversation and the feed, read from the shared store.
  await page.goto(ui.url);
  await expect.poll(() => page.getByTestId('chat').getByTestId('bubble-to_owner').count(), timeout).toBeGreaterThan(10);
  await page.getByTestId('feed').getByRole('button', { name: 'Instagram' }).click();
  await expect.poll(() => page.getByTestId('feed').getByTestId('feed-post').count(), timeout).toBe(approveButtons.length);
  await shot(page, record, 'published', 'The dev sandbox after publishing: the chat and the mock Instagram feed');
  await page.close();

  record.transcript.push(...(await sandbox.transcript()));
  record.publishing.push(...(await sandbox.feedRecord()));
}, 360_000);

e2eTest('the mock checkout reports a failed payment and a cancelled one', async () => {
  const other = await createSandbox({
    databaseUrls: inject('databaseUrls'),
    store,
    namespace: NAMESPACE,
    webhookSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE_URL,
    webUrl: sandbox.webUrl,
    businessNumber: BUSINESS_PHONE,
    ownerPhone: OWNER,
    now: clock,
  });
  try {
    const businessId = (await other.state()).business.id;
    const { customerId } = (await other.state()).payment!;
    expect(await other.checkout(customerId, 'fail')).toEqual({ status: 'past_due', webhookStatus: 200 });
    await expect.poll(async () => (await other.state()).messages.some((m) => m.text === BILLING_COPY.past_due), { timeout: 30_000 }).toBe(true);
    expect(await other.checkout(customerId, 'pay')).toEqual({ status: 'active', webhookStatus: 200 });
    expect(await other.checkout(customerId, 'cancel')).toEqual({ status: 'cancelled', webhookStatus: 200 });
    await expect
      .poll(async () => (await db.withSystem('console', (tx) => tx.select().from(schema.business).where(eq(schema.business.id, businessId))))[0]?.status, { timeout: 30_000 })
      .toBe('cancelled');
  } finally {
    await other.close();
  }
}, 120_000);

async function shot(page: Page, record: E2eRecord, name: string, title: string) {
  const path = `${SHOTS}/simulated-dev-${name}.png`;
  const image = await page.screenshot({ path, fullPage: true });
  (record.screenshots ??= []).push({
    at: new Date().toISOString(),
    title,
    image: { ref: path, mimeType: 'image/png', src: `data:image/png;base64,${image.toString('base64')}` },
  });
}

function onePixelPng(): Buffer {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
}
