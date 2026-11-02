import { describe, expect, it } from 'vitest';
import { InvalidWebhookSignatureError } from '../contracts/providers/messaging.js';
import { describeMessagingProviderContract } from './contract-suites/messaging.js';
import { MessagingSimulator } from './messaging.js';

const owner = '+972501234567';
const postId = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const versionHash = 'a'.repeat(64);

describeMessagingProviderContract('simulator', () => {
  const provider = new MessagingSimulator();
  return {
    provider,
    recipient: owner,
    template: { name: 'weekly_reminder', language: 'he', variables: { '1': 'דנה' } },
    signedWebhook: async () => provider.webhook(provider.inboundText(owner, 'שלום')),
    mediaId: async () => provider.addMedia('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff])),
  };
});

describe('MessagingSimulator', () => {
  it('records what the owner would see, in order', async () => {
    const sim = new MessagingSimulator();
    await sim.sendText({ to: owner, text: 'היי' });
    await sim.sendButtons({
      to: owner,
      text: 'הטיוטה מוכנה',
      mediaUrl: 'https://storage.example.test/draft.jpg',
      buttons: [{ id: 'approve', title: 'אישור' }],
    });
    await sim.sendText({ to: '+972509999999', text: 'someone else' });

    expect(sim.sentTo(owner).map((m) => m.kind)).toEqual(['text', 'buttons']);
    expect(sim.sentTo(owner)[1]).toMatchObject({ kind: 'buttons', request: { text: 'הטיוטה מוכנה' } });
    expect(sim.sent).toHaveLength(3);
  });

  it('builds signed webhooks for every inbound kind', async () => {
    const sim = new MessagingSimulator({ businessNumber: '+972521111111' });
    const voiceId = sim.addMedia('audio/ogg', new Uint8Array([1, 2, 3]));
    const request = sim.webhook(
      sim.inboundText(owner, 'יש לנו צבעונים חדשים'),
      sim.inboundVoice(owner, voiceId),
      sim.inboundImage(owner, sim.addMedia('image/jpeg', new Uint8Array([4])), 'הצבעונים'),
      sim.inboundButtonTap(owner, { action: 'approve', postId, versionHash }),
    );

    const messages = await sim.verifyWebhook(request);
    expect(messages.map((m) => m.content.kind)).toEqual(['text', 'voice', 'image', 'button_reply']);
    expect(messages.every((m) => m.to === '+972521111111' && m.provider === 'simulator')).toBe(true);
    expect(new Set(messages.map((m) => m.providerMessageId)).size).toBe(4);
    expect(messages[3]?.content).toEqual({
      kind: 'button_reply',
      buttonId: 'approve',
      payload: { action: 'approve', postId, versionHash },
    });
    expect(await sim.getMedia(voiceId)).toEqual({ mimeType: 'audio/ogg', data: new Uint8Array([1, 2, 3]) });
  });

  it('replays the same message for duplicate-delivery tests', async () => {
    const sim = new MessagingSimulator();
    const message = sim.inboundText(owner, 'שלום');
    const [first] = await sim.verifyWebhook(sim.webhook(message));
    const [again] = await sim.verifyWebhook(sim.webhook(message));
    expect(again?.providerMessageId).toBe(first?.providerMessageId);
  });

  it('rejects a webhook signed with another secret', async () => {
    const other = new MessagingSimulator({ webhookSecret: 'other' });
    const sim = new MessagingSimulator();
    await expect(sim.verifyWebhook(other.webhook(other.inboundText(owner, 'x')))).rejects.toBeInstanceOf(
      InvalidWebhookSignatureError,
    );
  });

  it('fails the next send when scripted, without recording it', async () => {
    const sim = new MessagingSimulator();
    sim.failNextSend(new Error('24-hour window closed'));
    await expect(sim.sendText({ to: owner, text: 'x' })).rejects.toThrow('24-hour window closed');
    await sim.sendText({ to: owner, text: 'y' });
    expect(sim.sent.map((m) => m.request)).toEqual([{ to: owner, text: 'y' }]);
  });

  it('stamps messages with the injected clock', async () => {
    const at = new Date('2026-11-02T10:00:00.000Z');
    const sim = new MessagingSimulator({ now: () => at });
    await sim.sendText({ to: owner, text: 'x' });
    expect(sim.sent[0]?.sentAt).toBe('2026-11-02T10:00:00.000Z');
    expect(sim.inboundText(owner, 'x').receivedAt).toBe('2026-11-02T10:00:00.000Z');
  });
});
