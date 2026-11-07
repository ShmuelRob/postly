import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
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
import { addLogContext, asError, log, withLogContext } from '../../shared/logger.js';
import { metrics, withSpan } from '../../shared/telemetry.js';

/** technical-design.md, Operational defaults: a burst ends after 20 seconds without a new message. */
export const DEFAULT_BURST_QUIET_MS = 20_000;
export const WINDOW_MS = 24 * 60 * 60 * 1000;
/** A claim on an unprocessed message older than this may be taken again: its process died (T2). */
export const CLAIM_LEASE_MS = 5 * 60 * 1000;
/** The pg-boss job that wakes messaging for one business and sender (technical-design.md, durable bursts). */
export const INBOUND_BURST_JOB = 'inbound-burst';

export interface InboundBurstJob {
  businessId: string;
  from: string;
  /** The message that asked for the wake-up, for the job's log lines (docs/observability.md, "Following one message"). */
  correlationId?: string;
}

/**
 * Asks for `processBurst(businessId, from)` to run at `at`. At most one request waits per business
 * and sender; one more while it waits is dropped (the job runs, finds the burst not quiet yet, and
 * asks again).
 */
export interface BurstWake {
  /** `correlationId`: the message that asks, carried into the job's log context. */
  request(businessId: string, from: string, at: Date, correlationId?: string): Promise<void>;
}

/** The deployed wake-up: a pg-boss job on a `short` queue, keyed by business and sender. */
export function jobBurstWake(queue: {
  send(name: string, data: InboundBurstJob, options: { startAfter: Date; singletonKey: string }): Promise<void>;
}): BurstWake {
  return {
    request: (businessId, from, at, correlationId) =>
      queue.send(INBOUND_BURST_JOB, { businessId, from, ...(correlationId ? { correlationId } : {}) }, { startAfter: at, singletonKey: `${businessId}:${from}` }),
  };
}

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
  /** The wake-up after the quiet window; defaults to an in-process timer (local runs and tests). */
  wake?: BurstWake;
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
  /** Runs the sweep now and then every `everyMs` (default: the quiet window, at least 20 s); returns a stop function. */
  startSweep(everyMs?: number): () => void;
  /**
   * The `inbound-burst` job: claims this sender's unprocessed messages and hands them over, burst
   * by burst, once the newest is a quiet window old; otherwise asks for another wake-up. Returns
   * the number of messages handed over. Safe to run on several instances at once.
   */
  processBurst(businessId: string, from: string): Promise<number>;
  /** Hands every burst of the senders this instance received from to the handler now (tests, local runs). */
  flushBursts(): Promise<void>;
  /** Flushes as `flushBursts` does and stops the in-process timers. */
  close(): Promise<void>;
}

type MessageRow = typeof schema.message.$inferSelect;
type ClaimStep = { kind: 'none' } | { kind: 'wait'; at: Date } | { kind: 'claimed'; burst: InboundBurst };

const nodeTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) };

