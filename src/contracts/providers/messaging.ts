import { z } from 'zod';
import { ContentHash, Language, Phone, Timestamp, Url, Uuid } from '../common.js';

/** Payload of the Approve and Change buttons; ties a tap to one exact post version. */
export const ApprovalButtonPayload = z.object({
  action: z.enum(['approve', 'change']),
  postId: Uuid,
  versionHash: ContentHash,
});
export type ApprovalButtonPayload = z.infer<typeof ApprovalButtonPayload>;

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

export const SendTextRequest = z.object({ to: Phone, text: z.string().min(1) });
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

/** The only code that knows the WhatsApp provider implements this. */
export interface MessagingProvider {
  readonly name: string;
  sendText(request: SendTextRequest): Promise<SendResult>;
  sendTemplate(request: SendTemplateRequest): Promise<SendResult>;
  sendButtons(request: SendButtonsRequest): Promise<SendResult>;
  getMedia(providerMediaId: string): Promise<GetMediaResult>;
  /** Throws InvalidWebhookSignatureError when the signature does not verify. */
  verifyWebhook(request: WebhookRequest): Promise<InboundMessage[]>;
}
