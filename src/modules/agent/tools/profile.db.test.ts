import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { AgentToolCall } from '../../../contracts/agent.js';
import { createDatabase } from '../../../db/index.js';
import * as schema from '../../../db/schema.js';
import { ModelSimulator } from '../../../simulators/model.js';
import { call, step } from '../../../simulators/scripted-agent.js';
import { createModelLayer } from '../../model-layer/index.js';
import { onboardingDone } from '../agents/onboarding.js';
import { createAgent } from '../index.js';

// The onboarding agent's tool and done rules (WP-92, agent.md: set_profile_field, Agents), on the
// scripted agent. No real model.

const db = createDatabase(inject('databaseUrls'), { max: 3 });
afterAll(() => db.close());

let businessId: string;
let sim: ModelSimulator;
const sent: string[] = [];
const trigger = { kind: 'event', name: 'test' } as const;

async function newBusiness(status: 'onboarding' | 'active', ownerText: string, step: 'profile_questions' | 'brand_assets' | 'profile_review' = 'profile_questions') {
  businessId = randomUUID();
  const approver = `+9725${Math.floor(1e7 + Math.random() * 9e7)}`;
  await db.withBusiness('workflow', businessId, async (tx) => {
    await tx.insert(schema.business).values({ id: businessId, name: '', status, approverPhone: approver, profile: { approverPhone: approver } });
    await tx.insert(schema.conversationState).values({ businessId, step });
  });
  await say(ownerText);
}

async function say(text: string) {
  await db.withBusiness('messaging', businessId, (tx) =>
    tx.insert(schema.message).values({ businessId, direction: 'inbound', kind: 'text', provider: 'sim', providerMessageId: randomUUID(), fromPhone: '+972500000001', toPhone: '+972500000000', body: text }),
  );
}

const profile = () => db.withBusiness('workflow', businessId, async (tx) => (await tx.select().from(schema.business))[0]!);
const turnResults = async (turnId: string) => {
  const [turn] = await db.withBusiness('workflow', businessId, (tx) => tx.select().from(schema.agentTurn).where(eq(schema.agentTurn.id, turnId)));
  return (turn!.steps as { calls: { result: { status: string; reason?: string; data?: Record<string, unknown> } }[] }[]).flatMap((s) => s.calls.map((c) => c.result));
};
const agent = () =>
  createAgent({
    db,
    models: createModelLayer({ db, providers: { google: sim } }),
    messaging: { sendText: async (_b, r) => (sent.push(r.text), { providerMessageId: randomUUID() }) },
    events: { questionAsked: async () => {} },
  });

beforeEach(() => {
  sim = new ModelSimulator({ defaults: false });
  sent.length = 0;
});
afterEach(() => expect(sim.agentScriptProblems()).toEqual([]));

