/**
 * The test world the human-owned H5 tests run against (gate H5, docs/implementation-plan.md).
 * WP-33 and WP-34 implement `H5WorldFactory` over the real modules and a real database and bind
 * it in `subject.ts`; they never edit the tests. Every setup step goes through the real code paths
 * except `forgePublication`, which writes a row directly, the way a bug or tampering would.
 */
import { it } from 'vitest';
import type { ApprovalService, PublishingJob } from '../../src/contracts/approval.js';
import type { Network } from '../../src/contracts/common.js';
import type { MessagingProvider, PublishingProvider } from '../../src/contracts/providers/index.js';
import type { PostState } from '../../src/contracts/state-machines/post.js';
import type { PublicationState } from '../../src/contracts/state-machines/publication.js';
import type { AppUnderTest } from '../e2e/harness/index.js';
import { H5_PENDING, type H5Package } from './pending.js';
import { createH5World as bound } from './subject.js';

export interface Draft {
  postId: string;
  /** `content_hash` of the post's current version. */
  versionHash: string;
  /** Titles of the buttons the draft was sent with, so an e2e owner can tap them. */
  buttons: { approve: string; change: string };
}

export interface H5World {
  approval: ApprovalService;
  publishingJob: PublishingJob;
  /** The app wired to the same database and providers, for e2e runs through the harness. */
  app: AppUnderTest;

  /** An active business whose single approver number is `approverPhone`. */
  createBusiness(approverPhone: string): Promise<string>;
  /** Connects a channel through the publishing provider and stores the connection as verified. */
  connectChannel(businessId: string, network: Network): Promise<void>;
  /** A post in `awaiting_approval` with one version, sent to the approver with approve and change buttons. */
  createDraft(businessId: string, caption: string): Promise<Draft>;
  /** A change request that produces a new current version and sends it with new buttons. */
  requestChange(businessId: string, postId: string, newCaption: string): Promise<Draft>;
  /** The owner confirms the times: one publication per verified channel, from the valid approval. */
  schedule(businessId: string, postId: string, scheduledFor: string): Promise<{ publicationId: string; network: Network }[]>;
  /** Inserts a publication row directly, skipping every application check. May throw if the database refuses it. */
  forgePublication(
    businessId: string,
    row: { postId: string; approvalId: string; approvedVersionHash: string; network: Network; scheduledFor: string },
  ): Promise<string>;

  postStatus(businessId: string, postId: string): Promise<PostState>;
  approvals(businessId: string, postId: string): Promise<{ approvalId: string; versionHash: string; invalidated: boolean }[]>;
  publicationStatus(publicationId: string): Promise<{ status: PublicationState; providerPostId?: string }>;

  setGlobalPause(paused: boolean): Promise<void>;
  setBusinessPaused(businessId: string, paused: boolean): Promise<void>;
  setHandoff(businessId: string, on: boolean): Promise<void>;

  close(): Promise<void>;
}

export type H5WorldFactory = (options: {
  messaging: MessagingProvider;
  publishing: PublishingProvider;
  now: () => Date;
}) => Promise<H5World>;

export function createH5World(options: Parameters<H5WorldFactory>[0]): Promise<H5World> {
  if (!bound) throw new Error('H5 world is not bound yet: WP-33/WP-34 bind it in test/h5/subject.ts');
  return bound(options);
}

/**
 * `it` for an H5 case. While its package is pending the case is `it.fails`: it runs and must fail,
 * so CI stays green and a case that starts passing early is noticed. Flipping the package in
 * `pending.ts` turns every case into a plain `it`.
 */
export function h5It(pkg: H5Package): typeof it {
  return (H5_PENDING[pkg] ? it.fails : it) as typeof it;
}
