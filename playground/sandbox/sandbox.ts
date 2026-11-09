import { randomInt, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, eq, gt } from 'drizzle-orm';
import { SIMULATED_ENVS } from '../../src/config.js';
import type { InboundMessage, WebhookRequest } from '../../src/contracts/providers/index.js';
import { decodeButtonId } from '../../src/contracts/providers/index.js';
import type { SubscriptionState } from '../../src/contracts/state-machines/index.js';
import type { DatabaseUrls } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { PAYMENT_WEBHOOK_PATH } from '../../src/modules/billing/index.js';
import { WEBHOOK_PATH } from '../../src/modules/messaging/index.js';
import { createSimulatedApp } from '../../src/simulated.js';
import type { SimulatorStore } from '../../src/simulators/index.js';
import type { PublishingEntry, TranscriptEntry } from '../../test/e2e/harness/record.js';
import type { CheckoutOutcome, CheckoutState, OwnerInput, PlaygroundState } from '../server/api-types.js';
import { allowed, chatMessages, feedPosts, MEDIA_TYPES, NETWORKS } from '../server/views.js';
import { runApiRoute } from './errors.js';
import { crossSiteWrite } from './origin.js';

// The dev sandbox (WP-51, docs/deployment.md "The sandbox"): the playground's chat, mock feed and a
// mock checkout, for the deployed dev on the simulated providers. Unlike the playground it runs no app
// of its own: it plays the outside world. Owner messages are signed and posted over HTTP to the web
// service's webhook, payments are callbacks to its payment webhook, and everything it shows is read
// from the shared simulator store and the database.

export interface SandboxOptions {
  databaseUrls: DatabaseUrls;
  store: SimulatorStore;
  namespace?: string;
  webhookSecret: string;
  /** The web service's public URL, which the webhooks are signed over. */
  publicBaseUrl: string;
  /** Where to post the webhooks: the web service (its public URL in dev). */
  webUrl?: string;
  businessNumber: string;
  /** The number the human plays: the business's single approver. */
  ownerPhone: string;
  /** POSTLY_ENV; publish-now is refused outside the simulated environments (local, test, dev). Default `local`. */
  env?: string;
  now?: () => Date;
}

export interface Sandbox {
  readonly webUrl: string;
  /** Connect-style middleware for `/api/*`; anything else goes to `next`. */
  handle(req: IncomingMessage, res: ServerResponse, next: () => void): void;
  /** A new sign-up for the owner's number: a business in onboarding with an empty chat (an earlier one keeps its data). */
  signUp(): Promise<string>;
  send(input: OwnerInput): Promise<void>;
  /** The owner finishes the connection link on the publishing simulator. */
  connect(): Promise<void>;
  /**
   * Dev demos: moves the current sign-up's `scheduled` publications to now, so the worker's publishing
   * job (every minute) publishes them through the normal path. Publishes nothing itself.
   */
  publishNow(): Promise<number>; // how many it moved; those already due stay as they are
  /** The owner acts on the mock checkout page; the provider's callback goes to web. */
  checkout(customerId: string, outcome: CheckoutOutcome): Promise<{ status: SubscriptionState; webhookStatus: number }>;
  state(): Promise<PlaygroundState>;
  transcript(): Promise<TranscriptEntry[]>;
  feedRecord(): Promise<PublishingEntry[]>;
  close(): Promise<void>;
}

type SandboxLog = { inbound: { at: string; message: InboundMessage }[] };

