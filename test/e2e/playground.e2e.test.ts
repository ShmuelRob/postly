/**
 * Local playground (WP-45): the human plays the owner in a WhatsApp-style chat in the browser. This
 * test drives that UI with Playwright against the real playground server: the real messaging module
 * and webhook route, the real database, and the simulators. Until onboarding (WP-30) lands, the
 * playground's flow is an echo, so the replies asserted here are the echo's placeholder copy.
 */
import { mkdirSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, inject } from 'vitest';
import { createPlayground, type Playground } from '../../playground/server/playground.js';
import { startPlaygroundUi, type PlaygroundUi } from '../../playground/ui-server.js';
import { e2eTest } from './harness/index.js';

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

e2eTest('the owner chats in the playground and sees replies, buttons, the feed and the state', async ({ task, e2e }) => {
  // The fixture creates the record the e2e report reads; this test drives the UI, not e2e.start().
  void e2e;
  const record = task.meta.e2e!;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(ui.url);

  // Right to left, in Hebrew.
  await expect.poll(() => page.locator('html').getAttribute('dir')).toBe('rtl');
  const chat = page.getByTestId('chat');
  const lastReply = () => chat.getByTestId('bubble-to_owner').last().innerText();

  // 1. Text: the owner writes, the reply comes back through messaging and the echo flow.
  await page.getByPlaceholder('הקלידו הודעה').fill('שלום, השבוע יש מבצע על חלות');
  await page.keyboard.press('Enter');
  await expect.poll(lastReply, { timeout: 10_000 }).toContain('קיבלתי: שלום, השבוע יש מבצע על חלות');

  // 2. Reply buttons: the echo sends buttons, the owner taps one.
  await page.getByPlaceholder('הקלידו הודעה').fill('כפתורים');
  await page.keyboard.press('Enter');
  const approve = chat.getByRole('button', { name: 'אישור' }).last();
  await approve.waitFor({ timeout: 10_000 });
  await approve.click();
  await expect.poll(lastReply, { timeout: 10_000 }).toContain('לחצת: אישור');

  // 3. A photo, uploaded as a file.
  await page.getByTestId('upload-image').setInputFiles({ name: 'challah.png', mimeType: 'image/png', buffer: onePixelPng() });
  await expect.poll(lastReply, { timeout: 10_000 }).toContain('קיבלתי תמונה');
  await expect.poll(() => chat.locator('img').count()).toBeGreaterThan(0);

  // 4. A voice note, uploaded as an audio file.
  await page.getByTestId('upload-voice').setInputFiles({ name: 'note.ogg', mimeType: 'audio/ogg', buffer: Buffer.from('OggS') });
  await expect.poll(lastReply, { timeout: 10_000 }).toContain('קיבלתי הודעה קולית');

  // 5. The mock feed shows what reached the publishing simulator, with its images.
  const feed = page.getByTestId('feed');
  const imagesLoaded = () =>
    feed.locator('img').evaluateAll((imgs) => imgs.length > 0 && imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0));
  for (const tab of ['Facebook', 'Instagram']) {
    await feed.getByRole('button', { name: tab }).click();
    await expect.poll(() => feed.getByTestId('feed-post').innerText()).toContain('פוסט לדוגמה');
    await expect.poll(imagesLoaded).toBe(true);
  }

  // 6. The state panel shows the business and conversation states from the database.
  const state = page.getByTestId('state');
  await expect.poll(() => state.getByTestId('business-status').innerText()).toBe('onboarding');
  await expect.poll(() => state.getByTestId('conversation-step').innerText()).toBe('intro');

  const shot = await page.screenshot({ path: `${SHOTS}/playground.png`, fullPage: true });
  (record.screenshots ??= []).push({
    at: new Date().toISOString(),
    title: 'Playground after the conversation',
    image: { ref: `${SHOTS}/playground.png`, mimeType: 'image/png', src: `data:image/png;base64,${shot.toString('base64')}` },
  });
  await page.close();

  // The report shows the conversation as the owner saw it.
  record.transcript.push(...playground.transcript());
  record.publishing.push(...(await playground.feedRecord()));
  const replies = playground.transcript().filter((m) => m.direction === 'to_owner');
  expect(replies.map((m) => m.text)).toEqual([
    'קיבלתי: שלום, השבוע יש מבצע על חלות',
    'רוצים לנסות כפתורים?',
    'לחצת: אישור',
    'קיבלתי תמונה',
    'קיבלתי הודעה קולית',
  ]);
}, 120_000);

/** A 1x1 PNG, enough for the browser to show an image. */
function onePixelPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
}
