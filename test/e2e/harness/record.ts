import type { Network } from '../../../src/contracts/common.js';
import type { AgentStepRecord, AgentTurnReport } from '../../../src/simulators/scripted-agent.js';

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

/** One call that reached the model provider, and whether its output passed the task schema. */
export interface ModelCallEntry {
  at: string;
  method: 'generateStructured' | 'analyzeImage' | 'transcribeAudio';
  task: string;
  /** Raw provider output, or undefined when the call failed. */
  output?: unknown;
  valid: boolean;
  error?: string;
}

/** One item routed to the team console, as the team would see it. */
export interface ConsoleEntry {
  at: string;
  kind: string;
  details: unknown;
}

/** A screenshot of a UI the test drove, such as the local playground. */
export interface ScreenshotEntry {
  at: string;
  title: string;
  image: ImageAttachment;
}

/** One step the scripted agent served (agent.md, Testing without paying for a model). */
export type AgentStepEntry = AgentStepRecord & { at: string };

/** One agent turn as the runtime reported it: every step's calls and results, and why it stopped. */
export type AgentTurnEntry = AgentTurnReport & { at: string };

/** Everything one end-to-end test recorded about what the owner and the networks would see. */
export interface E2eRecord {
  transcript: TranscriptEntry[];
  renders: RenderedImage[];
  publishing: PublishingEntry[];
  modelCalls?: ModelCallEntry[];
  consoleItems?: ConsoleEntry[];
  screenshots?: ScreenshotEntry[];
  agentSteps?: AgentStepEntry[];
  agentTurns?: AgentTurnEntry[];
}

export function emptyRecord(): E2eRecord {
  return { transcript: [], renders: [], publishing: [], modelCalls: [], consoleItems: [] };
}

// The vitest TaskMeta augmentation for `e2e` lives in ./task-meta.ts, so this file stays free of
// test-only modules: the dev sandbox image compiles it without vitest installed (Dockerfile.sandbox).