export async function createSandbox(options: SandboxOptions): Promise<Sandbox> {
  const now = options.now ?? (() => new Date());
  const webUrl = (options.webUrl ?? options.publicBaseUrl).replace(/\/$/, '');
  // The sandbox's own composition is used only to sign up; it starts nothing.
  const { app, world, db, close } = await createSimulatedApp({ ...options, now });
  const owner = options.ownerPhone;

  const log = <R>(fn: (log: SandboxLog) => R) =>
    options.store.update(world.names.sandbox, async (state) => {
      const current = (state as SandboxLog | undefined) ?? { inbound: [] };
      const result = fn(current);
      return { state: current, result };
    });

  const business = async () => {
    const [row] = await db.withSystem('console', (tx) =>
      tx.select().from(schema.business).where(eq(schema.business.approverPhone, owner)).limit(1),
    );
    return row;
  };

  const post = async (path: string, hook: WebhookRequest) => {
    const res = await fetch(`${webUrl}${path}`, { method: 'POST', headers: hook.headers, body: hook.body });
    return res.status;
  };

  const deliver = async (content: InboundMessage['content']) => {
    const message = await world.messaging.run((sim) => ({ ...sim.inbound(owner, content), providerMessageId: `sbx-in-${randomUUID()}` }));
    const hook = await world.messaging.run((sim) => sim.webhook(message));
    await log((l) => void l.inbound.push({ at: message.receivedAt, message }));
    const status = await post(WEBHOOK_PATH, hook);
    if (status !== 200) throw new Error(`the web service's webhook returned ${status}`);
  };

  const send: Sandbox['send'] = async (input) => {
    switch (input.kind) {
      case 'text':
        return deliver({ kind: 'text', text: input.text });
      case 'image': {
        allowed(input.mimeType, 'image');
        const id = await world.messaging.run((sim) => sim.addMedia(input.mimeType, Buffer.from(input.dataBase64, 'base64')));
        return deliver(input.caption ? { kind: 'image', providerMediaId: id, caption: input.caption } : { kind: 'image', providerMediaId: id });
      }
      case 'voice': {
        allowed(input.mimeType, 'audio');
        const id = await world.messaging.run((sim) => sim.addMedia(input.mimeType, Buffer.from(input.dataBase64, 'base64')));
        return deliver({ kind: 'voice', providerMediaId: id });
      }
      case 'button': {
        const payload = decodeButtonId(input.buttonId);
        if (!payload) throw new Error(`button ${input.buttonId}: not an approval button`);
        return deliver({ kind: 'button_reply', buttonId: input.buttonId, payload });
      }
    }
  };

  const signUp = async () => {
    // approver_phone is unique: an earlier sign-up from this number moves to a free number.
    await db.withSystem('console', (tx) =>
      tx.update(schema.business).set({ approverPhone: `+97250${randomInt(1_000_000, 10_000_000)}` }).where(eq(schema.business.approverPhone, owner)),
    );
    // The new sign-up's chat starts empty: neither side of the earlier conversation stays.
    await log((l) => void (l.inbound = []));
    await world.messaging.run((sim) => sim.forgetSentTo(owner));
    return app.onboarding.createBusiness({ approverPhone: owner });
  };

  const connect = async () => {
    const b = await business();
    if (!b) throw new Error('sign up first');
    await world.publishing.run((sim) => {
      const link = sim.connectionLinks.filter((l) => l.request.businessId === b.id).at(-1);
      if (!link) throw new Error('onboarding has not sent the connection link yet');
      for (const network of link.request.networks) sim.connect(b.id, network);
    });
  };

  const publishNow = async () => {
    if (!SIMULATED_ENVS.includes(options.env ?? 'local')) throw new PublishNowRefused();
    const b = await business();
    if (!b) return 0;
    const p = schema.publication;
    const at = now();
    // The console role's manual scheduling (database-schema.md, its grant on publication): only the time
    // moves; the approval, its hash and the post version are the publishing job's to check, as always.
    const moved = await db.withSystem('console', (tx) =>
      tx.update(p).set({ scheduledFor: at, updatedAt: at }).where(and(eq(p.businessId, b.id), eq(p.status, 'scheduled'), gt(p.scheduledFor, at))).returning({ id: p.id }),
    );
    return moved.length;
  };

  const checkoutOf = async (businessId: string): Promise<CheckoutState | undefined> =>
    world.payment.run((sim) => {
      const link = sim.links.filter((l) => l.request.businessId === businessId).at(-1);
      if (!link) return undefined;
      const sub = sim.subscriptionOf(link.link.providerCustomerId);
      return { customerId: link.link.providerCustomerId, url: link.link.url, status: sub?.status ?? 'awaiting_payment' };
    });

  const checkout: Sandbox['checkout'] = async (customerId, outcome) => {
    const status: SubscriptionState = outcome === 'pay' ? 'active' : outcome === 'fail' ? 'past_due' : 'cancelled';
    const hook = await world.payment.run((sim) => {
      const existing = sim.subscriptionOf(customerId);
      const id = existing?.id ?? sim.completePayment(customerId, { status });
      if (existing) sim.setStatus(id, status);
      return sim.webhook(id);
    });
    return { status, webhookStatus: await post(PAYMENT_WEBHOOK_PATH, hook) };
  };

  const state = async (): Promise<PlaygroundState> => {
    const b = await business();
    const rows = b
      ? await db.withBusiness('workflow', b.id, async (tx) => ({
          conversation: await tx.select().from(schema.conversationState),
          channels: await tx.select().from(schema.channelConnection),
          posts: await tx.select().from(schema.post),
          items: await tx.select().from(schema.consoleItem),
        }))
      : { conversation: [], channels: [], posts: [], items: [] };
    const [{ inbound }, sent, posts, connectionLinkSent] = await Promise.all([
      log((l) => l),
      world.messaging.run((sim) => sim.sentTo(owner)),
      // Only this sign-up's posts: those on the accounts its business connected.
      world.publishing.run(async (sim) => {
        if (!b) return [];
        const statuses = await Promise.all(NETWORKS.map((network) => sim.getConnectionStatus({ businessId: b.id, network })));
        const accounts = new Set(statuses.flatMap((s) => (s.providerAccountId ? [s.providerAccountId] : [])));
        return sim.posts.filter((p) => accounts.has(p.request.providerAccountId));
      }),
      world.publishing.run((sim) => !!b && sim.connectionLinks.some((l) => l.request.businessId === b.id)),
    ]);
    const c = rows.conversation[0];
    const payment = b ? await checkoutOf(b.id) : undefined;
    return {
      mode: 'sandbox',
      owner,
      business: { id: b?.id ?? '', name: b?.name ?? '', status: b?.status ?? 'none' },
      conversation: c ? { step: c.step, handoff: c.handoffAt !== null } : null,
      channels: rows.channels.map((ch) => ({ network: ch.network, status: ch.status })),
      connectionLinkSent,
      posts: rows.posts.map((p) => ({ id: p.id, status: p.status, format: p.format })),
      clock: now().toISOString(),
      reviewQueue: rows.items.map((i) => ({ id: i.id, kind: i.kind, status: i.status, details: i.details })),
      messages: chatMessages(inbound, sent),
      feed: await feedPosts(posts, (id) => world.publishing.provider.getPublicationStatus(id).then((s) => s.status)),
      ...(payment ? { payment } : {}),
    };
  };

  const readMedia = async (ref: string) => (await world.media.read(ref)) ?? (await world.messaging.provider.getMedia(ref).catch(() => undefined));

  const route = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await state());
    if (req.method === 'POST' && url.pathname === '/api/messages') {
      await send((await readJson(req)) as OwnerInput);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/sign-up') return json(res, 200, { businessId: await signUp() });
    if (req.method === 'POST' && url.pathname === '/api/publish-now') {
      try {
        return json(res, 200, { moved: await publishNow() });
      } catch (error) {
        if (error instanceof PublishNowRefused) return json(res, 403, { error: error.message });
        throw error;
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/connect') {
      await connect();
      return json(res, 200, { ok: true });
    }
    const pay = url.pathname.match(/^\/api\/checkout\/([\w-]+)$/);
    if (req.method === 'GET' && pay) {
      const b = await business();
      const current = b && (await checkoutOf(b.id));
      return current?.customerId === pay[1] ? json(res, 200, current) : json(res, 404, { error: 'unknown payment link' });
    }
    if (req.method === 'POST' && pay) {
      const { outcome } = (await readJson(req)) as { outcome: CheckoutOutcome };
      if (!['pay', 'fail', 'cancel'].includes(outcome)) return json(res, 400, { error: 'outcome must be pay, fail or cancel' });
      return json(res, 200, await checkout(pay[1]!, outcome));
    }
    if (req.method === 'GET' && url.pathname === '/api/media') {
      const file = await readMedia(url.searchParams.get('ref') ?? '');
      if (!file) return json(res, 404, { error: 'unknown media' });
      const type = MEDIA_TYPES.has(file.mimeType) ? file.mimeType : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff' });
      return void res.end(Buffer.from(file.data));
    }
    json(res, 404, { error: 'not found' });
  };

  return {
    webUrl,
    handle(req, res, next) {
      const url = new URL(req.url ?? '/', 'http://sandbox.local');
      if (!url.pathname.startsWith('/api/')) return next();
      if (crossSiteWrite(req)) return json(res, 403, { error: 'cross-site request' });
      runApiRoute(req, res, url, () => route(req, res, url));
    },
    signUp,
    send,
    connect,
    publishNow,
    checkout,
    state,
    transcript: async () =>
      (await state()).messages.map((m) => ({
        at: m.at,
        direction: m.direction,
        phone: owner,
        kind: m.kind,
        ...(m.text === undefined ? {} : { text: m.text }),
        ...(m.buttons ? { buttons: m.buttons } : {}),
      })),
    feedRecord: async () => {
      const posts = await world.publishing.run((sim) => NETWORKS.flatMap((n) => sim.postsOn(n)));
      return Promise.all(
        posts.map(async (p) => ({
          at: p.createdAt,
          network: p.request.network,
          providerAccountId: p.request.providerAccountId,
          idempotencyKey: p.request.idempotencyKey,
          format: p.request.format,
          scheduledFor: p.request.scheduledFor,
          caption: p.request.caption,
          media: await Promise.all(
            p.request.mediaUrls.map(async (ref) => {
              const m = await readMedia(ref);
              return m ? { ref, mimeType: m.mimeType, src: `data:${m.mimeType};base64,${Buffer.from(m.data).toString('base64')}` } : { ref, mimeType: 'unknown' };
            }),
          ),
          outcome: { ok: true as const, providerPostId: p.providerPostId },
        })),
      );
    },
    close,
  };
}

class PublishNowRefused extends Error {
  constructor() {
    super('publish now runs only on the simulators (local, test or dev)');
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
