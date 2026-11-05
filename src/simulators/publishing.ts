import type { Network } from '../contracts/common.js';
import {
  type ConnectionLink,
  CreateConnectionLinkRequest,
  type ConnectionStatus,
  ConnectionStatusRequest,
  DisconnectAccountRequest,
  type DisconnectAccountResult,
  MetricsRequest,
  type PostMetrics,
  type PublicationStatus,
  type PublishingProvider,
  PublishRequest,
  type PublishResult,
  TestScheduleRequest,
  type TestScheduleResult,
} from '../contracts/providers/publishing.js';
import { refill } from './persistent.js';

type Metrics = Omit<PostMetrics[number], 'providerPostId'>;

export interface SimulatedPost {
  providerPostId: string;
  request: PublishRequest;
  createdAt: string;
  /** Set when a scripted failure fails the post; otherwise it publishes at `scheduledFor`. */
  error?: string;
  metrics?: Metrics;
}

export interface ScriptedPublishFailure {
  /**
   * `reject`: the call throws and nothing is created.
   * `reject_after_create`: the post is created but the call throws (a lost response).
   * `fail_status`: the call succeeds and the post's status is `failed`.
   */
  mode: 'reject' | 'reject_after_create' | 'fail_status';
  error?: string;
}

interface PublishingState {
  posts: SimulatedPost[];
  connectionLinks: PublishingSimulator['connectionLinks'];
  accounts: Account[];
  pending: string[];
  failures: ScriptedPublishFailure[];
  testFailures: string[];
  scheduleTests: TestScheduleRequest[];
  disconnections: DisconnectAccountRequest[];
  disconnectFailures: string[];
  nextId: number;
}

interface Account {
  businessId: string;
  network: Network;
  providerAccountId: string;
  connected: boolean;
}

export interface PublishingSimulatorOptions {
  now?: () => Date;
}

/**
 * In-memory unified social API. Records every post per network (what the
 * networks would see). A post is `scheduled` until the clock passes its
 * `scheduledFor`, then `published`, unless a scripted failure fails it.
 */
export class PublishingSimulator implements PublishingProvider {
  readonly name = 'simulator';
  readonly posts: SimulatedPost[] = [];
  readonly connectionLinks: { request: CreateConnectionLinkRequest; link: ConnectionLink }[] = [];

  private readonly now: () => Date;
  private readonly accounts: Account[] = [];
  private readonly pending = new Set<string>();
  private readonly failures: ScriptedPublishFailure[] = [];
  private readonly testFailures: string[] = [];
  /** Every channel test the provider was asked for. */
  readonly scheduleTests: TestScheduleRequest[] = [];
  private nextId = 1;

