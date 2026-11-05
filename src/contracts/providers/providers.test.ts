import { describe, expect, it } from 'vitest';
import { ApprovalButtonPayload, decodeButtonId, encodeButtonId, InboundMessage, SendButtonsRequest } from './messaging.js';
import { PublishRequest } from './publishing.js';
import { RenderRequest } from './renderer.js';

const hash = 'a'.repeat(64);
const uuid = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const uuid2 = '7a1c2e3f-5b6d-4e8f-9a0b-1c2d3e4f5a6b';

describe('ApprovalButtonPayload', () => {
  it('ties a tap to a post and a version hash', () => {
    expect(ApprovalButtonPayload.parse({ action: 'approve', postId: uuid, versionHash: hash })).toEqual({
      action: 'approve',
      postId: uuid,
      versionHash: hash,
    });
  });

  it.each(['A'.repeat(64), 'a'.repeat(63), 'not-a-hash'])('rejects version hash %s', (versionHash) => {
    expect(ApprovalButtonPayload.safeParse({ action: 'approve', postId: uuid, versionHash }).success).toBe(false);
  });

  it('rejects an unknown action', () => {
    expect(ApprovalButtonPayload.safeParse({ action: 'publish', postId: uuid, versionHash: hash }).success).toBe(false);
  });
});

describe('button ids', () => {
  it('round-trips a payload through the button id', () => {
    const payload = { action: 'change', postId: uuid, versionHash: hash } as const;
    expect(encodeButtonId(payload)).toBe(`change:${uuid}:${hash}`);
    expect(decodeButtonId(encodeButtonId(payload))).toEqual(payload);
  });

  it('carries the version id in the button id, so a tap is bound to one version row', () => {
    const payload = { action: 'approve', postId: uuid, versionId: uuid2, versionHash: hash } as const;
    expect(encodeButtonId(payload)).toBe(`approve:${uuid}:${uuid2}:${hash}`);
    expect(decodeButtonId(encodeButtonId(payload))).toEqual(payload);
  });

  it.each(['approve', `approve:${uuid}`, `approve:${uuid}:x:${hash}`, `approve:${uuid}:${uuid2}:${hash}:x`, `publish:${uuid}:${hash}`, `approve:${uuid}:${hash}:x`])('rejects id %s', (id) => {
    expect(decodeButtonId(id)).toBeUndefined();
  });
});

describe('InboundMessage', () => {
  const base = {
    provider: 'simulator',
    providerMessageId: 'SM1',
    from: '+972501234567',
    to: '+972501234562',
    receivedAt: '2026-11-02T10:00:00.000Z',
  };

  it.each([
    { kind: 'text', text: 'יש לנו צבעונים חדשים' },
    { kind: 'voice', providerMediaId: 'ME1' },
    { kind: 'image', providerMediaId: 'ME2', caption: 'the new tulips' },
    { kind: 'button_reply', buttonId: 'approve', payload: { action: 'approve', postId: uuid, versionHash: hash } },
  ])('accepts $kind content', (content) => {
    expect(InboundMessage.safeParse({ ...base, content }).success).toBe(true);
  });

  it('rejects a button reply whose payload is not an approval payload', () => {
    const content = { kind: 'button_reply', buttonId: 'approve', payload: { action: 'approve' } };
    expect(InboundMessage.safeParse({ ...base, content }).success).toBe(false);
  });

  it('rejects a sender that is not E.164', () => {
    expect(InboundMessage.safeParse({ ...base, from: '0501234567', content: { kind: 'text', text: 'hi' } }).success).toBe(
      false,
    );
  });
});

describe('SendButtonsRequest', () => {
  const button = { id: 'b', title: 'אישור' };

  it('allows 1 to 3 buttons', () => {
    const req = { to: '+972501234567', text: 'draft' };
    expect(SendButtonsRequest.safeParse({ ...req, buttons: [] }).success).toBe(false);
    expect(SendButtonsRequest.safeParse({ ...req, buttons: [button] }).success).toBe(true);
    expect(SendButtonsRequest.safeParse({ ...req, buttons: [button, button, button, button] }).success).toBe(false);
  });
});

describe('PublishRequest', () => {
  const req = {
    idempotencyKey: uuid,
    providerAccountId: 'acc_1',
    network: 'instagram',
    caption: 'צבעונים',
    mediaUrls: ['https://storage.example.test/a.jpg'],
    format: 'single',
    scheduledFor: '2026-11-03T08:00:00.000Z',
  };

  it('accepts a complete request', () => {
    expect(PublishRequest.safeParse(req).success).toBe(true);
  });

  it('requires a publication id as the idempotency key', () => {
    expect(PublishRequest.safeParse({ ...req, idempotencyKey: 'x' }).success).toBe(false);
  });

  it('requires at least one media url', () => {
    expect(PublishRequest.safeParse({ ...req, mediaUrls: [] }).success).toBe(false);
  });
});

describe('RenderRequest', () => {
  it('requires at least one network and one photo', () => {
    const req = {
      style: 'clean',
      format: 'single',
      photoUrls: ['https://storage.example.test/a.jpg'],
      overlayText: 'חדש!',
      brandColors: [],
      networks: ['facebook'],
    };
    expect(RenderRequest.safeParse(req).success).toBe(true);
    expect(RenderRequest.safeParse({ ...req, networks: [] }).success).toBe(false);
    expect(RenderRequest.safeParse({ ...req, photoUrls: [] }).success).toBe(false);
  });

  // Proposed with the agent (contracts.md, TemplateRenderer): optional edits, badge and layout.
  const carousel = {
    style: 'warm',
    format: 'carousel',
    photoUrls: ['https://storage.example.test/a.jpg', 'https://storage.example.test/b.jpg'],
    overlayText: 'מבצע תמרים',
    brandColors: [],
    networks: ['instagram'],
  };

  it('takes one edit per photo, a badge with its text, and a carousel layout', () => {
    const ok = RenderRequest.safeParse({
      ...carousel,
      edits: [{ rotateDeg: 1.5, crop: { x: 0, y: 0.1, w: 1, h: 0.8 } }, {}],
      badge: { kind: 'discount', text: '-15%' },
      carouselLayout: 'numbered',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects edits that do not match the photos, out-of-range edits, and a badge over 8 characters', () => {
    expect(RenderRequest.safeParse({ ...carousel, edits: [{}] }).success).toBe(false);
    expect(RenderRequest.safeParse({ ...carousel, edits: [{ brightness: 0.9 }, {}] }).success).toBe(false);
    expect(RenderRequest.safeParse({ ...carousel, badge: { kind: 'sale', text: 'מבצע ענק היום' } }).success).toBe(false);
    expect(RenderRequest.safeParse({ ...carousel, badge: { kind: 'stamp', text: 'x' } }).success).toBe(false);
  });
});
