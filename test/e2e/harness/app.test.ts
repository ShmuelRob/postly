import { describe, expect, it } from 'vitest';
import type { MessagingProvider, PublishingProvider } from '../../../src/contracts/providers/index.js';
import { startE2eRun, type AppFactory, type Providers } from './app.js';
import { emptyRecord } from './record.js';

const OWNER = '+972501234567';
const BUSINESS = '+972501234562';
const payload = { action: 'approve', postId: '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e', versionHash: 'a'.repeat(64) } as const;

function providers(overrides: Partial<Providers> = {}): Providers {
  const unused = () => Promise.reject(new Error('unused'));
  const messaging: MessagingProvider = {
    name: 'm',
    sendText: async () => ({ providerMessageId: '1' }),
    sendTemplate: async () => ({ providerMessageId: '2' }),
    sendButtons: async () => ({ providerMessageId: '3' }),
    getMedia: unused,
    verifyWebhook: unused,
  };
  const publishing: PublishingProvider = {
    name: 'p',
    createConnectionLink: unused,
    getConnectionStatus: unused,
    publish: () => Promise.reject(new Error('token expired')),
    getPublicationStatus: unused,
    getMetrics: unused,
  };
  return {
    messaging,
    publishing,
    model: { name: 'x', generateStructured: unused, analyzeImage: unused, transcribeAudio: unused },
    payment: { name: 'y', createPaymentLink: unused, getSubscriptionStatus: unused, cancelSubscription: unused },
    renderer: { render: unused },
    ...overrides,
  };
}

describe('startE2eRun', () => {
  it('records inbound and outbound messages in order and hands inbound messages to the app', async () => {
    const record = emptyRecord();
    const delivered: string[] = [];
    const app: AppFactory = ({ messaging }) => ({
      async deliverInbound(message) {
        delivered.push(message.content.kind);
        await messaging.sendTemplate({ to: message.from, templateName: 'hello', language: 'he', variables: {} });
      },
    });
    const run = await startE2eRun(record, { providers: providers(), app, ownerPhone: OWNER, businessPhone: BUSINESS });

    await run.owner.sendsText('שלום');
    await run.owner.sendsVoice('ME1');

    expect(delivered).toEqual(['text', 'voice']);
    expect(record.transcript.map((m) => `${m.direction}:${m.kind}`)).toEqual([
      'from_owner:text',
      'to_owner:template',
      'from_owner:voice',
      'to_owner:template',
    ]);
    expect(run.owner.received()).toHaveLength(2);
  });

  it('lets the owner tap only a button they were shown', async () => {
    const record = emptyRecord();
    const replies: string[] = [];
    const app: AppFactory = ({ messaging }) => ({
      async deliverInbound(message) {
        if (message.content.kind === 'button_reply') replies.push(message.content.buttonId);
        else await messaging.sendButtons({ to: message.from, text: 'draft', buttons: [{ id: 'b-approve', title: 'אישור' }] });
      },
    });
    const run = await startE2eRun(record, { providers: providers(), app, ownerPhone: OWNER, businessPhone: BUSINESS });

    await expect(run.owner.tapsButton('אישור', payload)).rejects.toThrow(/no button titled/);
    await run.owner.sendsText('update');
    await run.owner.tapsButton('אישור', payload);
    expect(replies).toEqual(['b-approve']);
  });

  it('records a failed publish with its error and rethrows it', async () => {
    const record = emptyRecord();
    const app: AppFactory = ({ publishing }) => ({
      async deliverInbound() {
        await publishing.publish({
          idempotencyKey: payload.postId,
          providerAccountId: 'acc',
          network: 'facebook',
          caption: 'c',
          mediaUrls: ['https://storage.example.test/a.png'],
          format: 'single',
          scheduledFor: '2026-11-03T08:00:00.000Z',
        });
      },
    });
    const run = await startE2eRun(record, { providers: providers(), app, ownerPhone: OWNER, businessPhone: BUSINESS });

    await expect(run.owner.sendsText('go')).rejects.toThrow('token expired');
    expect(run.networkPosts('facebook').map((p) => p.outcome)).toEqual([{ ok: false, error: 'token expired' }]);
    expect(run.networkPosts('facebook')[0]?.media[0]?.src).toBeUndefined();
  });
});
