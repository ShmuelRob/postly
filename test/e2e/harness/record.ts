import type { Network } from '../../../src/contracts/common.js';

/** An image as the report shows it: the bytes are embedded as a data URI so the report is one file. */
export interface ImageAttachment {
  /** The storage path or URL the app used for the image. */
  ref: string;
  mimeType: string;
  /** `data:` URI with the image bytes, or undefined when the harness could not read the media. */
  src?: string;
}

/** One WhatsApp message between the owner and Postly, as the owner sees it in the chat. */
export interface TranscriptEntry {
  at: string;
  direction: 'from_owner' | 'to_owner';
  /** The owner's number. */
  phone: string;
  kind: 'text' | 'voice' | 'image' | 'button_reply' | 'buttons' | 'template';
  text?: string;
  buttons?: { id: string; title: string }[];
  image?: ImageAttachment;
  template?: { name: string; language: string; variables: Record<string, string> };
}

/** One file the design engine produced for a network. */
export interface RenderedImage {
  at: string;
  network: Network;
  style: string;
  width: number;
  height: number;
  image: ImageAttachment;
}

/** One call that reached the publishing provider, as the network would receive it. */
export interface PublishingEntry {
  at: string;
  network: Network;
  providerAccountId: string;
  idempotencyKey: string;
  format: string;
  scheduledFor: string;
  caption: string;
  media: ImageAttachment[];
  outcome: { ok: true; providerPostId: string } | { ok: false; error: string };
}

/** Everything one end-to-end test recorded about what the owner and the networks would see. */
export interface E2eRecord {
  transcript: TranscriptEntry[];
  renders: RenderedImage[];
  publishing: PublishingEntry[];
}

export function emptyRecord(): E2eRecord {
  return { transcript: [], renders: [], publishing: [] };
}

declare module 'vitest' {
  interface TaskMeta {
    /** Set by the e2e harness; read by the e2e reporter. */
    e2e?: E2eRecord;
  }
}
