import { z } from 'zod';
import { ContentHash, Language, Phone, Timestamp, Url, Uuid } from '../common.js';

/** Payload of the Approve and Change buttons; ties a tap to one exact post version. */
export const ApprovalButtonPayload = z.object({
  action: z.enum(['approve', 'change']),
  postId: Uuid,
  /**
   * The exact post_version row the button was sent for (T15). Every button Postly sends carries it,
   * so a later version with the same hash never revives an old button. Optional only so a payload
   * without it still parses; such a tap is checked by hash alone (contracts.md, MessagingProvider).
   */
  versionId: Uuid.optional(),
  versionHash: ContentHash,
});
export type ApprovalButtonPayload = z.infer<typeof ApprovalButtonPayload>;

/**
 * The button id a draft is sent with: `<action>:<postId>:<versionId>:<versionHash>`, or
 * `<action>:<postId>:<versionHash>` for a payload without a version id (contracts.md, MessagingProvider).
 */
export function encodeButtonId(payload: ApprovalButtonPayload): string {
  const p = ApprovalButtonPayload.parse(payload);
  return p.versionId ? `${p.action}:${p.postId}:${p.versionId}:${p.versionHash}` : `${p.action}:${p.postId}:${p.versionHash}`;
}

/** The payload of a tapped button id, or undefined when the id is not one `encodeButtonId` made. */
export function decodeButtonId(id: string): ApprovalButtonPayload | undefined {
  const parts = id.split(':');
  if (parts.length !== 3 && parts.length !== 4) return undefined;
  const [action, postId, ...tail] = parts;
  const candidate = tail.length === 2 ? { action, postId, versionId: tail[0], versionHash: tail[1] } : { action, postId, versionHash: tail[0] };
  const parsed = ApprovalButtonPayload.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export const InboundContent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('voice'), providerMediaId: z.string().min(1) }),
  z.object({ kind: z.literal('image'), providerMediaId: z.string().min(1), caption: z.string().optional() }),
  z.object({ kind: z.literal('button_reply'), buttonId: z.string().min(1), payload: ApprovalButtonPayload }),
]);

export const InboundMessage = z.object({
  provider: z.string().min(1),
  providerMessageId: z.string().min(1),
  from: Phone,
  to: Phone,
  receivedAt: Timestamp,
  content: InboundContent,
});
export type InboundMessage = z.infer<typeof InboundMessage>;

export const SendTextRequest = z.object({
  to: Phone,
  text: z.string().min(1),
  /** An image sent with the text as its caption (the onboarding style samples). */
  mediaUrl: Url.optional(),
});
export type SendTextRequest = z.infer<typeof SendTextRequest>;

export const SendTemplateRequest = z.object({
  to: Phone,
  templateName: z.string().min(1),
  language: Language,
  variables: z.record(z.string(), z.string()),
});
export type SendTemplateRequest = z.infer<typeof SendTemplateRequest>;

export const SendButtonsRequest = z.object({
  to: Phone,
  text: z.string().min(1),
  mediaUrl: Url.optional(),
  buttons: z
    .array(z.object({ id: z.string().min(1), title: z.string().min(1).max(20) }))
    .min(1)
    .max(3),
});
export type SendButtonsRequest = z.infer<typeof SendButtonsRequest>;

export const SendResult = z.object({ providerMessageId: z.string().min(1) });
export type SendResult = z.infer<typeof SendResult>;

export const GetMediaResult = z.object({ mimeType: z.string().min(1), data: z.instanceof(Uint8Array) });
export type GetMediaResult = z.infer<typeof GetMediaResult>;

export const WebhookRequest = z.object({
  headers: z.record(z.string(), z.string()),
  body: z.string(),
  url: Url,
});
export type WebhookRequest = z.infer<typeof WebhookRequest>;

export class InvalidWebhookSignatureError extends Error {
  override name = 'InvalidWebhookSignatureError';
}

/**
 * A free-form send (text or buttons) outside the 24-hour WhatsApp window. Only an approved
 * template may go out; the caller sends one or waits for the owner.
 */
export class WindowClosedError extends Error {
  override name = 'WindowClosedError';
  constructor(
    readonly to: string,
    /** The owner's last inbound message, or null when the number never wrote. */
    readonly lastInboundAt: Date | null,
  ) {
    super(`The 24-hour window to ${to} is closed`);
  }
}

/** The only code that knows the WhatsApp provider implements this. */
export interface MessagingProvider {
  readonly name: string;
  /** Throws WindowClosedError outside the 24-hour window, as does sendButtons. */
  sendText(request: SendTextRequest): Promise<SendResult>;
  sendTemplate(request: SendTemplateRequest): Promise<SendResult>;
  sendButtons(request: SendButtonsRequest): Promise<SendResult>;
  getMedia(providerMediaId: string): Promise<GetMediaResult>;
  /** Throws InvalidWebhookSignatureError when the signature does not verify. */
  verifyWebhook(request: WebhookRequest): Promise<InboundMessage[]>;
}
