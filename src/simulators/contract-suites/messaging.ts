import { beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { Language } from '../../contracts/common.js';
import {
  GetMediaResult,
  InboundMessage,
  InvalidWebhookSignatureError,
  type MessagingProvider,
  SendResult,
  type WebhookRequest,
} from '../../contracts/providers/messaging.js';

export interface MessagingContractContext {
  provider: MessagingProvider;
  /** A number the provider may send to here: a simulator number or a vendor test recipient. */
  recipient: string;
  /** A template the provider account can send, with its variables. */
  template: { name: string; language: z.infer<typeof Language>; variables: Record<string, string> };
  /** A webhook request signed the way the vendor signs it, carrying at least one message. */
  signedWebhook(): Promise<WebhookRequest>;
  /** A media id that getMedia can return. */
  mediaId(): Promise<string>;
}

/** The behavior every MessagingProvider must share; WP-41 runs it against the real adapter. */
export function describeMessagingProviderContract(
  label: string,
  makeContext: () => MessagingContractContext | Promise<MessagingContractContext>,
): void {
  describe(`MessagingProvider contract: ${label}`, () => {
    let ctx: MessagingContractContext;
    beforeEach(async () => {
      ctx = await makeContext();
    });

    it('has a name', () => {
      expect(ctx.provider.name.length).toBeGreaterThan(0);
    });

    it('sends text, templates, and buttons, each with its own provider message id', async () => {
      const { provider, recipient, template } = ctx;
      const results = [
        await provider.sendText({ to: recipient, text: 'שלום' }),
        await provider.sendTemplate({
          to: recipient,
          templateName: template.name,
          language: template.language,
          variables: template.variables,
        }),
        await provider.sendButtons({
          to: recipient,
          text: 'טיוטה לאישור',
          buttons: [
            { id: 'approve', title: 'אישור' },
            { id: 'change', title: 'שינוי' },
          ],
        }),
      ];
      for (const result of results) expect(SendResult.safeParse(result).success).toBe(true);
      expect(new Set(results.map((r) => r.providerMessageId)).size).toBe(3);
    });

    it('rejects requests outside the contract shapes', async () => {
      const { provider, recipient } = ctx;
      await expect(provider.sendText({ to: '0501234567', text: 'hi' })).rejects.toThrow();
      await expect(provider.sendText({ to: recipient, text: '' })).rejects.toThrow();
      const button = { id: 'b', title: 'x' };
      await expect(
        provider.sendButtons({ to: recipient, text: 'x', buttons: [button, button, button, button] }),
      ).rejects.toThrow();
    });

    it('turns a signed webhook into valid inbound messages', async () => {
      const messages = await ctx.provider.verifyWebhook(await ctx.signedWebhook());
      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) expect(InboundMessage.safeParse(message).success).toBe(true);
    });

    it('rejects a webhook whose body was changed after signing', async () => {
      const request = await ctx.signedWebhook();
      await expect(ctx.provider.verifyWebhook({ ...request, body: `${request.body} ` })).rejects.toBeInstanceOf(
        InvalidWebhookSignatureError,
      );
    });

    it('rejects a webhook without a signature', async () => {
      const request = await ctx.signedWebhook();
      await expect(ctx.provider.verifyWebhook({ ...request, headers: {} })).rejects.toBeInstanceOf(
        InvalidWebhookSignatureError,
      );
    });

    it('returns media bytes for a known media id', async () => {
      const media = await ctx.provider.getMedia(await ctx.mediaId());
      expect(GetMediaResult.safeParse(media).success).toBe(true);
      expect(media.data.length).toBeGreaterThan(0);
    });

    it('rejects an unknown media id', async () => {
      await expect(ctx.provider.getMedia('no-such-media-id')).rejects.toThrow();
    });
  });
}
