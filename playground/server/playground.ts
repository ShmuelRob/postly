import { randomInt, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import type { Network } from '../../src/contracts/common.js';
import type { InboundMessage } from '../../src/contracts/providers/index.js';
import { createDatabase, type Database, type DatabaseUrls } from '../../src/db/index.js';
import * as schema from '../../src/db/schema.js';
import { createMessaging, WEBHOOK_PATH, type Messaging } from '../../src/modules/messaging/index.js';
import { createWorkflow } from '../../src/modules/workflow/index.js';
import { buildServer } from '../../src/server.js';
import { MessagingSimulator, ModelSimulator, PublishingSimulator } from '../../src/simulators/index.js';
import type { PublishingEntry, TranscriptEntry } from '../../test/e2e/harness/record.js';
import type { ChatMessage, FeedPost, OwnerInput, PlaygroundState } from './api-types.js';
import { createFlows, type ButtonRegistry } from './flows.js';
import { seedFeed } from './seed.js';

export interface PlaygroundOptions {
  databaseUrls: DatabaseUrls;
  /** The number the human plays: the business's single approver. */
  ownerPhone?: string;
  /** Postly's WhatsApp number for the playground business. */
  businessPhone?: string;
  /** How long messaging waits for more messages before handing a burst to the flow. */
  burstQuietMs?: number;
}

export type { ChatMessage, FeedPost, OwnerInput, PlaygroundState } from './api-types.js';

export interface Playground {
  /** Connect-style middleware for `/api/*`; anything else goes to `next`. */
  handle(req: IncomingMessage, res: ServerResponse, next: () => void): void;
  send(input: OwnerInput): Promise<void>;
  state(): Promise<PlaygroundState>;
  /** The conversation in the e2e report's format. */
  transcript(): TranscriptEntry[];
  feedRecord(): Promise<PublishingEntry[]>;
  close(): Promise<void>;
}

const NETWORKS: Network[] = ['instagram', 'facebook'];

/**
 * The real app in-process against the simulators: inbound messages go through the signed webhook
 * route and the messaging module, which hands bursts to the playground's flows (flows.ts).
 */
export async function createPlayground(options: PlaygroundOptions): Promise<Playground> {
  const ownerPhone = options.ownerPhone ?? '+972501230000';
  const businessPhone = options.businessPhone ?? '+972521230000';
  const db = createDatabase(options.databaseUrls, { max: 4 });
  const sim = new MessagingSimulator({ businessNumber: businessPhone });
  const publishing = new PublishingSimulator();
  const model = new ModelSimulator();
  const workflow = createWorkflow(db, { rejected: (entry) => console.warn('[playground] rejected', entry) });
  const businessId = await createBusiness(db, ownerPhone);

  /** Media the browser can load: inbound media by provider id, and media at a URL (seeded posts). */
  const mediaByUrl = new Map<string, { mimeType: string; data: Uint8Array }>();
  const inbound: { at: string; message: InboundMessage; title?: string }[] = [];
  const buttons: ButtonRegistry = new Map();

  let messaging: Messaging;
  messaging = createMessaging({
    db,
    provider: sim,
    businessNumber: businessPhone,
    ...(options.burstQuietMs === undefined ? {} : { burstQuietMs: options.burstQuietMs }),
    handler: createFlows({ send: () => messaging, workflow, model, buttons }),
  });
  const server = buildServer({ messaging, publicBaseUrl: 'https://postly.example.test' });
  await seedFeed(publishing, businessId, mediaByUrl);

  const deliver = async (content: InboundMessage['content'], title?: string) => {
    // Unique across runs: provider message ids are unique across the whole message table.
    const message = { ...sim.inbound(ownerPhone, content), providerMessageId: `pg-in-${randomUUID()}` };
    inbound.push({ at: message.receivedAt, message, ...(title === undefined ? {} : { title }) });
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
        const button = buttons.get(input.buttonId);
        if (!button) throw new Error(`no button ${input.buttonId} was sent to the owner`);
        return deliver({ kind: 'button_reply', buttonId: input.buttonId, payload: button.payload }, button.title);
      }
    }
  };

  const messages = (): ChatMessage[] => {
    const fromOwner = inbound.map(({ at, message, title }): ChatMessage => {
      const c = message.content;
      const base = { id: message.providerMessageId, at, direction: 'from_owner' as const, kind: c.kind };
      switch (c.kind) {
        case 'text':
          return { ...base, text: c.text };
        case 'button_reply':
          return { ...base, text: title ?? c.buttonId };
        case 'image':
          return { ...base, ...(c.caption ? { text: c.caption } : {}), media: { url: mediaUrl(c.providerMediaId), mimeType: 'image' } };
        case 'voice':
          return { ...base, media: { url: mediaUrl(c.providerMediaId), mimeType: 'audio' } };
      }
    });
    const toOwner = sim.sent.map((m): ChatMessage => {
      const base = { id: m.providerMessageId, at: m.sentAt, direction: 'to_owner' as const };
      switch (m.kind) {
        case 'text':
          return { ...base, kind: 'text', text: m.request.text };
        case 'buttons':
          return {
            ...base,
            kind: 'buttons',
            text: m.request.text,
            buttons: m.request.buttons,
            ...(m.request.mediaUrl ? { media: { url: mediaUrl(m.request.mediaUrl), mimeType: 'image' } } : {}),
          };
        case 'template':
          return { ...base, kind: 'template', text: `[${m.request.templateName}] ${Object.values(m.request.variables).join(' · ')}` };
      }
    });
    // Stable: an owner message and its reply can share a millisecond.
    return [...fromOwner, ...toOwner].sort((a, b) => a.at.localeCompare(b.at));
  };

  const feed = async (): Promise<Record<Network, FeedPost[]>> => {
    const entries = await Promise.all(
      NETWORKS.map(async (network) => {
        const posts = await Promise.all(
          publishing.postsOn(network).map(async (p): Promise<FeedPost> => ({
            id: p.providerPostId,
            network,
            caption: p.request.caption,
            format: p.request.format,
            scheduledFor: p.request.scheduledFor,
            status: (await publishing.getPublicationStatus(p.providerPostId)).status,
            images: p.request.mediaUrls.map(mediaUrl),
          })),
        );
        return [network, posts.reverse()] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<Network, FeedPost[]>;
  };

  const state = async (): Promise<PlaygroundState> => {
    const rows = await db.withBusiness('workflow', businessId, async (tx) => ({
      business: await tx.select().from(schema.business),
      conversation: await tx.select().from(schema.conversationState),
      posts: await tx.select().from(schema.post),
      items: await tx.select().from(schema.consoleItem),
    }));
    const b = rows.business[0];
    const c = rows.conversation[0];
    return {
      owner: ownerPhone,
      business: { id: businessId, name: b?.name ?? '', status: b?.status ?? 'unknown' },
      conversation: c ? { step: c.step, handoff: c.handoffAt !== null } : null,
      posts: rows.posts.map((p) => ({ id: p.id, status: p.status, format: p.format })),
      reviewQueue: rows.items.map((i) => ({ id: i.id, kind: i.kind, status: i.status, details: i.details })),
      messages: messages(),
      feed: await feed(),
    };
  };

  const readMedia = async (ref: string) => mediaByUrl.get(ref) ?? (await sim.getMedia(ref).catch(() => undefined));

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
    if (req.method === 'GET' && url.pathname === '/api/media') {
      const media = await readMedia(url.searchParams.get('ref') ?? '');
      if (!media) return json(res, 404, { error: 'unknown media' });
      const type = MEDIA_TYPES.has(media.mimeType) ? media.mimeType : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff' });
      return void res.end(Buffer.from(media.data));
    }
    json(res, 404, { error: 'not found' });
  };

  return {
    handle,
    send,
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
      await server.close();
      await db.close();
    },
  };
}

/** Media types the playground accepts and serves; anything else is served as a download. */
const MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/webm',
]);

function allowed(mimeType: string, kind: 'image' | 'audio') {
  if (!MEDIA_TYPES.has(mimeType) || !mimeType.startsWith(`${kind}/`)) throw new Error(`unsupported ${kind} type: ${mimeType}`);
}

const mediaUrl = (ref: string) => `/api/media?ref=${encodeURIComponent(ref)}`;

/** A fresh business for this run, in the state a new sign-up starts in (onboarding, intro). */
async function createBusiness(db: Database, ownerPhone: string): Promise<string> {
  const businessId = randomUUID();
  // approver_phone is unique: free the playground number from an earlier run on the same database.
  await db.withSystem('console', (tx) =>
    tx.update(schema.business).set({ approverPhone: `+97250${randomInt(1_000_000, 10_000_000)}` }).where(eq(schema.business.approverPhone, ownerPhone)),
  );
  await db.withBusiness('workflow', businessId, async (tx) => {
    await tx.insert(schema.business).values({ id: businessId, name: 'העסק של המגרש', approverPhone: ownerPhone });
    await tx.insert(schema.conversationState).values({ businessId });
  });
  return businessId;
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

