import { and, desc, eq } from 'drizzle-orm';
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

export interface MessagingOptions {
  db: Database;
  provider: MessagingProvider;
  handler: InboundHandler;
  /** Postly's WhatsApp number, the sender of every outbound message. */
  businessNumber: string;
  burstQuietMs?: number;
  now?: () => Date;
  timers?: Timers;
  /** Called when a burst handed over by a timer fails; defaults to console.error. */
  onError?: (error: unknown, burst: InboundBurst) => void;
}

export interface Messaging {
  /** Verifies and stores a webhook's messages; throws InvalidWebhookSignatureError when it does not verify. */
  handleWebhook(request: WebhookRequest): Promise<ReceiveOutcome[]>;
  /** Stores one verified inbound message: drops duplicates, routes unknown numbers to the console. */
  receive(message: InboundMessage): Promise<ReceiveOutcome>;
  /** Throws WindowClosedError outside the 24-hour window. */
  sendText(businessId: string, request: SendTextRequest): Promise<SendResult>;
  /** Throws WindowClosedError outside the 24-hour window. */
  sendButtons(businessId: string, request: SendButtonsRequest): Promise<SendResult>;
  /** Templates may go out at any time. */
  sendTemplate(businessId: string, request: SendTemplateRequest): Promise<SendResult>;
  /** When the owner's 24-hour window to `phone` closes, or null when it is closed. */
  windowClosesAt(businessId: string, phone: string): Promise<Date | null>;
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
  const onError = options.onError ?? ((error: unknown) => console.error('inbound burst failed', error));
  const pending = new Map<string, PendingBurst>();

  const key = (businessId: string, from: string) => `${businessId}:${from}`;

  async function deliver(burst: InboundBurst): Promise<void> {
    await handler.handleInbound(burst);
    const processedAt = now();
    await db.withBusiness(burst.businessId, async (tx) => {
      for (const m of burst.messages) {
        await tx.update(schema.message).set({ processedAt }).where(eq(schema.message.id, m.id));
      }
    });
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
      return db.withSystem('console', async (tx) => {
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

    const stored = await db.withBusiness(businessId, async (tx) => {
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
    entry.burst.text = entry.burst.messages
      .map((m) => (m.content.kind === 'text' ? m.content.text : m.content.kind === 'image' ? m.content.caption : undefined))
      .filter((t): t is string => t !== undefined && t !== '')
      .join('\n');
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
    const [row] = await db.withBusiness(businessId, (tx) =>
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
    await db.withBusiness(businessId, (tx) =>
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
    async sendText(businessId, request) {
      await requireOpenWindow(businessId, request.to);
      return recordOutbound(businessId, 'text', request.to, request.text, null, await provider.sendText(request));
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
    async flushBursts() {
      for (const k of [...pending.keys()]) await flush(k);
    },
    async close() {
      for (const k of [...pending.keys()]) await flush(k);
    },
  };
}
