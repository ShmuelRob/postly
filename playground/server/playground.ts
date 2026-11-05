import { randomInt, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, eq, inArray, min } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import type { Network } from '../../src/contracts/common.js';
import { decodeButtonId, type InboundMessage } from '../../src/contracts/providers/index.js';
import { createDatabase, type Database, type DatabaseUrls } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { createDesignRenderer } from '../../src/modules/design/index.js';
import { WEBHOOK_PATH } from '../../src/modules/messaging/index.js';
import { buildServer } from '../../src/server.js';
import { conversationalModelSimulator } from '../../src/simulators/conversational/index.js';
import { MessagingSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import { placeholderPng } from '../../test/e2e/harness/png.js';
import type { PublishingEntry, TranscriptEntry } from '../../test/e2e/harness/record.js';
import type { ChatMessage, FeedPost, OwnerInput, PlaygroundState } from './api-types.js';
import { seedFeed } from './seed.js';
import { allowed, chatMessages, feedPosts, MEDIA_TYPES, mediaUrl, NETWORKS } from './views.js';

export interface PlaygroundOptions {
  databaseUrls: DatabaseUrls;
  /** The number the human plays: the business's single approver. */
  ownerPhone?: string;
  /** Postly's WhatsApp number for the playground business. */
  businessPhone?: string;
  /** How long messaging waits for more messages before handing a burst to the flow. */
  burstQuietMs?: number;
  /**
   * Sweep inbound messages never processed, as the web process does (default true). Off when the
   * database is shared with other tests, whose pending messages the sweep would otherwise take.
   */
  sweep?: boolean;
}

export type { ChatMessage, FeedPost, OwnerInput, PlaygroundState } from './api-types.js';

export interface Playground {
  /** Connect-style middleware for `/api/*`; anything else goes to `next`. */
  handle(req: IncomingMessage, res: ServerResponse, next: () => void): void;
  send(input: OwnerInput): Promise<void>;
  /** The owner finishes the connection link on the publishing simulator (every network it names). */
  connect(): Promise<void>;
  /**
   * Moves the playground clock just past the next scheduled publication (it never goes back) and runs
   * the publishing job's tick, as the worker would at that time. Returns how many publications ran.
   */
  publishDue(): Promise<number>;
  state(): Promise<PlaygroundState>;
  /** The conversation in the e2e report's format. */
  transcript(): TranscriptEntry[];
  feedRecord(): Promise<PublishingEntry[]>;
  close(): Promise<void>;
}

/** Where the in-memory storage (standing in for Cloud Storage) serves files from. */
const MEDIA_ORIGIN = 'https://media.playground.test/';

/**
 * The real app in-process against the simulators (`createApp`, the product's composition root):
 * inbound messages go through the signed webhook route and the messaging module to the workflow,
 * which runs onboarding for the new business. The design engine renders the style samples.
 */
export async function createPlayground(options: PlaygroundOptions): Promise<Playground> {
  const ownerPhone = options.ownerPhone ?? '+972501230000';
  const businessPhone = options.businessPhone ?? '+972521230000';
  const db = createDatabase(options.databaseUrls, { max: 4 });
  const sim = new MessagingSimulator({ businessNumber: businessPhone });
  // The playground clock: real time, moved forward by publishDue() so scheduled posts can go live now.
  let skewMs = 0;
  const clock = () => new Date(Date.now() + skewMs);
  const publishing = new PublishingSimulator({ now: clock });
  const model = conversationalModelSimulator();

  /** Files the browser can load, by storage path or URL: inbound media, renders, seeded posts. */
  const files = new Map<string, { mimeType: string; data: Uint8Array }>();
  const media = {
    async put(path: string, data: Uint8Array, mimeType: string) {
      files.set(path, { mimeType, data });
    },
    urlFor: (path: string) => MEDIA_ORIGIN + path,
    read: async (path: string) => stored(path),
  };
  const stored = (ref: string) => files.get(ref.startsWith(MEDIA_ORIGIN) ? ref.slice(MEDIA_ORIGIN.length) : ref);
  await media.put('bundled/sample.png', placeholderPng(1080, 1080, [246, 232, 210], [150, 82, 40]), 'image/png');
  const inbound: { at: string; message: InboundMessage }[] = [];

  const design = createDesignRenderer({
    assets: {
      load: async (url) => {
        const file = stored(url);
        if (!file) throw new Error(`no stored file at ${url}`);
        return file.data;
      },
    },
    store: { put: (path, bytes, mimeType) => media.put(path, bytes, mimeType) },
  });
  const app = createApp({
    db,
    providers: { messaging: sim, publishing, models: { google: model } },
    design,
    media,
    businessNumber: businessPhone,
    samplePhotoUrl: media.urlFor('bundled/sample.png'),
    ...(options.burstQuietMs === undefined ? {} : { burstQuietMs: options.burstQuietMs }),
    logger: { rejected: (entry) => console.warn('[playground] rejected', entry) },
    now: clock,
  });
  const server = buildServer({ messaging: app.messaging, publicBaseUrl: 'https://postly.example.test' });
  await freePhone(db, ownerPhone);
  // Signing up creates the business in onboarding; the owner then writes first.
  const businessId = await app.onboarding.createBusiness({ approverPhone: ownerPhone });
  const stopSweep = options.sweep === false ? () => {} : app.start();
  // Demo posts on a separate demo account, so the owner's own networks start unconnected.
  await seedFeed(publishing, randomUUID(), files);

  const deliver = async (content: InboundMessage['content']) => {
    // Unique across runs: provider message ids are unique across the whole message table.
    const message = { ...sim.inbound(ownerPhone, content), providerMessageId: `pg-in-${randomUUID()}` };
    inbound.push({ at: message.receivedAt, message });
    const hook = sim.webhook(message);
    const res = await server.inject({ method: 'POST', url: WEBHOOK_PATH, headers: hook.headers, payload: hook.body });
    if (res.statusCode !== 200) throw new Error(`webhook returned ${res.statusCode}: ${res.body}`);
  };

  const send = async (input: OwnerInput) => {
    switch (input.kind) {
      case 'text':
        return deliver({ kind: 'text', text: input.text });
      case 'image': {
        allowed(input.mimeType, 'image');
        const id = sim.addMedia(input.mimeType, Buffer.from(input.dataBase64, 'base64'));
        return deliver(input.caption ? { kind: 'image', providerMediaId: id, caption: input.caption } : { kind: 'image', providerMediaId: id });
      }
      case 'voice': {
        allowed(input.mimeType, 'audio');
        const id = sim.addMedia(input.mimeType, Buffer.from(input.dataBase64, 'base64'));
        return deliver({ kind: 'voice', providerMediaId: id });
      }
      case 'button': {
        // Buttons carry approval payloads only (contracts.md): the id is <action>:<postId>:<versionId>:<versionHash>.
        const payload = decodeButtonId(input.buttonId);
        if (!payload) throw new Error(`button ${input.buttonId}: not an approval button`);
        return deliver({ kind: 'button_reply', buttonId: input.buttonId, payload });
      }
    }
  };

  const connect = async () => {
    const link = publishing.connectionLinks.filter((l) => l.request.businessId === businessId).at(-1);
    if (!link) throw new Error('onboarding has not sent the connection link yet');
    for (const network of link.request.networks) publishing.connect(businessId, network);
  };

  const publishDue = async () => {
    const [next] = await db.withSystem('console', (tx) =>
      tx
        .select({ at: min(schema.publication.scheduledFor) })
        .from(schema.publication)
        .where(and(eq(schema.publication.businessId, businessId), inArray(schema.publication.status, ['scheduled', 'retry_pending']))),
    );
    if (next?.at) skewMs = Math.max(skewMs, new Date(next.at).getTime() + 60_000 - Date.now());
    return (await app.publishing.tick(clock(), { businessId })).ran;
  };

  const messages = (): ChatMessage[] => chatMessages(inbound, sim.sentTo(ownerPhone));

  const feed = () => feedPosts(publishing.posts, async (id) => (await publishing.getPublicationStatus(id)).status);

  const state = async (): Promise<PlaygroundState> => {
    const rows = await db.withBusiness('workflow', businessId, async (tx) => ({
      business: await tx.select().from(schema.business),
      conversation: await tx.select().from(schema.conversationState),
      channels: await tx.select().from(schema.channelConnection),
      posts: await tx.select().from(schema.post),
      items: await tx.select().from(schema.consoleItem),
    }));
    const b = rows.business[0];
    const c = rows.conversation[0];
    return {
      owner: ownerPhone,
      business: { id: businessId, name: b?.name ?? '', status: b?.status ?? 'unknown' },
      conversation: c ? { step: c.step, handoff: c.handoffAt !== null } : null,
      channels: rows.channels.map((ch) => ({ network: ch.network, status: ch.status })),
      connectionLinkSent: publishing.connectionLinks.some((l) => l.request.businessId === businessId),
      posts: rows.posts.map((p) => ({ id: p.id, status: p.status, format: p.format })),
      clock: clock().toISOString(),
      reviewQueue: rows.items.map((i) => ({ id: i.id, kind: i.kind, status: i.status, details: i.details })),
      messages: messages(),
      feed: await feed(),
    };
  };

  const readMedia = async (ref: string) => stored(ref) ?? (await sim.getMedia(ref).catch(() => undefined));

  const handle: Playground['handle'] = (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://playground.local');
    if (!url.pathname.startsWith('/api/')) return next();
    route(req, res, url).catch((error: unknown) => {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  };

  const route = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await state());
    if (req.method === 'POST' && url.pathname === '/api/messages') {
      await send((await readJson(req)) as OwnerInput);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/publish-due') {
      return json(res, 200, { ran: await publishDue() });
    }
    if (req.method === 'POST' && url.pathname === '/api/connect') {
      await connect();
      return json(res, 200, { ok: true });
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
    handle,
    send,
    connect,
    publishDue,
    state,
    transcript: () =>
      messages().map((m) => ({
        at: m.at,
        direction: m.direction,
        phone: ownerPhone,
        kind: m.kind,
        ...(m.text === undefined ? {} : { text: m.text }),
        ...(m.buttons ? { buttons: m.buttons } : {}),
      })),
    feedRecord: async () =>
      Promise.all(
        NETWORKS.flatMap((network) => publishing.postsOn(network)).map(async (p) => ({
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
              return m
                ? { ref, mimeType: m.mimeType, src: `data:${m.mimeType};base64,${Buffer.from(m.data).toString('base64')}` }
                : { ref, mimeType: 'unknown' };
            }),
          ),
          outcome: { ok: true as const, providerPostId: p.providerPostId },
        })),
      ),
    close: async () => {
      stopSweep();
      await server.close();
      await design.close();
      await db.close();
    },
  };
}

/** approver_phone is unique: free the playground number from an earlier run on the same database. */
async function freePhone(db: Database, ownerPhone: string) {
  await db.withSystem('console', (tx) =>
    tx.update(schema.business).set({ approverPhone: `+97250${randomInt(1_000_000, 10_000_000)}` }).where(eq(schema.business.approverPhone, ownerPhone)),
  );
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
