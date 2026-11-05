import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type ApprovalButtonPayload,
  type GetMediaResult,
  InboundMessage,
  InvalidWebhookSignatureError,
  type MessagingProvider,
  SendButtonsRequest,
  type SendResult,
  SendTemplateRequest,
  SendTextRequest,
  WebhookRequest,
  WindowClosedError,
} from '../contracts/providers/messaging.js';
import { fromBase64, refill, toBase64 } from './persistent.js';

export const SIMULATOR_SIGNATURE_HEADER = 'x-simulator-signature';

export type SentMessage =
  | { kind: 'text'; providerMessageId: string; sentAt: string; request: SendTextRequest }
  | { kind: 'template'; providerMessageId: string; sentAt: string; request: SendTemplateRequest }
  | { kind: 'buttons'; providerMessageId: string; sentAt: string; request: SendButtonsRequest };

/** The default webhook secret. It is public in the repository, so only local runs and tests may use it. */
export const SIMULATOR_WEBHOOK_SECRET = 'simulator-webhook-secret';

export interface MessagingSimulatorOptions {
  /** The business's WhatsApp number; inbound messages are addressed to it. */
  businessNumber?: string;
  webhookSecret?: string;
  webhookUrl?: string;
  now?: () => Date;
  /**
   * When true, text and buttons to a number with no inbound message (built by inbound*()) in the
   * last 24 hours throw WindowClosedError, as WhatsApp does. Off by default.
   */
  enforceWindow?: boolean;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * In-memory WhatsApp. Records every message sent (what the owner would see) and
 * builds signed webhook requests for inbound messages. Webhooks are signed with
 * HMAC-SHA256 over the url and body, like the real vendors.
 */
export class MessagingSimulator implements MessagingProvider {
  readonly name = 'simulator';
  readonly sent: SentMessage[] = [];

  private readonly businessNumber: string;
  private readonly secret: string;
  private readonly url: string;
  private readonly now: () => Date;
  private readonly media = new Map<string, GetMediaResult>();
  private readonly sendFailures: Error[] = [];
  private readonly enforceWindow: boolean;
  private readonly lastInbound = new Map<string, Date>();
  private nextId = 1;
  /** Per instance, so message ids stay unique across simulators sharing one database. */
  private readonly run = randomUUID().slice(0, 8);

  constructor(options: MessagingSimulatorOptions = {}) {
    this.businessNumber = options.businessNumber ?? '+972501234564';
    this.secret = options.webhookSecret ?? SIMULATOR_WEBHOOK_SECRET;
    this.url = options.webhookUrl ?? 'https://postly.example.test/webhooks/messaging';
    this.now = options.now ?? (() => new Date());
    this.enforceWindow = options.enforceWindow ?? false;
  }

  /** Everything the simulator holds, as JSON (simulated mode, src/simulators/persistent.ts). */
  exportState(): unknown {
    return {
      sent: this.sent,
      media: [...this.media].map(([id, m]) => [id, { mimeType: m.mimeType, data: toBase64(m.data) }]),
      sendFailures: this.sendFailures.map((e) => e.message),
      lastInbound: [...this.lastInbound].map(([phone, at]) => [phone, at.toISOString()]),
      nextId: this.nextId,
    };
  }

  importState(state: unknown): void {
    const s = state as { sent: SentMessage[]; media: [string, { mimeType: string; data: string }][]; sendFailures: string[]; lastInbound: [string, string][]; nextId: number };
    refill(this.sent, s.sent);
    this.media.clear();
    for (const [id, m] of s.media) this.media.set(id, { mimeType: m.mimeType, data: fromBase64(m.data) });
    refill(this.sendFailures, s.sendFailures.map((m) => new Error(m)));
    this.lastInbound.clear();
    for (const [phone, at] of s.lastInbound) this.lastInbound.set(phone, new Date(at));
    this.nextId = s.nextId;
  }

  async sendText(request: SendTextRequest): Promise<SendResult> {
    const parsed = SendTextRequest.parse(request);
    this.checkWindow(parsed.to);
    return this.record({ kind: 'text', request: parsed });
  }

