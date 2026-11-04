import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import {
  InboundMessage,
  type MessagingProvider,
  type SendButtonsRequest,
  type SendResult,
  type SendTemplateRequest,
  type SendTextRequest,
  type WebhookRequest,
  WindowClosedError,
} from '../../contracts/providers/messaging.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';

/** technical-design.md, Operational defaults: a burst ends after 20 seconds without a new message. */
export const DEFAULT_BURST_QUIET_MS = 20_000;
export const WINDOW_MS = 24 * 60 * 60 * 1000;

/** One stored inbound message inside a burst. */
export interface ReceivedMessage {
  /** The `message` row id. */
  id: string;
  providerMessageId: string;
  receivedAt: string;
  content: InboundMessage['content'];
  /** `media_asset` rows for a voice note or image; empty for text and button replies. */
  mediaAssetIds: string[];
}

/** Inbound messages from one known number, merged into one unit of work. */
import { log, withLogContext } from '../../shared/logger.js';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface InboundBurst {
  businessId: string;
  from: string;
  messages: ReceivedMessage[];
  /** Texts and image captions in order, joined by newlines; empty when there are none. */
  text: string;
}

/**
 * What messaging hands each burst to. The workflow module (WP-23) implements it; until then
 * a test injects a stub. A button reply is never merged: it arrives as a burst of its own.
 */
export interface InboundHandler {
  handleInbound(burst: InboundBurst): Promise<void>;
}

export type ReceiveOutcome = 'accepted' | 'duplicate' | 'unknown_number';

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Where inbound media files go, and the URL a model provider or the renderer fetches them from. */
export interface MediaStorage {
  put(path: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  urlFor(path: string): string;
}

export interface MessagingOptions {
  db: Database;
  provider: MessagingProvider;
  handler: InboundHandler;
  /** Postly's WhatsApp number, the sender of every outbound message. */
  businessNumber: string;
  burstQuietMs?: number;
  now?: () => Date;
  timers?: Timers;
  /** Stores voice notes and images as `media_asset` rows; without it media stays at the provider. */
  media?: MediaStorage;
  /** Called when a burst handed over by a timer fails; defaults to an error log line with the ids. */
  onError?: (error: unknown, burst: InboundBurst) => void;
}

export interface Messaging {
  /** Verifies and stores a webhook's messages; throws InvalidWebhookSignatureError when it does not verify. */
  handleWebhook(request: WebhookRequest): Promise<ReceiveOutcome[]>;
  /** Stores one verified inbound message: drops duplicates, routes unknown numbers to the console. */
  receive(message: InboundMessage): Promise<ReceiveOutcome>;
  /**
   * Stores one verified inbound message of a known business without handing it to the handler
   * (marked processed), or finds the stored row of the same provider message. Returns the row id.
   * The approval service records a message the app did not receive through `receive` this way.
   */
  record(businessId: string, message: InboundMessage): Promise<string>;
  /** Throws WindowClosedError outside the 24-hour window. */
  sendText(businessId: string, request: SendTextRequest): Promise<SendResult>;
  /** Throws WindowClosedError outside the 24-hour window. */
  sendButtons(businessId: string, request: SendButtonsRequest): Promise<SendResult>;
  /** Templates may go out at any time. */
  sendTemplate(businessId: string, request: SendTemplateRequest): Promise<SendResult>;
  /** When the owner's 24-hour window to `phone` closes, or null when it is closed. */
  windowClosesAt(businessId: string, phone: string): Promise<Date | null>;
  /** The URL of one of the business's media assets, for the model layer and the renderer. */
  mediaUrl(businessId: string, mediaAssetId: string): Promise<string>;
  /**
   * Hands every stored inbound message the workflow never consumed (`processed_at` null) and older
   * than the quiet window to the handler again, grouped by business and sender. Run at startup and
   * then every quiet window (technical-design.md, Onboarding flow; review queue item 14). `businessId`
   * limits it to one business (tests that share a database).
   */
  sweepUnprocessed(options?: { businessId?: string }): Promise<number>;
  /** Runs the sweep now and then every `everyMs` (default: the quiet window); returns a stop function. */
  startSweep(everyMs?: number): () => void;
  /** Hands every pending burst to the handler now. */
  flushBursts(): Promise<void>;
  /** Flushes pending bursts and stops the timers. */
  close(): Promise<void>;
}

interface PendingBurst {
  burst: InboundBurst;
  timer: unknown;
}

const nodeTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) };

