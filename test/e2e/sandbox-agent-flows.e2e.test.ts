/**
 * The agents on dev, through the sandbox (agent.md, Running on dev; docs/deployment.md, "Real Gemini and
 * the agents on dev"). The web process is composed as main.ts composes it (`oneShotFlows: false`, which
 * main.ts always passes), so the onboarding, weekly and drafts flows run on the agents with no switch: the human presses
 * "new sign-up from this number" in the sandbox and onboarding runs on the agent.
 *
 * The model is the scripted agent, never Gemini: each turn below is what the model would answer, and every
 * tool call still goes through the real checks. Dev runs the same composition on Vertex AI. The file keeps
 * a Postgres of its own, so its sign-ups never mix with other files' businesses.
 */
import { mkdirSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, expect } from 'vitest';
import { createSandbox, type Sandbox } from '../../playground/sandbox/sandbox.js';
import { startSandboxUi, type SandboxUi } from '../../playground/sandbox/ui.js';
import { createDatabase } from '../../src/db/index.js';
import { createPostgresSimulatorStore } from '../../src/db/simulator-store.js';
import * as schema from '../../src/db/schema.js';
import { onboardingBatches } from '../../src/modules/agent/index.js';
import { onboardingCopy as copy } from '../../src/modules/workflow/index.js';
import { startSimulatedProcess, type SimulatedProcess } from '../../src/simulated.js';
import { call, step } from '../../src/simulators/scripted-agent.js';
import { ModelSimulator } from '../../src/simulators/index.js';
import { startTestDatabase, type TestDatabase } from '../db/start-database.js';
import { e2eTest } from './harness/index.js';
import type { E2eRecord } from './harness/record.js';

const SHOTS = 'reports/sandbox-agent-flows';
const OWNER = '+972501234566';
const BUSINESS_PHONE = '+972521111166';
const PUBLIC_BASE_URL = 'https://postly-dev-web.example.test';
// A test-only value; in dev the secret comes from Secret Manager.
const SECRET = 'test-only';

// What the owner writes, and the agent's questions (the scripted model's answers; feminine Hebrew).
const SAY = {
  hello: 'היי, נרשמתי לפוסטלי',
  business: 'קוראים לנו הפרחים של רינה, חנות פרחים. זרים, עציצים ומשלוחים לאירועים',
};
const ASK = {
  // The agent's follow-up on batch A (agent.md, A11); code appends batch B to it.
  where: 'תודה! איפה החנות נמצאת, ומה שעות הפתיחה?',
};

let database: TestDatabase;
let db: ReturnType<typeof createDatabase>;
let store: ReturnType<typeof createPostgresSimulatorStore>;
let model: ModelSimulator;
let web: SimulatedProcess;
let sandbox: Sandbox;
let ui: SandboxUi;
let browser: Browser;

beforeAll(async () => {
  database = await startTestDatabase({ isolated: true });
  db = createDatabase(database.urls, { max: 2 });
  store = createPostgresSimulatorStore(database.simulatorStoreUrl);
  model = new ModelSimulator({ strictAgents: true });
  web = await startSimulatedProcess({
    role: 'web',
    databaseUrls: database.urls,
    store,
    webhookSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE_URL,
    businessNumber: BUSINESS_PHONE,
    sandboxUrl: 'http://sandbox.dev.test',
    burstQuietMs: 300,
    models: { google: model },
    // As main.ts composes every deployed web process.
    oneShotFlows: false,
  });
  sandbox = await createSandbox({
    databaseUrls: database.urls,
    store,
    webhookSecret: SECRET,
    publicBaseUrl: PUBLIC_BASE_URL,
    webUrl: web.url!,
    businessNumber: BUSINESS_PHONE,
    ownerPhone: OWNER,
  });
  ui = await startSandboxUi(sandbox, { port: 0 });
  browser = await chromium.launch();
  mkdirSync(SHOTS, { recursive: true });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await ui?.close();
  await sandbox?.close();
  await web?.close();
  await db?.close();
  await store?.close();
  await database?.stop();
});

