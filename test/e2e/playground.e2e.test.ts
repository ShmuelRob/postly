/**
 * Local playground (WP-45): the human plays the owner in a WhatsApp-style chat in the browser. This
 * test drives that UI with Playwright against the real playground server, which runs the real app
 * (`createApp`: the webhook route, messaging, the workflow with onboarding, the model layer, the
 * design engine, the database) on the simulators. It plays onboarding from the first message to an
 * active business, as the human would, and checks the chat, the state panel and the mock feed.
 */
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, expect, inject } from 'vitest';
import { createPlayground, type Playground } from '../../playground/server/playground.js';
import { startPlaygroundUi, type PlaygroundUi } from '../../playground/ui-server.js';
import { draftsCopy, onboardingCopy as copy, scheduleCopy } from '../../src/modules/workflow/index.js';
import { e2eTest } from './harness/index.js';
import type { E2eRecord } from './harness/record.js';

const SHOTS = 'reports/playground';

let playground: Playground;
let ui: PlaygroundUi;
let browser: Browser;

beforeAll(async () => {
  playground = await createPlayground({
    databaseUrls: inject('databaseUrls'),
    ownerPhone: '+972501234599',
    businessPhone: '+972521111199',
    burstQuietMs: 300,
    // The database is shared with the other e2e tests; the sweep would take their pending messages.
    sweep: false,
    // This test drives the one-shot flows (agent.md, A9), which only tests compose.
    oneShotFlows: true,
  });
  ui = await startPlaygroundUi(playground, { port: 0 });
  browser = await chromium.launch();
  mkdirSync(SHOTS, { recursive: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await ui?.close();
  await playground?.close();
});

e2eTest('the owner plays onboarding in the playground, from the first message to an active business', async ({ task, e2e }) => {
  // The fixture creates the record the e2e report reads; this test drives the UI, not e2e.start().
  void e2e;
  const record = task.meta.e2e!;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(ui.url);

  // Right to left, in Hebrew; a new sign-up starts in onboarding.
  await expect.poll(() => page.locator('html').getAttribute('dir')).toBe('rtl');
  const chat = page.getByTestId('chat');
  const state = page.getByTestId('state');
  const replies = () => chat.getByTestId('bubble-to_owner').allInnerTexts();
  const lastReply = async () => (await replies()).at(-1) ?? '';
  const write = async (text: string) => {
    await page.getByPlaceholder('הקלידו הודעה').fill(text);
    await page.keyboard.press('Enter');
  };
  const timeout = { timeout: 15_000 };
  await expect.poll(() => state.getByTestId('business-status').innerText()).toBe('onboarding');

  // 1. The first message: the intro and the first profile question.
  await write('היי, נרשמתי לפוסטלי');
  await expect.poll(lastReply, timeout).toContain(copy.questions.business);
  expect((await replies())[0]).toContain(copy.intro('פוסטלי'));

  // 2. A voice note answers the business question (transcribed, then extracted).
  await page.getByTestId('upload-voice').setInputFiles({ name: 'answer.ogg', mimeType: 'audio/ogg', buffer: Buffer.from('OggS') });
  await expect.poll(lastReply, timeout).toContain(copy.questions.location);

  // 3. Text answers for the rest of the profile.
  await write('רחוב הרצל 12 בחולון, פתוחים א׳-ה׳ 7:00-19:00, רק איסוף עצמי');
  await expect.poll(lastReply, timeout).toContain(copy.questions.audience);
  await write('משפחות מהשכונה. הבצק שלנו תופח 24 שעות');
  await expect.poll(lastReply, timeout).toContain(copy.questions.channels);
  await write('אינסטגרם ופייסבוק. בשבת לא מפרסמים');
  await expect.poll(lastReply, timeout).toContain(copy.askLogo);

  // 4. The logo as a photo, then no more photos: the style samples come back as images.
  await page.getByTestId('upload-image').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: onePixelPng() });
  await expect.poll(lastReply, timeout).toContain(copy.askPhotos);
  await write('סיימתי');
  await expect.poll(lastReply, { timeout: 60_000 }).toContain(copy.chooseStyle);
  const samples = chat.getByTestId('bubble-to_owner').locator('img');
  await expect.poll(() => samples.count()).toBe(3);
  await expect
    .poll(() => samples.evaluateAll((imgs) => imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0)), timeout)
    .toBe(true);
  await shot(page, record, 'samples', 'The style samples in the chat');

  // 5. The owner picks Warm, approves the summary, and gets the connection link.
  await write('2');
  await expect.poll(lastReply, timeout).toContain('סגנון: חם');
  await write('מאשר');
  await expect.poll(lastReply, timeout).toMatch(/^מצוין! הצעד האחרון: חיבור הרשתות/);

  // 6. Connecting on the publishing simulator from the state panel, then telling Postly.
  await state.getByTestId('connect-networks').click();
  await write('חיברתי');
  await expect.poll(lastReply, timeout).toContain(copy.activated);

  // 7. The state panel shows the real state from the database.
  await expect.poll(() => state.getByTestId('business-status').innerText(), timeout).toBe('active');
  await expect.poll(() => state.getByTestId('conversation-step').innerText()).toBe('idle');
  await expect.poll(() => state.getByTestId('channel-instagram').innerText()).toBe('verified');
  await expect.poll(() => state.getByTestId('channel-facebook').innerText()).toBe('verified');

  // 8. The mock feed is in place: it holds only the demo posts, onboarding published nothing.
  const feed = page.getByTestId('feed');
  for (const tab of ['Facebook', 'Instagram']) {
    await feed.getByRole('button', { name: tab }).click();
    await expect.poll(() => feed.getByTestId('feed-post').innerText()).toContain('פוסט לדוגמה');
  }
  await shot(page, record, 'active', 'The playground after onboarding: the business is active');
  await page.close();

  // The report shows the conversation as the owner saw it.
  record.transcript.push(...playground.transcript());
  record.publishing.push(...(await playground.feedRecord()));
  expect((await playground.feedRecord()).every((p) => p.caption.startsWith('פוסט לדוגמה'))).toBe(true);
}, 240_000);

