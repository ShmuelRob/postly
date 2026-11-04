/**
 * Sample end-to-end test: shows how to drive the app through the harness and assert on what the
 * owner and the networks see. The product modules do not exist yet, so the app here is a stub
 * written in this file, and the providers are minimal fakes. When WP-03's simulators and the real
 * composition root land, tests pass those instead and keep the same assertions style.
 */
import { expect } from 'vitest';
import type {
  MessagingProvider,
  ModelProvider,
  PaymentProvider,
  PublishingProvider,
  PublishRequest,
  TemplateRenderer,
} from '../../src/contracts/providers/index.js';
import { e2eTest, placeholderPng, type AppFactory, type MediaReader, type Providers } from './harness/index.js';

const OWNER = '+972501234567';
const BUSINESS = '+972501234562';
const STORAGE = 'https://storage.example.test/';
const POST_ID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const VERSION_HASH = 'a'.repeat(64);

function fakes() {
  const media = new Map<string, Uint8Array>();
  let seq = 0;
  const notUsed = (what: string) => () => Promise.reject(new Error(`${what} is not used in this test`));

  const messaging: MessagingProvider = {
    name: 'fake-messaging',
    sendText: async () => ({ providerMessageId: `out-${++seq}` }),
    sendTemplate: async () => ({ providerMessageId: `out-${++seq}` }),
    sendButtons: async () => ({ providerMessageId: `out-${++seq}` }),
    getMedia: notUsed('getMedia'),
    verifyWebhook: notUsed('verifyWebhook'),
  };
  const published: PublishRequest[] = [];
  const publishing: PublishingProvider = {
    name: 'fake-publishing',
    createConnectionLink: notUsed('createConnectionLink'),
    getConnectionStatus: notUsed('getConnectionStatus'),
    publish: async (request) => {
      published.push(request);
      return { providerPostId: `${request.network}-post-${published.length}` };
    },
    getPublicationStatus: notUsed('getPublicationStatus'),
    getMetrics: notUsed('getMetrics'),
    disconnectAccount: notUsed('disconnectAccount'),
    testSchedule: notUsed('testSchedule'),
  };
  const renderer: TemplateRenderer = {
    render: async (request) => {
      const result: Awaited<ReturnType<TemplateRenderer['render']>> = {};
      for (const network of request.networks) {
        const storagePath = `renders/${network}-${++seq}.png`;
        media.set(storagePath, placeholderPng(1080, 1350, [246, 239, 230], [196, 92, 72]));
        result[network] = [{ storagePath, width: 1080, height: 1350, mimeType: 'image/png' }];
      }
      return result;
    },
  };
  const model: ModelProvider = {
    name: 'fake-model',
    generateStructured: notUsed('generateStructured'),
    analyzeImage: notUsed('analyzeImage'),
    transcribeAudio: notUsed('transcribeAudio'),
  };
  const payment: PaymentProvider = {
    name: 'fake-payment',
    createPaymentLink: notUsed('createPaymentLink'),
    getSubscriptionStatus: notUsed('getSubscriptionStatus'),
    cancelSubscription: notUsed('cancelSubscription'),
  };
  const readMedia: MediaReader = async (ref) => {
    const data = media.get(ref.startsWith(STORAGE) ? ref.slice(STORAGE.length) : ref);
    return data && { mimeType: 'image/png', data };
  };
  return { providers: { messaging, publishing, renderer, model, payment } satisfies Providers, readMedia };
}

/**
 * Stub app: a text from the owner becomes a rendered draft with Approve and Change buttons, and an
 * Approve tap publishes it to both networks. It stands in for the real app only to exercise the harness.
 */
const stubApp: AppFactory = ({ messaging, renderer, publishing }) => {
  let draft: { caption: string; files: Record<'instagram' | 'facebook', string> } | undefined;
  return {
    async deliverInbound(message) {
      const { content } = message;
      if (content.kind === 'text') {
        const rendered = await renderer.render({
          style: 'warm',
          format: 'single',
          photoUrls: [`${STORAGE}uploads/tulips.jpg`],
          overlayText: 'צבעונים חדשים',
          brandColors: ['#c45c48'],
          networks: ['instagram', 'facebook'],
        });
        const instagram = rendered.instagram?.[0]?.storagePath;
        const facebook = rendered.facebook?.[0]?.storagePath;
        if (!instagram || !facebook) throw new Error('renderer returned no file for a network');
        draft = { caption: `${content.text} 🌷`, files: { instagram, facebook } };
        await messaging.sendButtons({
          to: message.from,
          text: `הנה הטיוטה לפוסט:\n${draft.caption}`,
          mediaUrl: `${STORAGE}${instagram}`,
          buttons: [
            { id: `approve:${POST_ID}`, title: 'אישור' },
            { id: `change:${POST_ID}`, title: 'שינוי' },
          ],
        });
      } else if (content.kind === 'button_reply' && content.payload.action === 'approve' && draft) {
        for (const network of ['instagram', 'facebook'] as const) {
          await publishing.publish({
            idempotencyKey: POST_ID,
            providerAccountId: `acc-${network}`,
            network,
            caption: draft.caption,
            mediaUrls: [`${STORAGE}${draft.files[network]}`],
            format: 'single',
            scheduledFor: '2026-11-03T08:00:00.000Z',
          });
        }
        await messaging.sendText({ to: message.from, text: 'הפוסט אושר ותוזמן לפרסום מחר ב-10:00' });
      }
    },
  };
};

e2eTest('owner sends an update, approves the draft, and the post reaches both networks', async ({ e2e }) => {
  const { providers, readMedia } = fakes();
  const run = await e2e.start({ providers, app: stubApp, ownerPhone: OWNER, businessPhone: BUSINESS, readMedia });

  await run.owner.sendsText('הגיעו צבעונים חדשים לחנות');

  const [draft] = run.owner.received();
  expect(draft?.text).toContain('הגיעו צבעונים חדשים לחנות');
  expect(draft?.buttons?.map((b) => b.title)).toEqual(['אישור', 'שינוי']);
  expect(draft?.image?.src).toMatch(/^data:image\/png;base64,/);
  expect(run.networkPosts()).toHaveLength(0);

  await run.owner.tapsButton('אישור', { action: 'approve', postId: POST_ID, versionHash: VERSION_HASH });

  expect(run.networkPosts().map((p) => p.network)).toEqual(['instagram', 'facebook']);
  for (const post of run.networkPosts()) {
    expect(post.caption).toBe('הגיעו צבעונים חדשים לחנות 🌷');
    expect(post.outcome.ok).toBe(true);
    expect(post.media[0]?.src).toMatch(/^data:image\/png;base64,/);
  }
  expect(run.renders().map((r) => `${r.network} ${r.width}x${r.height}`)).toEqual([
    'instagram 1080x1350',
    'facebook 1080x1350',
  ]);
  expect(run.owner.received().at(-1)?.text).toBe('הפוסט אושר ותוזמן לפרסום מחר ב-10:00');
});
