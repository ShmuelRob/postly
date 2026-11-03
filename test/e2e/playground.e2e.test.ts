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
import { onboardingCopy as copy } from '../../src/modules/workflow/index.js';
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
  expect((await replies())[0]).toContain(copy.intro);

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