e2eTest('the owner approves the week in the playground, confirms the times, and the posts reach the mock feed (WP-34)', async ({ task, e2e }) => {
  void e2e;
  const record = task.meta.e2e!;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(ui.url);
  const chat = page.getByTestId('chat');
  const state = page.getByTestId('state');
  const feed = page.getByTestId('feed');
  const replies = () => chat.getByTestId('bubble-to_owner').allInnerTexts();
  const lastReply = async () => (await replies()).at(-1) ?? '';
  const write = async (text: string) => {
    await page.getByPlaceholder('הקלידו הודעה').fill(text);
    await page.keyboard.press('Enter');
  };
  const timeout = { timeout: 60_000 };
  // Continues the business the onboarding test activated.
  await expect.poll(() => state.getByTestId('business-status').innerText(), timeout).toBe('active');
  const demo = new Set((await playground.feedRecord()).map((p) => p.idempotencyKey));
  const demoPosts = demo.size;

  // 1. The weekly update: the drafts come back with אישור and שינוי.
  await write('השבוע יש לנו עוגות שמרים חדשות, ובשישי מבצע על חלות לשבת');
  await expect.poll(() => state.getByTestId('conversation-step').innerText(), timeout).toBe('reviewing_drafts');
  const approveButtons = chat.getByRole('button', { name: draftsCopy.APPROVE_TITLE, exact: true });
  const drafts = await approveButtons.count();
  expect(drafts).toBeGreaterThan(0);
  await shot(page, record, 'drafts', 'The drafts of the week with their buttons');

  // Nothing reaches the networks before the owner approves and confirms.
  await state.getByTestId('publish-due').waitFor({ state: 'detached' }).catch(() => {});
  expect((await playground.feedRecord()).length).toBe(demoPosts);

  // 2. The owner taps אישור under every draft; after the last one Postly proposes the times.
  for (let i = 0; i < drafts; i++) {
    await approveButtons.nth(i).click();
    await expect.poll(async () => (await replies()).filter((r) => r.includes('אושר')).length, timeout).toBeGreaterThan(i);
  }
  await expect.poll(lastReply, timeout).toContain('אלה הזמנים שאני מציע');
  await expect.poll(() => state.getByTestId('conversation-step').innerText(), timeout).toBe('confirming_schedule');
  expect((await playground.feedRecord()).length).toBe(demoPosts);
  await shot(page, record, 'proposal', 'All drafts approved: the proposed publishing times');

  // 3. The owner confirms the times: the posts are scheduled, still nothing is live.
  await write('כן');
  await expect.poll(lastReply, timeout).toContain('מתוזמן');
  await expect.poll(() => state.getByTestId('conversation-step').innerText(), timeout).toBe('idle');
  expect((await playground.feedRecord()).length).toBe(demoPosts);

  // 4. Time passes to the first scheduled time: the publishing job publishes, the feed shows it.
  while (await state.getByTestId('publish-due').isVisible().catch(() => false)) {
    await state.getByTestId('publish-due').click();
    await page.waitForTimeout(1_500);
  }
  await expect.poll(async () => (await playground.feedRecord()).length, timeout).toBeGreaterThan(demoPosts);
  const published = (await playground.feedRecord()).filter((p) => !demo.has(p.idempotencyKey));
  // One post per draft on each network, and nothing else.
  expect({ instagram: published.filter((p) => p.network === 'instagram').length, facebook: published.filter((p) => p.network === 'facebook').length }).toEqual({
    instagram: drafts,
    facebook: drafts,
  });
  for (const p of published) expect(p.caption.startsWith('פוסט לדוגמה')).toBe(false);
  await feed.getByRole('button', { name: 'Instagram' }).click();
  for (const p of published.filter((x) => x.network === 'instagram')) {
    await expect.poll(async () => (await feed.getByTestId('feed-post').allInnerTexts()).join(' '), timeout).toContain(p.caption);
  }
  await expect.poll(async () => (await replies()).some((r) => r.includes(scheduleCopy.PUBLISHED_TEMPLATE)), timeout).toBe(true);
  await shot(page, record, 'published', 'After the scheduled time: the approved posts in the mock feed, and the confirmation template');
  await page.close();

  record.transcript.push(...playground.transcript());
  record.publishing.push(...published);
}, 300_000);

async function shot(page: Page, record: E2eRecord, name: string, title: string) {
  const path = `${SHOTS}/playground-${name}.png`;
  const image = await page.screenshot({ path, fullPage: true });
  (record.screenshots ??= []).push({
    at: new Date().toISOString(),
    title,
    image: { ref: path, mimeType: 'image/png', src: `data:image/png;base64,${image.toString('base64')}` },
  });
}

/** A 1x1 PNG, enough for the browser to show an image. */
function onePixelPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
}
