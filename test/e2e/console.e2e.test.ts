/**
 * The redesigned team console (technical-design.md, "Console (Phase 1)"; security.md, "Media in the
 * console" and "What the console may change"), seen by a team member in a browser. The real app runs
 * on the simulators (`createApp`: messaging, the workflow, the model layer on the model simulator,
 * the design engine with Playwright, the database): a Hebrew-speaking owner onboards, sends a weekly
 * update, and approves one draft, so real posts, versions, renders and model runs exist. The console
 * runs as its own server (`buildConsoleServer`, dev bypass, on 127.0.0.1) with the app's media
 * store, and Playwright looks at Overview, Manage, Conversations and a model run on a desktop and a
 * phone, edits the profile and an agent limit through the forms, and reads the action log.
 *
 * Seeded rather than driven: one open `model_validation_failed` console item (pointing at a real
 * model run of the business), and one agent turn only when the flow ran none.
 */
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, expect, inject } from 'vitest';
import { createApp } from '../../src/app.js';
import { buildConsoleServer } from '../../src/console-server.js';
import { decodeButtonId } from '../../src/contracts/providers/index.js';
import { createDatabase, onlyLogins, PROCESS_LOGINS } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { createConsole, DEV_ACTOR } from '../../src/modules/console/index.js';
import { createDesignRenderer } from '../../src/modules/design/index.js';
import { createWorkflow, draftsCopy, onboardingCopy as copy } from '../../src/modules/workflow/index.js';
import { conversationalModelSimulator } from '../../src/simulators/conversational/index.js';
import { MessagingSimulator, PaymentSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { inserter } from '../db/rows.js';
import { e2eTest, placeholderPng, type AppFactory, type E2eRun, type Providers } from './harness/index.js';
import type { E2eRecord } from './harness/record.js';

const SHOTS = 'reports/console';
const OWNER = '+972501234566';
const BUSINESS_PHONE = '+972521111166';
const MEDIA_ORIGIN = 'https://media.console-e2e.test/';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const db = createDatabase(inject('databaseUrls'), { max: 3 });
const consoleDb = createDatabase(onlyLogins(inject('databaseUrls'), PROCESS_LOGINS.console), { max: 2 });
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
  mkdirSync(SHOTS, { recursive: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await consoleDb.close();
  await db.close();
});

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

e2eTest('the team sees a real Hebrew conversation, its posts and model runs in the console, and edits the profile and an agent limit', async ({ task, e2e }) => {
  const record = task.meta.e2e!;
  const timeout = { timeout: 60_000 };
  const storage = memoryStorage();
  await storage.put('bundled/sample.png', placeholderPng(1080, 1080, [246, 232, 210], [150, 82, 40]), 'image/png');
  const messagingSim = new MessagingSimulator({ businessNumber: BUSINESS_PHONE });
  const publishingSim = new PublishingSimulator();
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
  const providers = {
    messaging: messagingSim,
    publishing: publishingSim,
    // Never a paid model: the conversational simulator answers every task (no-paid-LLM rule).
    model: conversationalModelSimulator(),
    payment: new PaymentSimulator(),
    renderer: { render: async () => ({}) },
    design,
  } satisfies Providers;

  const ref: { postly?: ReturnType<typeof createApp>; run?: E2eRun } = {};
  const app: AppFactory = ({ messaging, publishing, model, design: recordedDesign }) => {
    ref.postly = createApp({
      db,
      // This test drives the one-shot onboarding (agent.md, A9), which only tests compose.
      oneShotFlows: true,
      providers: { messaging, publishing, models: { google: model } },
      design: recordedDesign!,
      media: storage,
      businessNumber: BUSINESS_PHONE,
      samplePhotoUrl: storage.urlFor('bundled/sample.png'),
      onAgentTurnEnd: (turn) => ref.run?.recordAgentTurn(turn as never),
    });
    return {
      async deliverInbound(message) {
        await ref.postly!.messaging.receive(message);
        await ref.postly!.messaging.flushBursts();
      },
    };
  };
  // approver_phone is unique: free the fixture number from an earlier run first.
  await db.withSystem('console', (tx) => tx.update(schema.business).set({ approverPhone: `+9724${Date.now()}` }).where(eq(schema.business.approverPhone, OWNER)));
  const run = await e2e.start({ providers, app, ownerPhone: OWNER, businessPhone: BUSINESS_PHONE, readMedia: storage.read });
  ref.run = run;
  const postly = ref.postly!;
  const owner = run.owner;
  const lastReply = () => owner.received().at(-1)?.text ?? '';

  let server: ReturnType<typeof buildConsoleServer> | undefined;
  let page: Page | undefined;
  const restore: Array<() => Promise<unknown>> = [];
  try {
    // 1. The real flow: onboarding in Hebrew, then a weekly update with drafts; the owner approves one.
    const businessId = await postly.onboarding.createBusiness({ approverPhone: OWNER });
    await owner.sendsText('היי, נרשמתי לפוסטלי');
    await expect.poll(lastReply, timeout).toContain(copy.questions.business);
    await owner.sendsText('מאפיית השכונה, מאפייה, חלות ועוגות שמרים');
    await expect.poll(lastReply, timeout).toContain(copy.questions.location);
    await owner.sendsText('רחוב הרצל 12 בחולון, פתוחים א׳-ה׳ 7:00-19:00, רק איסוף עצמי');
    await expect.poll(lastReply, timeout).toContain(copy.questions.audience);
    await owner.sendsText('משפחות מהשכונה. הבצק שלנו תופח 24 שעות');
    await expect.poll(lastReply, timeout).toContain(copy.questions.channels);
    await owner.sendsText('אינסטגרם ופייסבוק. בשבת לא מפרסמים');
    await expect.poll(lastReply, timeout).toContain(copy.askLogo);
    await owner.sendsImage(messagingSim.addMedia('image/png', placeholderPng(400, 400, [250, 245, 235], [140, 70, 30])));
    await expect.poll(lastReply, timeout).toContain(copy.askPhotos);
    await owner.sendsText('סיימתי');
    await expect.poll(lastReply, { timeout: 120_000 }).toContain(copy.chooseStyle);
    await owner.sendsText('2');
    await expect.poll(lastReply, timeout).toContain('סגנון: חם');
    await owner.sendsText('מאשר');
    await expect.poll(lastReply, timeout).toMatch(/^מצוין! הצעד האחרון: חיבור הרשתות/);
    const link = publishingSim.connectionLinks.filter((l) => l.request.businessId === businessId).at(-1)!;
    for (const network of link.request.networks) publishingSim.connect(businessId, network);
    await owner.sendsText('חיברתי');
    await expect.poll(() => owner.received().some((m) => m.text?.includes(copy.activated)), timeout).toBe(true);

    await owner.sendsText('השבוע יש לנו עוגות שמרים חדשות, ובשישי מבצע על חלות לשבת');
    const step = async () => (await db.withSystem('console', (tx) => tx.select().from(schema.conversationState).where(eq(schema.conversationState.businessId, businessId))))[0]?.step;
    await expect.poll(step, { timeout: 120_000 }).toBe('reviewing_drafts');
    const approve = owner.received().flatMap((m) => m.buttons ?? []).filter((b) => b.title === draftsCopy.APPROVE_TITLE).at(-1)!;
    await owner.tapsButton(draftsCopy.APPROVE_TITLE, decodeButtonId(approve.id)!);
    const approvals = () => db.withSystem('console', (tx) => tx.select().from(schema.approval).where(eq(schema.approval.businessId, businessId)));
    await expect.poll(async () => (await approvals()).length, timeout).toBe(1);
    const approvalsBefore = await approvals();
    const publicationsBefore = await db.withSystem('console', (tx) => tx.select().from(schema.publication).where(eq(schema.publication.businessId, businessId)));

    // 2. Seeded: an open review item about one of the business's real model runs, and an agent turn if none ran.
    const runs = await db.withSystem('console', (tx) => tx.select().from(schema.modelRun).where(eq(schema.modelRun.businessId, businessId)));
    expect(runs.length).toBeGreaterThan(0);
    const modelRun = runs[0]!;
    const [item] = await db.withSystem('console', (tx) =>
      tx.insert(schema.consoleItem).values({ businessId, kind: 'model_validation_failed', referenceId: modelRun.id, details: { task: modelRun.task } }).returning(),
    );
    const turns = await db.withSystem('console', (tx) => tx.select().from(schema.agentTurn).where(eq(schema.agentTurn.businessId, businessId)));
    if (turns.length === 0) {
      await db.withBusiness(inserter('agent_turn'), businessId, (tx) =>
        tx.insert(schema.agentTurn).values({ businessId, agent: 'weekly', status: 'done', trigger: { kind: 'event', name: 'console-e2e' }, endedAt: new Date() }),
      );
    }

    // 3. The console server, signed in through the local dev bypass, with the app's media store.
    server = buildConsoleServer({
      console: createConsole(consoleDb, createWorkflow(consoleDb, { rejected: () => {} })),
      auth: { mode: 'dev-bypass' },
      log: () => {},
      readMedia: async (path: string) => {
        const file = await storage.read(path);
        if (!file) throw new Error(`no stored file at ${path}`);
        return file.data;
      },
    });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}/console`;
    const api = async (path: string) => (await fetch(`${base}/api${path}`)).json() as Promise<any>;

    page = await browser.newPage({ viewport: DESKTOP });
    const open = async (query: string) => {
      const res = await page!.goto(`${base}${query}`);
      expect(res?.status()).toBe(200);
    };
    const confirm = async () => {
      const dialog = page!.locator('dialog#confirm');
      await dialog.waitFor({ state: 'visible' });
      const reason = dialog.locator('input[name=reason]');
      if (await reason.count()) await reason.fill('console e2e');
      await Promise.all([page!.waitForEvent('load'), dialog.locator('button[value=ok]').click()]);
    };

    // Overview: the health at a glance.
    await open('?tab=overview');
    await expect.poll(() => page!.getByTestId('overview').isVisible()).toBe(true);
    await expect.poll(() => page!.getByTestId('tab-overview').isVisible()).toBe(true);
    await shot(page, record, 'desktop-overview', 'Console overview (desktop)');

    // Manage: the review queue holds the seeded item, linked to its business's conversation.
    await open('?tab=manage');
    const queue = page.getByTestId('review-queue');
    await expect.poll(() => queue.isVisible()).toBe(true);
    await expect.poll(() => queue.innerText()).toContain('model validation failed');
    const itemLink = queue.locator(`a[href*="business=${businessId}"][href*="tab=conversations"]`).first();
    expect(await itemLink.count()).toBe(1);
    const itemRunLink = queue.locator(`a[href*="run=${modelRun.id}"]`);
    expect(await itemRunLink.count()).toBeGreaterThan(0);
    await shot(page, record, 'desktop-manage', 'Console manage tab with the review queue (desktop)');

    // The item's link opens the conversation: Hebrew bubbles, right to left, and the client panel.
    await Promise.all([page.waitForEvent('load'), itemLink.click()]);
    expect(page.url()).toContain(`business=${businessId}`);
    const chat = page.getByTestId('chat');
    await expect.poll(() => chat.isVisible()).toBe(true);
    expect(await page.getByTestId('conversation-list').isVisible()).toBe(true);
    const inbound = chat.getByTestId('bubble-inbound');
    const outbound = chat.getByTestId('bubble-outbound');
    expect(await inbound.count()).toBeGreaterThan(5);
    expect(await outbound.count()).toBeGreaterThan(5);
    await expect.poll(() => chat.innerText()).toContain('מאפיית השכונה, מאפייה, חלות ועוגות שמרים');
    // The owner's Approve tap reads as a tap, not an empty bubble.
    await expect.poll(() => chat.getByTestId('button-tap').first().innerText()).toMatch(/^Tapped approve on post [0-9a-f]{8}$/);
    const direction = await inbound.first().evaluate((el) => {
      const target = el.matches('[dir]') ? el : (el.querySelector('[dir="auto"]') ?? el.closest('[dir]') ?? el);
      return { dir: target.getAttribute('dir'), direction: getComputedStyle(target).direction };
    });
    expect(direction).toEqual({ dir: 'auto', direction: 'rtl' });

    const panel = page.getByTestId('client-panel');
    await expect.poll(() => panel.isVisible()).toBe(true);
    expect(await panel.getByTestId('post-card').count()).toBeGreaterThan(0);
    // The approval state is shown (read only), and the rendered images load through /console/media.
    await expect.poll(() => panel.innerText()).toMatch(/approved/i);
    const images = panel.locator('img[src*="/console/media/"]');
    await expect.poll(() => images.count(), timeout).toBeGreaterThan(0);
    await images.first().scrollIntoViewIfNeeded();
    await expect.poll(() => images.first().evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0), timeout).toBe(true);
    expect(await page.locator('[data-action*="approv" i], [data-action*="publish" i]').count()).toBe(0);
    await shot(page, record, 'desktop-conversations', 'Console conversation with the client panel (desktop)');

    // A model run on its own view, from the review item.
    await open(`?tab=manage&run=${modelRun.id}`);
    const runView = page.getByTestId('model-run');
    await expect.poll(() => runView.isVisible()).toBe(true);
    await expect.poll(() => runView.innerText()).toContain(modelRun.task);
    await shot(page, record, 'desktop-model-run', 'Console model run detail (desktop)');

    // 4. A profile edit through the form: the change shows and the action log names the actor.
    await open(`?tab=manage&business=${businessId}&panel=profile`);
    const profileForm = page.getByTestId('profile-form');
    await expect.poll(() => profileForm.isVisible()).toBe(true);
    const profile = JSON.parse(await profileForm.locator('textarea[name=profile]').inputValue());
    const differentiator = 'בצק שתופח 48 שעות, אפייה כל בוקר';
    await profileForm.locator('textarea[name=profile]').fill(JSON.stringify({ ...profile, differentiator }, null, 2));
    const formReason = profileForm.locator('input[name=reason]');
    if (await formReason.count()) await formReason.fill('owner called');
    await profileForm.locator('button[type=submit], button:not([type])').first().click();
    await confirm();
    await expect.poll(() => page!.getByTestId('profile-form').locator('textarea[name=profile]').inputValue()).toContain(differentiator);
    const stored = (await db.withSystem('console', (tx) => tx.select().from(schema.business).where(eq(schema.business.id, businessId))))[0]!;
    expect(stored.profile).toMatchObject({ differentiator, approverPhone: OWNER });

    // 5. An agent limit through its row's form.
    const original = ((await api('/agent-config')) as any[]).find((a) => a.agent === 'drafts');
    restore.push(() => createConsole(consoleDb, createWorkflow(consoleDb, { rejected: () => {} })).setAgentConfig('drafts', { maxRefusals: original.maxRefusals }, { actor: 'console-e2e-restore' }));
    await open('?tab=manage');
    const acForm = page.locator('form#ac-drafts[data-testid=agent-config-form][data-agent=drafts]');
    expect(await acForm.count()).toBe(1);
    const maxRefusals = page.locator('input[name=maxRefusals][form=ac-drafts]');
    await maxRefusals.fill(String(original.maxRefusals + 1));
    await acForm.locator('button').first().click();
    await confirm();
    await expect.poll(() => page!.locator('input[name=maxRefusals][form=ac-drafts]').inputValue()).toBe(String(original.maxRefusals + 1));
    expect(((await api('/agent-config')) as any[]).find((a) => a.agent === 'drafts').maxRefusals).toBe(original.maxRefusals + 1);

    // The action log lists both writes with the signed-in actor, newest first.
    const log = (await api('/actions')) as any[];
    expect(log.find((a) => a.action === 'agent_config' && a.target === 'drafts')).toMatchObject({ actor: DEV_ACTOR });
    expect(log.find((a) => a.action === 'profile' && a.businessId === businessId)).toMatchObject({ actor: DEV_ACTOR, target: businessId });
    const logText = await page.getByTestId('action-log').innerText();
    expect(logText).toContain(DEV_ACTOR);
    expect(logText).toMatch(/agent config/);
    expect(logText).toMatch(/profile/);
    await shot(page, record, 'desktop-action-log', 'Console manage tab after the profile and agent-limit edits, with the action log');

    // The console changed no approval and no publication.
    expect(await approvals()).toEqual(approvalsBefore);
    expect(await db.withSystem('console', (tx) => tx.select().from(schema.publication).where(eq(schema.publication.businessId, businessId)))).toEqual(publicationsBefore);
    await page.close();

    // 6. On a phone: one column, no sideways scroll; Conversations as the list, the chat, and the client panel.
    page = await browser.newPage({ viewport: PHONE, isMobile: true, hasTouch: true });
    const noSideScroll = async () => expect(await page!.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
    await open('?tab=overview');
    await expect.poll(() => page!.getByTestId('overview').isVisible()).toBe(true);
    await noSideScroll();
    await shot(page, record, 'phone-overview', 'Console overview (phone)');
    await open('?tab=manage');
    await expect.poll(() => page!.getByTestId('review-queue').isVisible()).toBe(true);
    await noSideScroll();
    await shot(page, record, 'phone-manage', 'Console manage tab (phone)');
    await open('?tab=conversations');
    await expect.poll(() => page!.getByTestId('conversation-list').isVisible()).toBe(true);
    await noSideScroll();
    await shot(page, record, 'phone-conversation-list', 'Console conversation list (phone)');
    await open(`?tab=conversations&business=${businessId}`);
    await expect.poll(() => page!.getByTestId('chat').isVisible()).toBe(true);
    expect(await page.getByTestId('chat').getByTestId('bubble-inbound').count()).toBeGreaterThan(0);
    await noSideScroll();
    await shot(page, record, 'phone-chat', 'Console chat (phone)');
    await open(`?tab=conversations&business=${businessId}&panel=client`);
    await expect.poll(() => page!.getByTestId('client-panel').isVisible()).toBe(true);
    await noSideScroll();
    await shot(page, record, 'phone-client', 'Console client panel (phone)');
    await open(`?tab=conversations&business=${businessId}&run=${modelRun.id}`);
    await expect.poll(() => page!.getByTestId('model-run').isVisible()).toBe(true);
    await shot(page, record, 'phone-model-run', 'Console model run detail (phone)');

    run.recordConsoleItems([{ kind: item!.kind, details: item!.details }]);
  } finally {
    for (const undo of restore) await undo().catch(() => {});
    await page?.close().catch(() => {});
    await server?.close();
    await design.close();
  }
}, 420_000);

async function shot(page: Page, record: E2eRecord, name: string, title: string) {
  const path = `${SHOTS}/console-${name}.png`;
  const image = await page.screenshot({ path, fullPage: true });
  (record.screenshots ??= []).push({
    at: new Date().toISOString(),
    title,
    image: { ref: path, mimeType: 'image/png', src: `data:image/png;base64,${image.toString('base64')}` },
  });
}
