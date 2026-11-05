import type { Network } from '../../src/contracts/common.js';
import type { InboundMessage } from '../../src/contracts/providers/index.js';
import type { SentMessage, SimulatedPost } from '../../src/simulators/index.js';
import type { ChatMessage, FeedPost } from './api-types.js';

// What the playground (WP-45) and the dev sandbox (WP-51) show: the chat and the mock feed, built from
// what the messaging and publishing simulators recorded.

export const NETWORKS: Network[] = ['instagram', 'facebook'];

/** A URL the browser can load through the playground or sandbox API. */
export const mediaUrl = (ref: string) => `/api/media?ref=${encodeURIComponent(ref)}`;

/** The conversation in order: the owner's messages and what Postly sent to the owner. */
export function chatMessages(inbound: { at: string; message: InboundMessage }[], sent: SentMessage[]): ChatMessage[] {
  const fromOwner = inbound.map(({ at, message }): ChatMessage => {
    const c = message.content;
    const base = { id: message.providerMessageId, at, direction: 'from_owner' as const, kind: c.kind };
    switch (c.kind) {
      case 'text':
        return { ...base, text: c.text };
      case 'button_reply':
        return { ...base, text: c.buttonId };
      case 'image':
        return { ...base, ...(c.caption ? { text: c.caption } : {}), media: { url: mediaUrl(c.providerMediaId), mimeType: 'image' } };
      case 'voice':
        return { ...base, media: { url: mediaUrl(c.providerMediaId), mimeType: 'audio' } };
    }
  });
  const toOwner = sent.map((m): ChatMessage => {
    const base = { id: m.providerMessageId, at: m.sentAt, direction: 'to_owner' as const };
    switch (m.kind) {
      case 'text':
        return { ...base, kind: 'text', text: m.request.text, ...(m.request.mediaUrl ? { media: { url: mediaUrl(m.request.mediaUrl), mimeType: 'image' } } : {}) };
      case 'buttons':
        return {
          ...base,
          kind: 'buttons',
          text: m.request.text,
          buttons: m.request.buttons,
          ...(m.request.mediaUrl ? { media: { url: mediaUrl(m.request.mediaUrl), mimeType: 'image' } } : {}),
        };
      case 'template':
        return { ...base, kind: 'template', text: `[${m.request.templateName}] ${Object.values(m.request.variables).join(' · ')}` };
    }
  });
  // Stable: an owner message and its reply can share a millisecond.
  return [...fromOwner, ...toOwner].sort((a, b) => a.at.localeCompare(b.at));
}

/** The mock feed per network, newest first. */
export async function feedPosts(
  posts: SimulatedPost[],
  statusOf: (providerPostId: string) => Promise<FeedPost['status']>,
): Promise<Record<Network, FeedPost[]>> {
  const entries = await Promise.all(
    NETWORKS.map(async (network) => {
      const mine = await Promise.all(
        posts
          .filter((p) => p.request.network === network)
          .map(async (p): Promise<FeedPost> => ({
            id: p.providerPostId,
            network,
            caption: p.request.caption,
            format: p.request.format,
            scheduledFor: p.request.scheduledFor,
            status: await statusOf(p.providerPostId),
            images: p.request.mediaUrls.map(mediaUrl),
          })),
      );
      return [network, mine.reverse()] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<Network, FeedPost[]>;
}

/** Media types the playground and sandbox accept and serve; anything else is served as a download. */
export const MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/webm',
]);

export function allowed(mimeType: string, kind: 'image' | 'audio') {
  if (!MEDIA_TYPES.has(mimeType) || !mimeType.startsWith(`${kind}/`)) throw new Error(`unsupported ${kind} type: ${mimeType}`);
}
