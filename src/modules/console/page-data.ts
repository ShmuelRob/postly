import { z } from 'zod';
import type * as schema from '../../db/schema.js';
import { ConsoleActionError, type ConsoleService, type PlanPriceRow } from './console.js';
import { lastDays } from './insights.js';
import type {
  AgentConfigRow,
  BusinessDetail,
  BusinessRow,
  ConsoleActionRow,
  ModelRunRow,
  ModelRunSummary,
  Insights,
  ModelTaskRow,
  Overview,
  PostDetail,
  SystemSettings,
} from './views.js';

// What the console page needs for one request (technical-design.md, "Console (Phase 1)"): the query
// picks the tab and the selection, and only that tab's data is read.

/** In the order of the tab bar (technical-design.md, "Console (Phase 1)"). */
export const TABS = ['overview', 'insights', 'manage', 'businesses', 'conversations'] as const;
export type Tab = (typeof TABS)[number];

export const PageQuery = z.object({
  tab: z.enum(TABS).catch('overview'),
  business: z.uuid().optional().catch(undefined),
  run: z.uuid().optional().catch(undefined),
  panel: z.enum(['client', 'profile']).optional().catch(undefined),
  q: z.string().trim().max(100).optional().catch(undefined),
  kind: z.string().trim().max(60).optional().catch(undefined),
  /** Insights: a preset of the last 7, 30 or 90 days, or `from` and `to` (UTC days). */
  range: z.enum(['7d', '30d', '90d']).optional().catch(undefined),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
});
export type PageQuery = z.infer<typeof PageQuery>;

export type Item = typeof schema.consoleItem.$inferSelect;
export type Message = typeof schema.message.$inferSelect;
export type AgentTurn = typeof schema.agentTurn.$inferSelect;

export interface ConsolePageData {
  query: PageQuery;
  actor: string;
  overview: Overview;
  settings: SystemSettings;
  businesses: BusinessRow[];
  items: Item[];
  /** The Insights tab, for its range; `rangeError` when the chosen range was refused (the default is shown instead). */
  insights?: { data: Insights; rangeError?: string };
  /** The run view (`run=`); null when the id is unknown. */
  run?: ModelRunRow | null;
  manage?: {
    modelTasks: ModelTaskRow[];
    agentConfigs: AgentConfigRow[];
    price: { current: PlanPriceRow | null; history: PlanPriceRow[] };
    actions: ConsoleActionRow[];
    /** The profile editor (`business=` with `panel=profile`). */
    profile: BusinessDetail | null;
  };
  /** The selected conversation (`tab=conversations&business=`). */
  conversation?: {
    business: BusinessDetail;
    messages: Message[];
    posts: PostDetail[];
    turns: AgentTurn[];
    runs: ModelRunSummary[];
  } | null;
}

const orNull = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (error) {
    if (error instanceof ConsoleActionError && error.status === 404) return null;
    throw error;
  }
};

export async function loadPageData(c: ConsoleService, rawQuery: unknown, actor: string): Promise<ConsolePageData> {
  const query = PageQuery.parse(rawQuery ?? {});
  const [overview, settings, businesses, items] = await Promise.all([c.overview(), c.settings(), c.businessRows(), c.openItems()]);
  const data: ConsolePageData = { query, actor, overview, settings, businesses, items };

  if (query.run) {
    data.run = await orNull(c.modelRun(query.run));
    return data;
  }
  if (query.tab === 'insights') {
    const preset = { '7d': 7, '30d': 30, '90d': 90 }[query.range ?? '30d'];
    const chosen = query.from && query.to ? { from: query.from, to: query.to } : lastDays(preset);
    try {
      data.insights = { data: await c.insights(chosen) };
    } catch (error) {
      if (!(error instanceof ConsoleActionError)) throw error;
      data.insights = { data: await c.insights(lastDays(30)), rangeError: error.detail ?? error.reason };
    }
  }
  if (query.tab === 'manage') {
    const [modelTasks, agentConfigs, price, actions, profile] = await Promise.all([
      c.modelTasks(),
      c.agentConfigs(),
      c.price(),
      c.actions(undefined, 30),
      query.business && query.panel === 'profile' ? orNull(c.business(query.business)) : Promise.resolve(null),
    ]);
    data.manage = { modelTasks, agentConfigs, price, actions, profile };
  }
  if (query.tab === 'conversations' && query.business) {
    const id = query.business;
    const business = await orNull(c.business(id));
    if (!business) {
      data.conversation = null;
    } else {
      const [messages, posts, turns, runs] = await Promise.all([c.messages(id), c.posts(id), c.agentTurns(id), c.modelRuns(id, 30)]);
      data.conversation = { business, messages: messages.slice(-300), posts, turns: turns.slice(0, 15), runs };
    }
  }
  return data;
}