describe('set_profile_field', () => {
  it('saves a field quoted from the owner, and the business name with it', async () => {
    await newBusiness('onboarding', 'קוראים לנו פרחי דנה, חנות פרחים בכפר סבא');
    sim.scriptAgent('onboarding', [step(call.setProfileField('name', 'פרחי דנה', 'פרחי דנה'), call.setProfileField('field', 'חנות פרחים', 'חנות פרחים'), call.endTurn())]);
    const result = await agent().runTurn(businessId, 'onboarding', trigger);
    expect((await turnResults(result.turnId!)).map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
    expect(await profile()).toMatchObject({ name: 'פרחי דנה', profile: { name: 'פרחי דנה', field: 'חנות פרחים' } });
  });

  it('refuses a quote that is not in the owner messages, and a number that is not in the quote', async () => {
    await newBusiness('onboarding', 'פתוחים מ-8 בבוקר');
    sim.scriptAgent('onboarding', [
      step(call.setProfileField('name', 'פרחי דנה', 'פרחי דנה')),
      step(call.setProfileField('location.hours', 'א-ה 9:00-19:00', 'פתוחים מ-8 בבוקר')),
      step(call.endTurn()),
    ]);
    const result = await agent().runTurn(businessId, 'onboarding', trigger);
    expect((await turnResults(result.turnId!)).map((r) => r.reason ?? r.status)).toEqual(['quote_not_found', 'value_not_in_quote', 'ok']);
    expect((await profile()).profile).toEqual({ approverPhone: expect.any(String) });
  });

  it('matches whole numbers only: "2" is not inside "20"', async () => {
    await newBusiness('onboarding', 'פתוחים עד 20:00');
    sim.scriptAgent('onboarding', [step(call.setProfileField('location.hours', 'א-ה 2-20', 'פתוחים עד 20:00')), step(call.endTurn())]);
    const result = await agent().runTurn(businessId, 'onboarding', trigger);
    expect((await turnResults(result.turnId!))[0]).toMatchObject({ status: 'refused', reason: 'value_not_in_quote' });
  });

  it('keeps the parts of a nested field until the whole object is known, across turns', async () => {
    await newBusiness('onboarding', 'אנחנו בכפר סבא, ויצמן 10');
    sim.scriptAgent(
      'onboarding',
      [step(call.setProfileField('location.city', 'כפר סבא', 'כפר סבא'), call.setProfileField('location.address', 'ויצמן 10', 'ויצמן 10'), call.endTurn())],
      [step(call.setProfileField('location.hours', 'א-ה 9-19', 'א-ה 9-19'), call.setProfileField('location.fulfillment', ['pickup'], 'רק איסוף'), call.endTurn())],
    );
    const first = await agent().runTurn(businessId, 'onboarding', trigger);
    expect((await turnResults(first.turnId!))[1]).toMatchObject({ status: 'ok', data: { saved: false, waitingFor: ['location.hours', 'location.fulfillment'] } });
    expect((await profile()).profile).not.toHaveProperty('location');

    await say('פתוחים א-ה 9-19, רק איסוף');
    await agent().runTurn(businessId, 'onboarding', trigger);
    expect((await profile()).profile).toMatchObject({ location: { city: 'כפר סבא', address: 'ויצמן 10', hours: 'א-ה 9-19', fulfillment: ['pickup'] } });
  });

  it('matches a phone in either form, and takes a tone setting without a quote', async () => {
    await newBusiness('onboarding', 'הטלפון שלנו 050-1234567');
    sim.scriptAgent('onboarding', [step(call.setProfileField('contact.phone', '+972501234567', 'הטלפון שלנו 050-1234567'), call.setProfileField('tone.emoji', false), call.endTurn())]);
    const result = await agent().runTurn(businessId, 'onboarding', trigger);
    expect((await turnResults(result.turnId!)).map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
    expect((await profile()).profile).toMatchObject({ contact: { phone: '+972501234567' } });
  });

  it('on an active business, saves the change and code tells the owner exactly what changed (A7)', async () => {
    await newBusiness('active', 'מעכשיו אנחנו פתוחים עד 20:00');
    await db.withBusiness('workflow', businessId, (tx) =>
      tx
        .update(schema.business)
        .set({ profile: { approverPhone: '+972500000009', location: { city: 'כפר סבא', address: 'ויצמן 10', hours: 'א-ה 9-19', fulfillment: ['pickup'] } } })
        .where(eq(schema.business.id, businessId)),
    );
    sim.scriptAgent('onboarding', [step(call.setProfileField('location.hours', 'א-ה 9-20:00', 'פתוחים עד 20:00'), call.endTurn())]);
    await agent().runTurn(businessId, 'onboarding', trigger);
    expect((await profile()).profile).toMatchObject({ location: { hours: 'א-ה 9-20:00' } });
    expect(sent).toEqual(['עדכנתי בפרופיל כתובת ושעות: כפר סבא, ויצמן 10, א-ה 9-20:00, איסוף עצמי']);
  });

  it('refuses a channel change after onboarding (A7)', async () => {
    await newBusiness('active', 'רק אינסטגרם מעכשיו');
    sim.scriptAgent('onboarding', [step(call.setProfileField('channels', ['instagram'], 'רק אינסטגרם')), step(call.endTurn())]);
    const result = await agent().runTurn(businessId, 'onboarding', trigger);
    expect((await turnResults(result.turnId!))[0]).toMatchObject({ status: 'refused', reason: 'not_allowed' });
  });

  it('can never name the approver, the style, the logo or the persona', () => {
    for (const field of ['approverPhone', 'style', 'brand.logoAssetId', 'persona.agentName', 'persona']) {
      expect(AgentToolCall.safeParse({ tool: 'set_profile_field', field, value: 'x', sourceQuote: 'x' }).success, field).toBe(false);
    }
  });
});

describe('done rules (agent.md, Agents)', () => {
  const full = {
    name: 'פרחי דנה',
    field: 'חנות פרחים',
    mainProducts: ['זרים'],
    location: { city: 'כפר סבא', address: 'ויצמן 10', hours: 'א-ה 9-19', fulfillment: ['pickup'] },
    differentiator: 'פרחים טריים כל בוקר',
    channels: ['instagram'],
  };
  const setProfile = (value: object) =>
    db.withBusiness('workflow', businessId, (tx) => tx.update(schema.business).set({ profile: value }).where(eq(schema.business.id, businessId)));

  it('profile_questions: done once every field is set and "anything else?" was asked in an earlier turn', async () => {
    await newBusiness('onboarding', 'זהו');
    await setProfile(full);
    sim.scriptAgent('onboarding', [step(call.askOwner('יש עוד משהו שלקוחות צריכים לדעת?', { topic: 'anything_else' }))], [step(call.endTurn())]);
    const asked = await agent().runTurn(businessId, 'onboarding', trigger);
    expect(asked.stopReason).toBe('waiting_for_owner');
    expect(await onboardingDone(db, businessId, asked.turnId!)).toBe(false);
    const answered = await agent().runTurn(businessId, 'onboarding', trigger);
    expect(await onboardingDone(db, businessId, answered.turnId!)).toBe(true);
  });

  it('profile_questions: not done while a required field is missing, even after a decline', async () => {
    await newBusiness('onboarding', 'אין עוד');
    await setProfile({ ...full, differentiator: undefined });
    sim.scriptAgent('onboarding', [step(call.recordDecline('anything_else', 'אין עוד')), step(call.endTurn())]);
    const result = await agent().runTurn(businessId, 'onboarding', trigger);
    expect(result.stopReason).toBe('end_turn');
    expect(await onboardingDone(db, businessId, result.turnId!)).toBe(false);
  });

  it('brand_assets: done once the logo and the photos each arrived or were declined', async () => {
    await newBusiness('onboarding', 'אין לנו לוגו וגם לא תמונות כרגע', 'brand_assets');
    sim.scriptAgent('onboarding', [step(call.recordDecline('logo', 'אין לנו לוגו'), call.recordDecline('business_photos', 'לא תמונות כרגע'))]);
    const result = await agent().runTurn(businessId, 'onboarding', trigger);
    expect(result.stopReason).toBe('done');
  });
});
