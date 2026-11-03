/**
 * The test world the human-owned H5 tests run against (gate H5, docs/implementation-plan.md).
 * WP-33 and WP-34 implement `H5WorldFactory` over the real modules and a real database and bind
 * it in `subject.ts`; they never edit the tests. The world holds only the services and the setup
 * steps, which go through the real code paths. Every observation the tests assert on, and every
 * forced state (pauses, handoff, forged rows), is fixed SQL owned by the tests in `db.ts`.
 */
import { it } from 'vitest';
import type { ApprovalService, PublishingJob } from '../../src/contracts/approval.js';
import type { Network } from '../../src/contracts/common.js';
import type { MessagingProvider, PublishingProvider } from '../../src/contracts/providers/index.js';
import type { DatabaseUrls } from '../../src/db/index.js';
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
  /** The owner or team cancels the post. */
  cancelPost(businessId: string, postId: string): Promise<void>;

  close(): Promise<void>;
}

export type H5WorldFactory = (options: {
  messaging: MessagingProvider;
  publishing: PublishingProvider;
  now: () => Date;
  /** The test database; the world opens its own connections. */
  databaseUrls: DatabaseUrls;
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