export function createMessaging(options: MessagingOptions): Messaging {
  const { db, provider, handler } = options;
  const quietMs = options.burstQuietMs ?? DEFAULT_BURST_QUIET_MS;
  const now = options.now ?? (() => new Date());
  const timers = options.timers ?? nodeTimers;
  const onError = options.onError ?? ((error: unknown, burst: InboundBurst) => log.error('inbound burst failed', { businessId: burst.businessId, messageId: burst.messages[0]?.id, error: errorMessage(error) }));
  const pending = new Map<string, PendingBurst>();
  /** Ids of messages handed to the handler and not yet marked processed. */
  const delivering = new Set<string>();

  const key = (businessId: string, from: string) => `${businessId}:${from}`;

  const burstText = (messages: ReceivedMessage[]) =>
    messages
      .map((m) => (m.content.kind === 'text' ? m.content.text : m.content.kind === 'image' ? m.content.caption : undefined))
      .filter((t): t is string => t !== undefined && t !== '')
      .join('\n');

  async function storeMedia(businessId: string, messageId: string, content: InboundMessage['content']): Promise<string[]> {
    if (!options.media || (content.kind !== 'voice' && content.kind !== 'image')) return [];
    const file = await provider.getMedia(content.providerMediaId);
    const storagePath = `${businessId}/inbound/${randomUUID()}`;
    await options.media.put(storagePath, file.data, file.mimeType);
    return db.withBusiness('messaging', businessId, async (tx) => {
      const [asset] = await tx
        .insert(schema.mediaAsset)
        .values({
          businessId,
          kind: content.kind === 'voice' ? 'voice' : 'photo',
          source: 'owner',
          storagePath,
          mimeType: file.mimeType,
          sha256: createHash('sha256').update(file.data).digest('hex'),
        })
        .returning({ id: schema.mediaAsset.id });
      if (!asset) throw new Error('media_asset insert returned no row');
      await tx.update(schema.message).set({ mediaAssetIds: [asset.id] }).where(eq(schema.message.id, messageId));
      return [asset.id];
    });
  }

  /**
   * Hands a burst to the handler and marks its messages processed. Its message ids stay in
   * `delivering` until that finishes, so the sweep never hands the same messages over twice in this
   * process. Returns false, doing nothing, when one of them is already being delivered.
   */
  async function deliver(burst: InboundBurst): Promise<boolean> {
    if (burst.messages.some((m) => delivering.has(m.id))) return false;
    for (const m of burst.messages) delivering.add(m.id);
    try {
      await withLogContext({ businessId: burst.businessId, messageId: burst.messages[0]?.id }, () => handler.handleInbound(burst));
      const processedAt = now();
      await db.withBusiness('messaging', burst.businessId, async (tx) => {
        for (const m of burst.messages) {
          await tx.update(schema.message).set({ processedAt }).where(eq(schema.message.id, m.id));
        }
      });
      return true;
    } finally {
      for (const m of burst.messages) delivering.delete(m.id);
    }
  }

  async function flush(k: string): Promise<void> {
    const entry = pending.get(k);
    if (!entry) return;
    pending.delete(k);
    timers.clear(entry.timer);
    await deliver(entry.burst);
  }

  function schedule(k: string, entry: PendingBurst): void {
    timers.clear(entry.timer);
    entry.timer = timers.set(() => {
      flush(k).catch((error: unknown) => onError(error, entry.burst));
    }, quietMs);
  }

  async function lookupBusiness(phone: string): Promise<string | undefined> {
    const rows = await db.withSystem('phone_lookup', (tx) =>
      tx.select({ id: schema.business.id }).from(schema.business).where(eq(schema.business.approverPhone, phone)),
    );
    return rows[0]?.id;
  }

  function messageRow(message: InboundMessage) {
    const c = message.content;
    return {
      direction: 'inbound' as const,
      kind: c.kind,
      provider: message.provider,
      providerMessageId: message.providerMessageId,
      fromPhone: message.from,
      toPhone: message.to,
      body: c.kind === 'text' ? c.text : c.kind === 'image' ? (c.caption ?? null) : null,
      payload: c,
      createdAt: new Date(message.receivedAt),
    };
  }

  async function receive(input: InboundMessage): Promise<ReceiveOutcome> {
    const message = InboundMessage.parse(input);
    const businessId = await lookupBusiness(message.from);

    if (!businessId) {
      // technical-design.md, Failure handling: no reply, nothing accepted; a person looks at it.
      return db.withSystem('phone_lookup', async (tx) => {
        const [row] = await tx
          .insert(schema.message)
          .values({ ...messageRow(message), businessId: null })
          .onConflictDoNothing({ target: [schema.message.provider, schema.message.providerMessageId] })
          .returning({ id: schema.message.id });
        if (!row) return 'duplicate';
        await tx.insert(schema.consoleItem).values({
          businessId: null,
          kind: 'unknown_number',
          referenceId: row.id,
          details: { from: message.from, to: message.to, kind: message.content.kind, receivedAt: message.receivedAt },
        });
        return 'unknown_number';
      });
    }

    const stored = await db.withBusiness('messaging', businessId, async (tx) => {
      const [row] = await tx
        .insert(schema.message)
        .values({ ...messageRow(message), businessId })
        .onConflictDoNothing({ target: [schema.message.provider, schema.message.providerMessageId] })
        .returning({ id: schema.message.id });
      return row;
    });
    if (!stored) return 'duplicate';

    const received: ReceivedMessage = {
      id: stored.id,
      providerMessageId: message.providerMessageId,
      receivedAt: message.receivedAt,
      content: message.content,
      mediaAssetIds: await storeMedia(businessId, stored.id, message.content),
    };
    const k = key(businessId, message.from);

    if (message.content.kind === 'button_reply') {
      await flush(k);
      await deliver({ businessId, from: message.from, messages: [received], text: '' });
      return 'accepted';
    }

    const entry = pending.get(k) ?? {
      burst: { businessId, from: message.from, messages: [], text: '' },
      timer: undefined,
    };
    entry.burst.messages.push(received);
    entry.burst.text = burstText(entry.burst.messages);
    pending.set(k, entry);
    schedule(k, entry);
    return 'accepted';
  }

  async function windowClosesAt(businessId: string, phone: string): Promise<Date | null> {
    const last = await lastInboundAt(businessId, phone);
    if (!last) return null;
    const closes = new Date(last.getTime() + WINDOW_MS);
    return closes > now() ? closes : null;
  }

  async function lastInboundAt(businessId: string, phone: string): Promise<Date | null> {
    const [row] = await db.withBusiness('messaging', businessId, (tx) =>
      tx
        .select({ at: schema.message.createdAt })
        .from(schema.message)
        .where(and(eq(schema.message.direction, 'inbound'), eq(schema.message.fromPhone, phone)))
        .orderBy(desc(schema.message.createdAt))
        .limit(1),
    );
    return row?.at ?? null;
  }

  async function requireOpenWindow(businessId: string, to: string): Promise<void> {
    if (await windowClosesAt(businessId, to)) return;
    throw new WindowClosedError(to, await lastInboundAt(businessId, to));
  }

  async function recordOutbound(
    businessId: string,
    kind: 'text' | 'buttons' | 'template',
    to: string,
    body: string | null,
    payload: unknown,
    result: SendResult,
  ): Promise<SendResult> {
    await db.withBusiness('messaging', businessId, (tx) =>
      tx.insert(schema.message).values({
        businessId,
        direction: 'outbound',
        kind,
        provider: provider.name,
        providerMessageId: result.providerMessageId,
        fromPhone: options.businessNumber,
        toPhone: to,
        body,
        payload,
        processedAt: now(),
        createdAt: now(),
      }),
    );
    return result;
  }

  return {
    async handleWebhook(request) {
      const messages = await provider.verifyWebhook(request);
      const outcomes: ReceiveOutcome[] = [];
      for (const m of messages) outcomes.push(await receive(m));
      return outcomes;
    },
    receive,
    async record(businessId, input) {
      const message = InboundMessage.parse(input);
      return db.withBusiness('messaging', businessId, async (tx) => {
        const m = schema.message;
        const [row] = await tx
          .insert(m)
          .values({ ...messageRow(message), businessId, processedAt: now() })
          .onConflictDoNothing({ target: [m.provider, m.providerMessageId] })
          .returning({ id: m.id });
        if (row) return row.id;
        const [existing] = await tx
          .select({ id: m.id })
          .from(m)
          .where(and(eq(m.provider, message.provider), eq(m.providerMessageId, message.providerMessageId)));
        if (!existing) throw new Error('inbound message belongs to another business');
        return existing.id;
      });
    },
    async sendText(businessId, request) {
      await requireOpenWindow(businessId, request.to);
      const payload = request.mediaUrl ? { mediaUrl: request.mediaUrl } : null;
      return recordOutbound(businessId, 'text', request.to, request.text, payload, await provider.sendText(request));
    },
    async sendButtons(businessId, request) {
      await requireOpenWindow(businessId, request.to);
      const result = await provider.sendButtons(request);
      return recordOutbound(businessId, 'buttons', request.to, request.text, { buttons: request.buttons, mediaUrl: request.mediaUrl }, result);
    },
    async sendTemplate(businessId, request) {
      const result = await provider.sendTemplate(request);
      return recordOutbound(businessId, 'template', request.to, null, { templateName: request.templateName, language: request.language, variables: request.variables }, result);
    },
    windowClosesAt,
    async mediaUrl(businessId, mediaAssetId) {
      if (!options.media) throw new Error('No media storage configured');
      const [row] = await db.withBusiness('messaging', businessId, (tx) =>
        tx.select({ path: schema.mediaAsset.storagePath }).from(schema.mediaAsset).where(eq(schema.mediaAsset.id, mediaAssetId)),
      );
      if (!row) throw new Error(`No media asset ${mediaAssetId} for this business`);
      return options.media.urlFor(row.path);
    },
    async sweepUnprocessed(sweepOptions = {}) {
      const m = schema.message;
      const cutoff = new Date(now().getTime() - quietMs);
      const rows = await db.withSystem('phone_lookup', (tx) =>
        tx
          .select()
          .from(m)
          .where(and(
              eq(m.direction, 'inbound'),
              isNull(m.processedAt),
              sweepOptions.businessId ? eq(m.businessId, sweepOptions.businessId) : isNotNull(m.businessId),
              lt(m.createdAt, cutoff),
            ))
          .orderBy(asc(m.createdAt)),
      );
      const waiting = new Set([...pending.values()].flatMap((p) => p.burst.messages.map((x) => x.id)));
      const groups = new Map<string, InboundBurst[]>();
      for (const row of rows) {
        if (waiting.has(row.id) || delivering.has(row.id) || !row.businessId) continue;
        // A row this module cannot read must not stop the sweep for every other business.
        const parsed = InboundMessage.shape.content.safeParse(row.payload);
        if (!parsed.success) {
          log.error('inbound sweep skipped message: unreadable payload', { messageId: row.id });
          continue;
        }
        const content = parsed.data;
        const received: ReceivedMessage = {
          id: row.id,
          providerMessageId: row.providerMessageId,
          receivedAt: row.createdAt.toISOString(),
          content,
          mediaAssetIds: row.mediaAssetIds,
        };
        const k = key(row.businessId, row.fromPhone);
        const bursts = groups.get(k) ?? [];
        groups.set(k, bursts);
        const last = bursts.at(-1);
        // A button reply is never merged, as on the live path.
        const mergeable = content.kind !== 'button_reply' && last !== undefined && last.messages[0]?.content.kind !== 'button_reply';
        if (mergeable) last.messages.push(received);
        else bursts.push({ businessId: row.businessId, from: row.fromPhone, messages: [received], text: '' });
      }
      let delivered = 0;
      for (const bursts of groups.values()) {
        for (const burst of bursts) {
          burst.text = burstText(burst.messages);
          try {
            if (await deliver(burst)) delivered += burst.messages.length;
          } catch (error) {
            // Later bursts of this sender wait for the next sweep, so their order is kept.
            onError(error, burst);
            break;
          }
        }
      }
      return delivered;
    },
    startSweep(everyMs = quietMs) {
      const sweep = () => {
        this.sweepUnprocessed().catch((error: unknown) => log.error('inbound sweep failed', { error: errorMessage(error) }));
      };
      sweep();
      const timer = setInterval(sweep, everyMs);
      return () => clearInterval(timer);
    },
    async flushBursts() {
      for (const k of [...pending.keys()]) await flush(k);
    },
    async close() {
      for (const k of [...pending.keys()]) await flush(k);
    },
  };
}