e2eTest('dev runs the agents with no switch: a new sign-up in the sandbox onboards through the agent', async ({ task, e2e }) => {
  void e2e;
  const record = task.meta.e2e!;
  const timeout = { timeout: 30_000 };
  const replies = async () => (await sandbox.state()).messages.filter((m) => m.direction === 'to_owner').map((m) => m.text ?? '');
  const lastReply = async () => (await replies()).at(-1) ?? '';
  const write = (text: string) => sandbox.send({ kind: 'text', text });

  model.scriptAgent(
    'onboarding',
    // Batch A went out by code after the intro (agent.md, A11). Its answer: one step saves the owner's
    // own words and asks the follow-up, and code appends batch B.
    [
      step(
        call.setProfileField('name', 'הפרחים של רינה', 'הפרחים של רינה'),
        call.setProfileField('field', 'חנות פרחים', 'חנות פרחים'),
        call.setProfileField('mainProducts', ['זרים', 'עציצים', 'משלוחים לאירועים'], 'זרים, עציצים ומשלוחים לאירועים'),
        call.askOwner(ASK.where, { topic: 'profile:location', fields: ['location'] }),
      ),
    ],
  );

  // "New sign-up from this number" (הרשמה חדשה מהמספר הזה): a business in onboarding, nothing switched on for it.
  const businessId = await sandbox.signUp();
  const [business] = await db.withSystem('console', (tx) => tx.select().from(schema.business).where(eq(schema.business.id, businessId)));
  expect(business).toMatchObject({ status: 'onboarding' });
  expect(business).not.toHaveProperty('agentFlows');

  // 1. The persona introduces herself, and code sends batch A of the profile questions (A11), no model call.
  await write(SAY.hello);
  await expect.poll(lastReply, timeout).toBe(onboardingBatches.a);
  expect(await replies()).toEqual([copy.intro('פוסטלי'), onboardingBatches.a]);
  expect((await replies())[0]).toContain('אני פוסטלי, סוכנת הסושיאל');

  // 2. The answer is saved from the owner's words; the agent's follow-up carries batch B.
  await write(SAY.business);
  await expect.poll(lastReply, timeout).toBe(`${ASK.where}\n\n${onboardingBatches.b}`);
  expect(await replies()).not.toContain(copy.questions.location);

  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(ui.url);
  await expect.poll(() => page.getByTestId('chat').getByTestId('bubble-to_owner').count(), timeout).toBe(3);
  await shot(page, record, 'onboarding-agent', 'The sandbox on dev with the agent flows on: onboarding through the agent');
  await page.close();

  // The one turn ran on the onboarding agent and finished; the profile holds what the owner said.
  const stored = await db.withBusiness('workflow', businessId, async (tx) => ({
    business: (await tx.select().from(schema.business))[0]!,
    turns: await tx.select().from(schema.agentTurn),
  }));
  expect(stored.business.profile).toMatchObject({ name: 'הפרחים של רינה', field: 'חנות פרחים', mainProducts: ['זרים', 'עציצים', 'משלוחים לאירועים'] });
  expect(stored.turns).toHaveLength(1);
  expect(stored.turns.every((t) => t.agent === 'onboarding' && t.status !== 'failed' && t.status !== 'handed_off')).toBe(true);
  expect(model.agentScriptProblems()).toEqual([]);

  record.transcript.push(...(await sandbox.transcript()));
  record.agentSteps = model.agentSteps.map((s) => ({ ...s, at: new Date().toISOString() }));
}, 120_000);

async function shot(page: Page, record: E2eRecord, name: string, title: string) {
  const path = `${SHOTS}/${name}.png`;
  const image = await page.screenshot({ path, fullPage: true });
  (record.screenshots ??= []).push({
    at: new Date().toISOString(),
    title,
    image: { ref: path, mimeType: 'image/png', src: `data:image/png;base64,${image.toString('base64')}` },
  });
}
