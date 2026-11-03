import { randomUUID } from 'node:crypto';
import type { Network } from '../../src/contracts/common.js';
import type { PublishingSimulator } from '../../src/simulators/index.js';
import { placeholderPng } from '../../test/e2e/harness/png.js';

/**
 * Scripted posts on the publishing simulator, so the mock feed has something to show before the
 * publishing flow (WP-34) exists. Each network is connected for the playground business.
 */
export async function seedFeed(
  publishing: PublishingSimulator,
  businessId: string,
  media: Map<string, { mimeType: string; data: Uint8Array }>,
) {
  const posts: { network: Network; caption: string; colors: [[number, number, number], [number, number, number]] }[] = [
    { network: 'instagram', caption: 'פוסט לדוגמה מהמגרש: מבצע חלות לשבת, 2 ב-20 ש"ח', colors: [[250, 236, 214], [196, 98, 45]] },
    { network: 'facebook', caption: 'פוסט לדוגמה מהמגרש: פתוחים גם ביום שישי עד 14:00', colors: [[228, 238, 246], [38, 84, 140]] },
  ];
  for (const post of posts) {
    const accountId = publishing.connect(businessId, post.network);
    const url = `https://media.playground.test/seed-${post.network}.png`;
    media.set(url, { mimeType: 'image/png', data: placeholderPng(540, 540, ...post.colors) });
    await publishing.publish({
      idempotencyKey: randomUUID(),
      providerAccountId: accountId,
      network: post.network,
      caption: post.caption,
      mediaUrls: [url],
      format: 'single',
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
    });
  }
}
