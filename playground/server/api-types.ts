// What the playground API returns and accepts; shared by the server and the React UI.
import type { Network } from '../../src/contracts/common.js';

/** One chat bubble as the UI shows it. */
export interface ChatMessage {
  id: string;
  at: string;
  direction: 'from_owner' | 'to_owner';
  kind: 'text' | 'voice' | 'image' | 'button_reply' | 'buttons' | 'template';
  text?: string;
  buttons?: { id: string; title: string }[];
  /** A playground URL the browser can load (`/api/media?ref=...`). */
  media?: { url: string; mimeType: string };
}

export interface FeedPost {
  id: string;
  network: Network;
  caption: string;
  format: string;
  scheduledFor: string;
  status: 'scheduled' | 'published' | 'failed';
  images: string[];
}

export interface PlaygroundState {
  owner: string;
  business: { id: string; name: string; status: string };
  conversation: { step: string; handoff: boolean } | null;
  /** The owner's channels as the database records them, after the owner connected them. */
  channels: { network: Network; status: string }[];
  /** Onboarding sent the connection link, so the human can connect on the publishing simulator. */
  connectionLinkSent: boolean;
  posts: { id: string; status: string; format: string }[];
  reviewQueue: { id: string; kind: string; status: string; details: unknown }[];
  messages: ChatMessage[];
  feed: Record<Network, FeedPost[]>;
}

export type OwnerInput =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; dataBase64: string; caption?: string }
  | { kind: 'voice'; mimeType: string; dataBase64: string }
  | { kind: 'button'; buttonId: string };