export function createMessaging(options: MessagingOptions): Messaging {
  const { db, provider, handler } = options;
  const quietMs = options.burstQuietMs ?? DEFAULT_BURST_QUIET_MS;
  const now = options.now ?? (() => new Date());
  const timers = options.timers ?? nodeTimers;
  const onError = options.onError ?? ((error: unknown, burst: InboundBurst) => log.error('inbound burst failed', { businessId: burst.businessId, messageId: burst.messages[0]?.id, correlationId: burst.messages[0]?.id, error: asError(error) }));
  /** Senders this instance received from; only `flushBursts` reads it, the bursts themselves are in `message`. */
  const senders = new Map<string, { businessId: string; from: string }>();
  /** The in-process wake-up: one timer per sender, like the job's singletonKey. */
  const waiting = new Map<string, unknown>();
  const wake: BurstWake = options.wake ?? {
    async request(businessId, from, at) {
      const k = key(businessId, from);
      if (waiting.has(k)) return;
      const handle = timers.set(() => {
        waiting.delete(k);
        processBurst(businessId, from).catch(() => {});
      }, Math.max(0, at.getTime() - now().getTime()));
      waiting.set(k, handle);
    },
  };

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

  function toReceived(row: MessageRow, content: InboundMessage['content']): ReceivedMessage {
    return {
      id: row.id,
      providerMessageId: row.providerMessageId,
      receivedAt: row.createdAt.toISOString(),
      content,
      mediaAssetIds: row.mediaAssetIds,
    };
  }

  /**
   * One claim, in one transaction: locks the sender's unprocessed inbound rows (a second claimer
   * waits for this one to commit), and claims the first burst when nothing earlier is claimed by
   * someone else and, unless `force`, the newest message is a quiet window old.
   */
  async function claim(businessId: string, from: string, force: boolean): Promise<ClaimStep> {
    return db.withBusiness('messaging', businessId, async (tx) => {
      const m = schema.message;
      const rows = await tx
        .select()
        .from(m)
        .where(and(eq(m.direction, 'inbound'), eq(m.fromPhone, from), isNull(m.processedAt)))
        // Provider timestamps tie (WhatsApp's have second resolution); `seq` is the arrival order.
        .orderBy(asc(m.createdAt), asc(m.seq))
        .for('update');
      if (rows.length === 0) return { kind: 'none' };
      const at = now().getTime();
      if (rows.some((r) => r.claimedAt !== null && r.claimedAt.getTime() > at - CLAIM_LEASE_MS)) {
        // Someone else is handing an earlier burst over; look again after it, so the order is kept.
        return { kind: 'wait', at: new Date(at + quietMs) };
      }
      const newest = rows.at(-1)!.createdAt.getTime();
      if (!force && newest > at - quietMs) return { kind: 'wait', at: new Date(newest + quietMs) };
      // A row this module cannot read is skipped (and stays unprocessed for the console), so it
      // never blocks the sender's other messages.
      const readable = rows.flatMap((row) => {
        const parsed = InboundMessage.shape.content.safeParse(row.payload);
        if (parsed.success) return [toReceived(row, parsed.data)];
        log.error('inbound burst skipped message: unreadable payload', { messageId: row.id });
        return [];
      });
      const [first] = readable;
      if (!first) return { kind: 'none' };
      const messages = [first];
      // A button reply is never merged: it is a burst of its own.
      if (first.content.kind !== 'button_reply') {
        for (const next of readable.slice(1)) {
          if (next.content.kind === 'button_reply') break;
          messages.push(next);
        }
      }
      await tx.update(m).set({ claimedAt: new Date(at) }).where(inArray(m.id, messages.map((x) => x.id)));
      return { kind: 'claimed', burst: { businessId, from, messages, text: burstText(messages) } };
    });
  }

  /** Claims and hands over the sender's bursts in order; `force` skips the quiet window (a button reply, a flush). */
  async function processBurst(businessId: string, from: string, force = false): Promise<number> {
    let delivered = 0;
    for (;;) {
      const step = await claim(businessId, from, force);
      if (step.kind === 'none') return delivered;
      if (step.kind === 'wait') {
        log.debug('inbound burst waiting', { businessId, waitMs: step.at.getTime() - now().getTime() });
        await wake.request(businessId, from, step.at);
        return delivered;
      }
      const ids = step.burst.messages.map((x) => x.id);
      const claimedAt = now().getTime();
      const context = { businessId: step.burst.businessId, messageId: step.burst.messages[0]?.id };
      // docs/observability.md, Timing lines: received (the first message) → claimed → handed over.
      const timing = (outcome: 'ok' | 'failed') => {
        const received = Date.parse(step.burst.messages[0]?.receivedAt ?? '') || claimedAt;
        const done = now().getTime();
        log.info('inbound burst handled', {
          ...context,
          messageCount: ids.length,
          quietMs,
          forced: force,
          outcome,
          receivedToClaimMs: claimedAt - received,
          handlerMs: done - claimedAt,
          totalMs: done - received,
        });
      };
      try {
        // The burst's first message is its correlation id (docs/observability.md, "Following one message").
        await withLogContext({ ...context, correlationId: context.messageId }, () => withSpan('inbound burst', context, () => handler.handleInbound(step.burst)));
        timing('ok');
      } catch (error) {
        timing('failed');
        // Release the claim at once, so the sweep (or the job's retry) hands the burst over again.
        await db.withBusiness('messaging', businessId, (tx) =>
          tx.update(schema.message).set({ claimedAt: null }).where(inArray(schema.message.id, ids)),
        );
        onError(error, step.burst);
        throw error;
      }
      await db.withBusiness('messaging', businessId, (tx) =>
        tx.update(schema.message).set({ processedAt: now() }).where(inArray(schema.message.id, ids)),
      );
      delivered += ids.length;
    }
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
    // receiveParsed adds the business and the stored message's id; the line below reads them from here.
    return withLogContext({}, async () => {
      const outcome = await receiveParsed(message);
      // docs/observability.md, Metrics: once per provider message (a retried webhook is `duplicate`).
      metrics.count('postly.messages.count', { direction: 'in', kind: message.content.kind, outcome });
      log.info('inbound message stored', { kind: message.content.kind, outcome });
      return outcome;
    });
  }

  async function receiveParsed(message: InboundMessage): Promise<ReceiveOutcome> {
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
    // From here on, this message's lines carry its id as the correlation id.
    addLogContext({ businessId, messageId: stored.id, correlationId: stored.id });

    await storeMedia(businessId, stored.id, message.content);
    senders.set(key(businessId, message.from), { businessId, from: message.from });

    if (message.content.kind === 'button_reply') {
      // Handed over at once, after the sender's earlier messages.
      await processBurst(businessId, message.from, true);
      return 'accepted';
    }
    log.debug('inbound burst wake requested', { delayMs: quietMs });
    await wake.request(businessId, message.from, new Date(now().getTime() + quietMs), stored.id);
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

  /**
   * One provider send, counted as `sent` or `failed` (docs/observability.md, Metrics) and logged as
   * `outbound message sent` or `failed` with ids and the template name only, never the text.
   */
  async function sent(businessId: string, kind: 'text' | 'buttons' | 'template', send: () => Promise<SendResult>, template?: string): Promise<SendResult> {
    const started = now().getTime();
    const fields = { businessId, kind, ...(template ? { template } : {}) };
    try {
      const result = await send();
      metrics.count('postly.messages.count', { direction: 'out', kind, outcome: 'sent' });
      log.info('outbound message sent', { ...fields, providerMessageId: result.providerMessageId, durationMs: now().getTime() - started });
      return result;
    } catch (error) {
      metrics.count('postly.messages.count', { direction: 'out', kind, outcome: 'failed' });
      log.warn('outbound message failed', { ...fields, durationMs: now().getTime() - started, error: asError(error) });
      throw error;
    }
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
      return recordOutbound(businessId, 'text', request.to, request.text, payload, await sent(businessId, 'text', () => provider.sendText(request)));
    },
    async sendButtons(businessId, request) {
      await requireOpenWindow(businessId, request.to);
      const result = await sent(businessId, 'buttons', () => provider.sendButtons(request));
      return recordOutbound(businessId, 'buttons', request.to, request.text, { buttons: request.buttons, mediaUrl: request.mediaUrl }, result);
    },
    async sendTemplate(businessId, request) {
      const result = await sent(businessId, 'template', () => provider.sendTemplate(request), request.templateName);
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
      const leaseCutoff = new Date(now().getTime() - CLAIM_LEASE_MS);
      const rows = await db.withSystem('phone_lookup', (tx) =>
        tx
          .selectDistinct({ businessId: m.businessId, from: m.fromPhone })
          .from(m)
          .where(and(
              eq(m.direction, 'inbound'),
              isNull(m.processedAt),
              sweepOptions.businessId ? eq(m.businessId, sweepOptions.businessId) : isNotNull(m.businessId),
              lt(m.createdAt, cutoff),
              or(isNull(m.claimedAt), lt(m.claimedAt, leaseCutoff)),
            )),
      );
      let delivered = 0;
      for (const row of rows) {
        if (!row.businessId) continue;
        try {
          delivered += await processBurst(row.businessId, row.from);
        } catch {
          // Reported through onError; later bursts of this sender wait for the next sweep, in order.
        }
      }
      return delivered;
    },
    // The sweep is a backstop for a lost wake-up, so it never runs more often than every 20 seconds,
    // even with a short quiet window (dev's 2 s; technical-design.md, Onboarding flow).
    startSweep(everyMs = Math.max(quietMs, DEFAULT_BURST_QUIET_MS)) {
      const sweep = () => {
        this.sweepUnprocessed().catch((error: unknown) => log.error('inbound sweep failed', { error: asError(error) }));
      };
      sweep();
      const timer = setInterval(sweep, everyMs);
      return () => clearInterval(timer);
    },
    processBurst: (businessId, from) => processBurst(businessId, from),
    async flushBursts() {
      // The in-process wake-ups have nothing left to do for these senders.
      for (const handle of waiting.values()) timers.clear(handle);
      waiting.clear();
      for (const s of [...senders.values()]) await processBurst(s.businessId, s.from, true);
    },
    async close() {
      await this.flushBursts();
    },
  };
}