  constructor(options: PublishingSimulatorOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** Everything the simulator holds, as JSON (simulated mode, src/simulators/persistent.ts). */
  exportState(): unknown {
    return {
      posts: this.posts,
      connectionLinks: this.connectionLinks,
      accounts: this.accounts,
      pending: [...this.pending],
      failures: this.failures,
      testFailures: this.testFailures,
      scheduleTests: this.scheduleTests,
      disconnections: this.disconnections,
      disconnectFailures: this.disconnectFailures,
      nextId: this.nextId,
    };
  }

  importState(state: unknown): void {
    const s = state as PublishingState;
    refill(this.posts, s.posts);
    refill(this.connectionLinks, s.connectionLinks);
    refill(this.accounts, s.accounts);
    this.pending.clear();
    for (const k of s.pending) this.pending.add(k);
    refill(this.failures, s.failures);
    refill(this.testFailures, s.testFailures);
    refill(this.scheduleTests, s.scheduleTests);
    refill(this.disconnections, s.disconnections);
    refill(this.disconnectFailures, s.disconnectFailures);
    this.nextId = s.nextId;
  }

  async createConnectionLink(request: CreateConnectionLinkRequest): Promise<ConnectionLink> {
    const parsed = CreateConnectionLinkRequest.parse(request);
    for (const network of parsed.networks) this.pending.add(key(parsed.businessId, network));
    const link = {
      url: `https://connect.simulator.test/link/${this.nextId++}`,
      expiresAt: new Date(this.now().getTime() + 24 * 60 * 60 * 1000).toISOString(),
    };
    this.connectionLinks.push({ request: parsed, link });
    return link;
  }

  async getConnectionStatus(request: ConnectionStatusRequest): Promise<ConnectionStatus> {
    const { businessId, network } = ConnectionStatusRequest.parse(request);
    const account = this.accounts.find((a) => a.businessId === businessId && a.network === network);
    if (account) {
      return { status: account.connected ? 'connected' : 'disconnected', providerAccountId: account.providerAccountId };
    }
    return { status: this.pending.has(key(businessId, network)) ? 'pending' : 'disconnected' };
  }

  async testSchedule(request: TestScheduleRequest): Promise<TestScheduleResult> {
    const parsed = TestScheduleRequest.parse(request);
    this.scheduleTests.push(parsed);
    const account = this.accounts.find((a) => a.providerAccountId === parsed.providerAccountId);
    if (!account?.connected || account.network !== parsed.network) {
      return { ok: false, error: `Account ${parsed.providerAccountId} is not connected on ${parsed.network}` };
    }
    const failure = this.testFailures.shift();
    return failure === undefined ? { ok: true } : { ok: false, error: failure };
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const parsed = PublishRequest.parse(request);
    const existing = this.posts.find((p) => p.request.idempotencyKey === parsed.idempotencyKey);
    if (existing) return { providerPostId: existing.providerPostId };

    const account = this.accounts.find((a) => a.providerAccountId === parsed.providerAccountId);
    if (!account?.connected || account.network !== parsed.network) {
      throw new Error(`Account ${parsed.providerAccountId} is not connected on ${parsed.network}`);
    }
    const failure = this.failures.shift();
    if (failure?.mode === 'reject') throw new Error(failure.error ?? 'Simulated publish failure');

    const post: SimulatedPost = {
      providerPostId: `post-sim-${this.nextId++}`,
      request: parsed,
      createdAt: this.now().toISOString(),
    };
    if (failure?.mode === 'fail_status') post.error = failure.error ?? 'Simulated publication failure';
    this.posts.push(post);
    if (failure?.mode === 'reject_after_create') throw new Error(failure.error ?? 'Simulated lost response');
    return { providerPostId: post.providerPostId };
  }

  async getPublicationStatus(providerPostId: string): Promise<PublicationStatus> {
    const post = this.posts.find((p) => p.providerPostId === providerPostId);
    if (!post) throw new Error(`Unknown provider post id: ${providerPostId}`);
    if (post.error !== undefined) return { status: 'failed', error: post.error };
    return this.isPublished(post) ? { status: 'published', publishedAt: post.request.scheduledFor } : { status: 'scheduled' };
  }

  async getMetrics(request: MetricsRequest): Promise<PostMetrics> {
    const { providerAccountId, from, to } = MetricsRequest.parse(request);
    const [start, end] = [Date.parse(from), Date.parse(to)];
    return this.posts
      .filter((p) => p.request.providerAccountId === providerAccountId && this.isPublished(p))
      .filter((p) => {
        const at = Date.parse(p.request.scheduledFor);
        return at >= start && at <= end;
      })
      .map((p) => ({ providerPostId: p.providerPostId, ...p.metrics }));
  }

  /** Every account Postly disconnected (cancellation, WP-43). */
  readonly disconnections: DisconnectAccountRequest[] = [];
  private readonly disconnectFailures: string[] = [];

  async disconnectAccount(request: DisconnectAccountRequest): Promise<DisconnectAccountResult> {
    const parsed = DisconnectAccountRequest.parse(request);
    const failure = this.disconnectFailures.shift();
    if (failure !== undefined) throw new Error(failure);
    this.disconnections.push(parsed);
    const account = this.accounts.find((a) => a.providerAccountId === parsed.providerAccountId);
    if (account) account.connected = false;
    return { disconnectedAt: this.now().toISOString() };
  }

  /** The next disconnectAccount call fails with this error. */
  failNextDisconnect(error = 'Simulated provider outage'): void {
    this.disconnectFailures.push(error);
  }

  /** The owner finishes the connection flow; returns the provider account id. */
  connect(businessId: string, network: Network, providerAccountId?: string): string {
    const existing = this.accounts.find((a) => a.businessId === businessId && a.network === network);
    if (existing) {
      existing.connected = true;
      return existing.providerAccountId;
    }
    const id = providerAccountId ?? `acc-sim-${network}-${this.nextId++}`;
    this.accounts.push({ businessId, network, providerAccountId: id, connected: true });
    this.pending.delete(key(businessId, network));
    return id;
  }

  /** The channel drops (expired token, revoked access). */
  disconnect(providerAccountId: string): void {
    const account = this.accounts.find((a) => a.providerAccountId === providerAccountId);
    if (!account) throw new Error(`Unknown provider account id: ${providerAccountId}`);
    account.connected = false;
  }

  /** The next publish call that reaches a connected account fails this way. */
  failNextPublish(failure: ScriptedPublishFailure): void {
    this.failures.push(failure);
  }

  /** The next channel test of a connected account fails with this error. */
  failNextTestSchedule(error = 'Simulated scheduling permission missing'): void {
    this.testFailures.push(error);
  }

  /** Fails a post that was already accepted. */
  failPost(providerPostId: string, error: string): void {
    this.post(providerPostId).error = error;
  }

  setMetrics(providerPostId: string, metrics: Metrics): void {
    this.post(providerPostId).metrics = metrics;
  }

  /** Every post the provider accepted for this network, scheduled or not. */
  postsOn(network: Network): SimulatedPost[] {
    return this.posts.filter((p) => p.request.network === network);
  }

  /** Posts live on this network now. */
  publishedOn(network: Network): SimulatedPost[] {
    return this.postsOn(network).filter((p) => p.error === undefined && this.isPublished(p));
  }

  private isPublished(post: SimulatedPost): boolean {
    return post.error === undefined && Date.parse(post.request.scheduledFor) <= this.now().getTime();
  }

  private post(providerPostId: string): SimulatedPost {
    const post = this.posts.find((p) => p.providerPostId === providerPostId);
    if (!post) throw new Error(`Unknown provider post id: ${providerPostId}`);
    return post;
  }
}

const key = (businessId: string, network: Network) => `${businessId}:${network}`;