  async sendTemplate(request: SendTemplateRequest): Promise<SendResult> {
    return this.record({ kind: 'template', request: SendTemplateRequest.parse(request) });
  }

  async sendButtons(request: SendButtonsRequest): Promise<SendResult> {
    const parsed = SendButtonsRequest.parse(request);
    this.checkWindow(parsed.to);
    return this.record({ kind: 'buttons', request: parsed });
  }

  async getMedia(providerMediaId: string): Promise<GetMediaResult> {
    const media = this.media.get(providerMediaId);
    if (!media) throw new Error(`Unknown media id: ${providerMediaId}`);
    return { mimeType: media.mimeType, data: media.data.slice() };
  }

  async verifyWebhook(request: WebhookRequest): Promise<InboundMessage[]> {
    const { headers, body, url } = WebhookRequest.parse(request);
    const signature = Object.entries(headers).find(([k]) => k.toLowerCase() === SIMULATOR_SIGNATURE_HEADER)?.[1];
    const expected = Buffer.from(this.sign(url, body));
    if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), expected)) {
      throw new InvalidWebhookSignatureError('Simulator webhook signature does not verify');
    }
    const parsed: unknown = JSON.parse(body);
    const messages = (parsed as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) throw new Error('Simulator webhook body has no messages array');
    return messages.map((m) => InboundMessage.parse(m));
  }

  /** Messages sent to one number, in order. */
  sentTo(phone: string): SentMessage[] {
    return this.sent.filter((m) => m.request.to === phone);
  }

  /** Stores media the owner "uploaded" and returns its provider media id. */
  addMedia(mimeType: string, data: Uint8Array): string {
    const id = `ME-sim-${this.nextId++}`;
    this.media.set(id, { mimeType, data: data.slice() });
    return id;
  }

  /** The next send call throws this error and records nothing (a closed window, a vendor outage). */
  failNextSend(error: Error = new Error('Simulated send failure')): void {
    this.sendFailures.push(error);
  }

  inboundText(from: string, text: string): InboundMessage {
    return this.inbound(from, { kind: 'text', text });
  }

  inboundVoice(from: string, providerMediaId: string): InboundMessage {
    return this.inbound(from, { kind: 'voice', providerMediaId });
  }

  inboundImage(from: string, providerMediaId: string, caption?: string): InboundMessage {
    return this.inbound(from, { kind: 'image', providerMediaId, ...(caption === undefined ? {} : { caption }) });
  }

  /** A tap on an Approve or Change button. */
  inboundButtonTap(from: string, payload: ApprovalButtonPayload): InboundMessage {
    return this.inbound(from, { kind: 'button_reply', buttonId: payload.action, payload });
  }

  inbound(from: string, content: InboundMessage['content']): InboundMessage {
    this.lastInbound.set(from, this.now());
    return InboundMessage.parse({
      provider: this.name,
      providerMessageId: `SM-sim-in-${this.run}-${this.nextId++}`,
      from,
      to: this.businessNumber,
      receivedAt: this.now().toISOString(),
      content,
    });
  }

  /** A signed webhook request carrying these messages, as the messaging module receives it. */
  webhook(...messages: InboundMessage[]): WebhookRequest {
    const body = JSON.stringify({ messages });
    return {
      headers: { 'content-type': 'application/json', [SIMULATOR_SIGNATURE_HEADER]: this.sign(this.url, body) },
      body,
      url: this.url,
    };
  }

  private checkWindow(to: string): void {
    if (!this.enforceWindow) return;
    const last = this.lastInbound.get(to) ?? null;
    if (!last || this.now().getTime() - last.getTime() > WINDOW_MS) throw new WindowClosedError(to, last);
  }

  private sign(url: string, body: string): string {
    return `sha256=${createHmac('sha256', this.secret).update(url).update(body).digest('hex')}`;
  }

  private record(message: Omit<SentMessage, 'providerMessageId' | 'sentAt'>): SendResult {
    const failure = this.sendFailures.shift();
    if (failure) throw failure;
    const providerMessageId = `SM-sim-out-${this.run}-${this.nextId++}`;
    this.sent.push({ ...message, providerMessageId, sentAt: this.now().toISOString() } as SentMessage);
    return { providerMessageId };
  }
}
