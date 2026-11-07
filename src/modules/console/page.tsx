import { Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConsolePageData, Item, Message, PageQuery, Tab } from './page-data.js';
import { SCRIPT } from './page-script.js';
import { CSS } from './page-style.js';
import type { BusinessDetail, BusinessRow, FailureRow, ModelRunRow, ModelRunSummary, PostDetail } from './views.js';

// The console page, rendered on the server (technical-design.md, "Console (Phase 1)"): three tabs,
// Overview, Manage and Conversations, plus the model run view. Reads are plain links with query
// parameters; writes are buttons and forms that the inline script POSTs to the console API after a
// confirm dialog, so every write goes through the same routes as the tests. There is no control that
// approves a version or publishes: approval state is shown, never changed.

export type { ConsolePageData } from './page-data.js';

// ---------- tones and formatting ----------

type Tone = 'good' | 'info' | 'progress' | 'human' | 'warn' | 'bad' | 'neutral';

const TONE: Record<string, Tone> = {
  onboarding: 'info', active: 'good', paused: 'warn', cancelled: 'neutral', archived: 'neutral',
  planned: 'neutral', drafting: 'progress', awaiting_clarification: 'warn', awaiting_approval: 'info',
  needs_review: 'warn', approved: 'good', scheduled: 'info', publishing: 'progress', published: 'good',
  partially_published: 'warn', failed: 'bad',
  in_progress: 'progress', retry_pending: 'warn',
  model_validation_failed: 'bad', extraction_failed: 'bad', draft_failed: 'bad', publication_failed: 'bad',
  channel_disconnected: 'bad', payment_link_failed: 'bad', unknown_number: 'info', handoff: 'human', agent_limit: 'warn',
  open: 'warn', resolved: 'neutral',
  running: 'progress', done: 'good', waiting: 'info', handed_off: 'human',
  end_turn: 'good', waiting_for_owner: 'info', max_steps: 'warn', max_tool_calls: 'warn', turn_budget: 'warn',
  daily_budget: 'warn', global_budget: 'warn', timeout: 'warn', low_confidence: 'warn', refusals: 'warn',
  stuck: 'bad', invalid_output: 'bad',
  ok: 'good', run_failed: 'bad', fact_ok: 'good', fact_failed: 'bad', invalidated: 'neutral',
  verified: 'good', pending: 'info', disconnected: 'bad', revoked: 'neutral', past_due: 'warn', held: 'bad',
};
const toneOf = (v: string | null | undefined): Tone => (v ? (TONE[v] ?? 'neutral') : 'neutral');
const humanize = (v: string) => v.replaceAll('_', ' ');

const usd = (n: number | string | null | undefined) => {
  const v = Number(n ?? 0);
  return `$${v !== 0 && Math.abs(v) < 1 ? v.toFixed(4) : v.toFixed(2)}`;
};
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : '');
const time = (d: Date | string | null | undefined) => (d ? iso(d).replace('T', ' ').slice(0, 16) : '');
const short = (id: string) => id.slice(0, 8);
const api = (path: string) => `/console/api${path}`;
const media = (assetId: string) => `/console/media/${assetId}`;

function ago(d: Date | string | null | undefined, now: number): string {
  if (!d) return '';
  const m = Math.round((now - +new Date(d)) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

type Href = Partial<Record<keyof PageQuery, string | undefined>>;
const href = (q: Href) =>
  '/console?' + new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')).toString();

/** Run state from the row: ok when valid with no error. */
const runOk = (r: { valid: boolean; error: string | null }) => r.valid && !r.error;

// ---------- small components ----------

function Badge({ value, label, tone, strike }: { value: string; label?: string; tone?: Tone; strike?: boolean }) {
  return (
    <span className={strike ? 'badge strike' : 'badge'} data-tone={tone ?? toneOf(value)}>
      {label ?? humanize(value)}
    </span>
  );
}

function When({ d, now }: { d: Date | string | null | undefined; now: number }) {
  return d ? (
    <time dateTime={iso(d)} title={time(d)}>
      {ago(d, now)}
    </time>
  ) : null;
}

function Action(props: { path: string; label: string; tone?: 'primary' | 'danger' | 'good' | 'quiet'; body?: object; confirm?: string; detail?: string; size?: 'sm'; done?: string }) {
  return (
    <button
      type="button"
      className={['btn', props.tone, props.size].filter(Boolean).join(' ')}
      data-action={api(props.path)}
      data-body={props.body ? JSON.stringify(props.body) : undefined}
      data-confirm={props.confirm}
      data-detail={props.detail}
      data-done={props.done}
    >
      {props.label}
    </button>
  );
}

const Empty = ({ title, text }: { title: string; text?: string }) => (
  <div className="empty">
    <strong>{title}</strong>
    {text}
  </div>
);

let jsonCounter = 0;
function JsonBlock({ title, value, open, err }: { title: string; value: unknown; open?: boolean; err?: boolean }) {
  const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? 'null');
  const id = `j-${++jsonCounter}`;
  return (
    <details className={err ? 'json err' : 'json'} open={open}>
      <summary>
        {title}
        <span className="meta">{(text.length / 1024).toFixed(1)} KB</span>
      </summary>
      <div className="json-tools">
        <button type="button" className="btn sm quiet" data-copy={id}>
          Copy
        </button>
      </div>
      <pre id={id}>
        <code>{text}</code>
      </pre>
    </details>
  );
}

function Section({ title, meta, children, end, id }: { title: string; meta?: ReactNode; children: ReactNode; end?: ReactNode; id?: string }) {
  return (
    <section className="sect" id={id}>
      <div className="sect-h">
        <h2>{title}</h2>
        {meta !== undefined && <span className="meta">{meta}</span>}
        {end && <span className="end">{end}</span>}
      </div>
      {children}
    </section>
  );
}

// ---------- shell ----------

function TopBar({ data }: { data: ConsolePageData }) {
  const { overview, query } = data;
  const failures24h = data.overview.modelRuns24h.failed + overview.agentTurns24h.failed;
  const openItems = Object.values(overview.openItems).reduce((s, n) => s + n, 0);
  const withItems = data.businesses.filter((b) => b.openItems > 0).length;
  const tabs: Array<[Tab, string, number, Tone]> = [
    ['overview', 'Overview', failures24h, 'bad'],
    ['insights', 'Insights', 0, 'neutral'],
    ['manage', 'Manage', openItems, 'warn'],
    ['businesses', 'Businesses', 0, 'neutral'],
    ['conversations', 'Conversations', withItems, 'warn'],
  ];
  return (
    <header className="top">
      <div className="top-row">
        <a className="brand" href="/console">
          Postly <span>console</span>
        </a>
        <span className="pulse" data-tone={data.settings.publishingPaused ? 'bad' : 'good'}>
          {data.settings.publishingPaused ? 'Publishing paused' : 'Publishing on'}
        </span>
        <span className="actor" title={data.actor}>
          {`Signed in as ${data.actor}`}
        </span>
      </div>
      <nav className="tabs" aria-label="Sections">
        {tabs.map(([k, label, n, tone]) => (
          <a key={k} className="tab" data-testid={`tab-${k}`} href={href({ tab: k })} aria-current={query.tab === k && !query.run ? 'page' : undefined}>
            {label}
            {n > 0 && (
              <span className="n" data-tone={tone}>
                {n}
              </span>
            )}
          </a>
        ))}
      </nav>
    </header>
  );
}

function PauseBanner({ data }: { data: ConsolePageData }) {
  const s = data.settings;
  if (!s.publishingPaused) return null;
  return (
    <div className="banner" data-tone="bad" role="status">
      <strong>Publishing is paused for all businesses</strong>
      <span className="facts">
        {s.pausedBy && <span>by {s.pausedBy}</span>}
        <span>{time(s.pausedAt)}</span>
        {s.pausedReason && <span dir="auto">{s.pausedReason}</span>}
      </span>
      <Action path="/system/resume" label="Resume publishing" tone="good" confirm="Resume publishing for all businesses?" done="Publishing resumed" />
    </div>
  );
}

// ---------- overview ----------

function barPath(x: number, base: number, w: number, h: number) {
  const r = Math.min(3, w / 2, h);
  const y = base - h;
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

/** One series of daily values as bars (dataviz: one hue, no legend, the title names it; values on hover and in a table). */
function DayBars({ title, meta, days, format, testId, lastLabel = 'Today' }: { title: string; meta?: string; days: Array<{ day: string; value: number }>; format: (v: number) => string; testId?: string; lastLabel?: string }) {
  const W = 280, H = 76, top = 14, base = H - 1, gap = days.length > 40 ? 1 : days.length > 20 ? 2 : 4, n = Math.max(days.length, 1);
  const bw = Math.max((W - gap * (n - 1)) / n, 0.5);
  const max = Math.max(...days.map((d) => d.value), 1e-6);
  const total = days.reduce((s, d) => s + d.value, 0);
  return (
    <figure className="box chart" data-testid={testId}>
      <figcaption className="chart-h">
        <h3>{title}</h3>
        {meta && <span className="meta">{meta}</span>}
      </figcaption>
      <svg className="spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${days.length} days, total ${format(total)}, highest ${format(max > 1e-6 ? max : 0)}`}>
        {days.map((d, i) => {
          const x = i * (bw + gap);
          const h = d.value > 0 ? Math.max(2, (d.value / max) * (base - top)) : 0;
          const tx = Math.min(Math.max(x + bw / 2, 16), W - 16);
          return (
            <g key={d.day} className={i === n - 1 ? 'g last' : 'g'} tabIndex={0}>
              <title>{`${d.day}: ${format(d.value)}`}</title>
              <rect className="hit" x={x - gap / 2} y={0} width={bw + gap} height={H} />
              {h > 0 ? <path className="bar" d={barPath(x, base, bw, h)} /> : <rect className="bar zero" x={x} y={base - 1} width={bw} height={1} />}
              <text className="tip" x={tx} y={Math.max(base - h - 4, 9)} textAnchor="middle">
                {format(d.value)}
              </text>
            </g>
          );
        })}
        <line className="base" x1={0} x2={W} y1={base + 0.5} y2={base + 0.5} />
      </svg>
      <div className="chart-axis">
        <span>{days[0]?.day.slice(5)}</span>
        <span>{lastLabel}</span>
      </div>
      <details className="chart-table">
        <summary>Show values</summary>
        <table>
          <tbody>
            {days.map((d) => (
              <tr key={d.day}>
                <td>{d.day}</td>
                <td>{format(d.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function CostBars({ days }: { days: Array<{ day: string; usd: number }> }) {
  const total = days.reduce((s, d) => s + d.usd, 0);
  return <DayBars title="Model cost per day" meta={`Last 14 days, ${usd(total)} total`} days={days.map((d) => ({ day: d.day, value: d.usd }))} format={usd} testId="cost-chart" />;
}

function StatTile({ label, value, unit, tone, sub, children, link, testId }: { label: string; value: ReactNode; unit?: string; tone?: Tone | undefined; sub?: ReactNode; children?: ReactNode; link?: string; testId?: string }) {
  const body = (
    <>
      <span className="tile-l">{label}</span>
      <span className="tile-v">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      {sub && <span className="tile-s">{sub}</span>}
      {children}
    </>
  );
  return link ? (
    <a className="tile" data-tone={tone} href={link} data-testid={testId}>
      {body}
    </a>
  ) : (
    <div className="tile" data-tone={tone} data-testid={testId}>
      {body}
    </div>
  );
}

function OverviewTab({ data, names, now }: { data: ConsolePageData; names: Map<string, string>; now: number }) {
  const o = data.overview;
  const statuses = Object.entries(o.businesses).map(([k, n]) => ({ k, n }));
  const totalBusinesses = statuses.reduce((s, x) => s + x.n, 0);
  const kinds = Object.entries(o.openItems).sort((a, b) => b[1] - a[1]);
  const openTotal = kinds.reduce((s, [, n]) => s + n, 0);
  return (
    <div className="stack" data-testid="overview">
      <div className="page-h">
        <h1>Overview</h1>
        <span className="muted">Health of every business at a glance</span>
      </div>
      <section className="tiles" aria-label="Health">
        <StatTile label="Businesses" value={totalBusinesses} link={href({ tab: 'conversations' })} testId="tile-businesses">
          {statuses.length > 0 && (
            <>
              <div className="ratio" aria-hidden="true">
                {statuses.map((s) => (
                  <i key={s.k} data-tone={toneOf(s.k)} style={{ flex: s.n }} />
                ))}
              </div>
              <ul className="mini">
                {statuses.map((s) => (
                  <li key={s.k} data-tone={toneOf(s.k)}>
                    {humanize(s.k)} <b>{s.n}</b>
                  </li>
                ))}
              </ul>
            </>
          )}
        </StatTile>
        <StatTile
          label="Open review items"
          value={openTotal}
          tone={openTotal > 0 ? 'warn' : undefined}
          link={href({ tab: 'manage' }) + '#review-queue'}
          sub={kinds.length ? kinds.slice(0, 3).map(([k, n]) => `${humanize(k)} ${n}`).join(', ') : 'Nothing waiting'}
          testId="tile-items"
        />
        <StatTile
          label="Agent turns, 24h"
          value={o.agentTurns24h.count}
          tone={o.agentTurns24h.failed > 0 ? 'bad' : undefined}
          sub={`${o.agentTurns24h.handedOff} handed off, ${o.agentTurns24h.failed} failed, ${usd(o.agentTurns24h.costUsd)}`}
          testId="tile-turns"
        />
        <StatTile
          label="Model runs, 24h"
          value={o.modelRuns24h.count}
          tone={o.modelRuns24h.failed > 0 ? 'bad' : undefined}
          sub={`${usd(o.modelRuns24h.costUsd)}, ${o.modelRuns24h.failed} failed`}
          testId="tile-runs"
        />
        <StatTile label="Published, 7 days" value={o.publications.published7d} sub={`${o.publications.scheduled} scheduled`} testId="tile-posts" />
        <StatTile
          label="Failed publications"
          value={o.publications.failed}
          tone={o.publications.failed > 0 ? 'bad' : undefined}
          sub={o.publications.failed > 0 ? 'Retry from the post in Conversations' : 'None'}
          testId="tile-pub-failed"
        />
      </section>
      <div className="grid-ov">
        <CostBars days={o.costByDay} />
        <section>
          <div className="sect-h">
            <h2>Recent failures</h2>
            <span className="meta">newest first</span>
          </div>
          <div className="box">
            {o.recentFailures.length === 0 ? (
              <Empty title="No failures" text="Failed model runs and publications show here." />
            ) : (
              <ul className="feed" data-testid="recent-failures">
                {o.recentFailures.map((f) => (
                  <FailureItem key={`${f.kind}-${f.id}`} f={f} names={names} now={now} />
                ))}
              </ul>
            )}
          </div>
        </section>
        <section className="span-2">
          <div className="sect-h">
            <h2>Recent agent turns</h2>
          </div>
          <div className="box">
            {o.recentTurns.length === 0 ? (
              <Empty title="No agent turns yet" />
            ) : (
              <ul className="feed">
                {o.recentTurns.map((t) => (
                  <li key={t.id} data-tone={['failed', 'handed_off'].includes(t.status) ? toneOf(t.status) : undefined}>
                    <span className="title">
                      <a dir="auto" href={href({ tab: 'conversations', business: t.businessId })}>
                        {names.get(t.businessId) ?? short(t.businessId)}
                      </a>
                      <Badge value={t.agent} tone="neutral" />
                      <Badge value={t.stopReason ?? t.status} />
                    </span>
                    <span className="when">
                      <When d={t.startedAt} now={now} />
                    </span>
                    <span className="facts">
                      <span>
                        <b>{t.stepCount}</b> steps
                      </span>
                      <span>{usd(t.costUsd)}</span>
                      {t.durationMs !== null && <span>{t.durationMs} ms</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function FailureItem({ f, names, now }: { f: FailureRow; names: Map<string, string>; now: number }) {
  return (
    <li data-tone="bad">
      <span className="title">
        <Badge value={f.kind === 'model_run' ? 'run_failed' : 'failed'} label={f.kind === 'model_run' ? humanize(f.label) : `${f.label} publication`} />
        {f.businessId && (
          <a dir="auto" href={href({ tab: 'conversations', business: f.businessId })}>
            {names.get(f.businessId) ?? short(f.businessId)}
          </a>
        )}
        {f.kind === 'model_run' && <a href={href({ tab: 'overview', run: f.id })}>Run details</a>}
      </span>
      <span className="when">
        <When d={f.at} now={now} />
      </span>
      {f.error && <span className="err">{f.error}</span>}
    </li>
  );
}

// ---------- manage ----------

const RUN_KINDS = new Set(['model_validation_failed', 'extraction_failed', 'draft_failed']);

function ItemDetails({ details }: { details: unknown }) {
  if (!details || typeof details !== 'object') return null;
  const entries = Object.entries(details as Record<string, unknown>);
  if (entries.length === 0) return null;
  const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  return (
    <>
      <span className="facts">
        {entries.slice(0, 4).map(([k, v]) => (
          <span key={k}>
            {humanize(k)}: <b dir="auto">{text(v).slice(0, 120)}</b>
          </span>
        ))}
      </span>
      {entries.length > 4 && <JsonBlock title="All details" value={details} />}
    </>
  );
}

function matches(text: string, q: string | undefined) {
  return !q || text.toLowerCase().includes(q.toLowerCase());
}

function ReviewQueue({ items, names, query, now, compact }: { items: Item[]; names: Map<string, string>; query: PageQuery; now: number; compact?: boolean }) {
  return (
    <div className="box">
      {items.length === 0 ? (
        <Empty title="Nothing waiting" text="New review items appear here when a run fails or an owner needs a person." />
      ) : (
        <table className="tbl cards">
          <thead>
            <tr>
              <th>Kind</th>
              {!compact && <th>Business</th>}
              <th>Details</th>
              <th>Opened</th>
              <th className="r">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} data-tone={toneOf(i.kind)} data-testid="review-item">
                <td className="primary">
                  <Badge value={i.kind} />
                </td>
                {!compact && (
                  <td data-label="Business">
                    {i.businessId ? (
                      <a dir="auto" data-testid="item-conversation" href={href({ tab: 'conversations', business: i.businessId })}>
                        {names.get(i.businessId) ?? short(i.businessId)}
                      </a>
                    ) : (
                      <span className="muted">Unknown number</span>
                    )}
                  </td>
                )}
                <td className="wide detail" data-label="Details">
                  <ItemDetails details={i.details} />
                  {i.referenceId && RUN_KINDS.has(i.kind) && (
                    <>
                      {' '}
                      <a data-testid="item-run" href={href({ ...query, run: i.referenceId })}>
                        Model run
                      </a>
                    </>
                  )}
                </td>
                <td data-label="Opened" className="nowrap">
                  <When d={i.createdAt} now={now} />
                </td>
                <td className="actions">
                  <div className="actions">
                    {i.businessId && <Action size="sm" path={`/items/${i.id}/route`} label="Route to a person" confirm="Hand this business to a person and resolve the item?" done="Routed to a person" />}
                    <Action size="sm" tone="good" path={`/items/${i.id}/resolve`} label="Resolve" confirm="Mark this item resolved?" done="Resolved" />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function BusinessesTable({ businesses, now }: { businesses: BusinessRow[]; now: number }) {
  return (
    <div className="box">
      {businesses.length === 0 ? (
        <Empty title="No businesses yet" />
      ) : (
        <table className="tbl cards" data-testid="businesses">
          <thead>
            <tr>
              <th>Business</th>
              <th>Status</th>
              <th>Step</th>
              <th>Last message</th>
              <th>Joined</th>
              <th className="r">Published</th>
              <th className="r">Model cost</th>
              <th className="r">Actions</th>
            </tr>
          </thead>
          <tbody>
            {businesses.map((b) => (
              <tr key={b.id} data-tone={b.handoffAt ? 'human' : b.status === 'paused' ? 'warn' : undefined}>
                <td className="primary name">
                  <a dir="auto" href={href({ tab: 'conversations', business: b.id })}>
                    {b.name}
                  </a>
                  {b.openItems > 0 && (
                    <>
                      {' '}
                      <span className="count" data-tone="warn" title="Open review items">
                        {b.openItems}
                      </span>
                    </>
                  )}
                </td>
                <td data-label="Status">
                  <Badge value={b.status} />
                  {b.handoffAt && <Badge value="handoff" label="person" />}
                </td>
                <td data-label="Step">{b.step ? humanize(b.step) : <span className="muted">none</span>}</td>
                <td data-label="Last message" className="nowrap">
                  <When d={b.lastMessage?.createdAt} now={now} />
                </td>
                <td data-label="Joined" className="nowrap">
                  {time(b.createdAt).slice(0, 10)}
                </td>
                <td data-label="Published" className="r">
                  {b.published}
                </td>
                <td data-label="Model cost" className="r">
                  {usd(b.spendUsd)}
                </td>
                <td className="actions">
                  <BusinessActions b={b} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function BusinessActions({ b, withProfile = true }: { b: BusinessRow; withProfile?: boolean }) {
  return (
    <div className="actions">
      {withProfile && (
        <a className="btn sm" href={href({ tab: 'manage', business: b.id, panel: 'profile' })}>
          Profile
        </a>
      )}
      {b.handoffAt ? (
        <Action size="sm" tone="good" path={`/businesses/${b.id}/handoff/clear`} label="Return to agent" confirm="Give this conversation back to the agent?" done="Returned to the agent" />
      ) : (
        <Action size="sm" path={`/businesses/${b.id}/handoff`} label="Take over" confirm="Take this conversation over? The agent stops replying until you return it." done="You have the conversation" />
      )}
      {b.status === 'active' && <Action size="sm" tone="danger" path={`/businesses/${b.id}/pause`} label="Pause" confirm="Pause this business? Nothing publishes for it until it resumes." done="Business paused" />}
      {b.status === 'paused' && <Action size="sm" tone="good" path={`/businesses/${b.id}/resume`} label="Resume" confirm="Resume this business?" done="Business resumed" />}
    </div>
  );
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

function ProfileEditor({ b }: { b: BusinessDetail }) {
  const profile = sortKeys(b.profile ?? {});
  return (
    <section className="box box-pad sect" id="profile">
      <div className="sect-h">
        <h2 dir="auto">{b.name}</h2>
        <span className="meta">profile</span>
        <span className="end">
          <a href={href({ tab: 'conversations', business: b.id })}>Conversation</a>
          <a href={href({ tab: 'manage' })}>Close</a>
        </span>
      </div>
      <form data-testid="profile-form" data-api={api(`/businesses/${b.id}/profile`)} data-confirm="Save the profile?" data-done="Profile saved">
        <label className="field">
          <span>Profile JSON</span>
          <textarea className="in" name="profile" data-type="json" spellCheck={false} dir="ltr" data-original={JSON.stringify(profile)} defaultValue={JSON.stringify(profile, null, 2)} />
          <span className="hint">
            Checked on the server against the business profile schema ({b.status === 'onboarding' ? 'a draft while the business onboards' : 'the full profile'}). The approver number cannot change here: it changes only with the owner. The owner gets no message about this edit.
          </span>
        </label>
        <div className="form-errors" />
        <div className="form-foot">
          <label className="field">
            <span>Reason (optional)</span>
            <input className="in" name="reason" maxLength={500} />
          </label>
          <button className="btn primary" type="submit">
            Save profile
          </button>
        </div>
      </form>
    </section>
  );
}

function GlobalControls({ data }: { data: ConsolePageData }) {
  const s = data.settings;
  return (
    <Section title="Global controls">
      <div className="box">
        <div className="ctl">
          <div className="ctl-l">
            <b>Publishing</b>
            <span>{s.publishingPaused ? `Paused by ${s.pausedBy ?? 'unknown'} ${time(s.pausedAt)}` : 'Running for every business'}</span>
          </div>
          {s.publishingPaused ? (
            <Action path="/system/resume" label="Resume all" tone="good" confirm="Resume publishing for all businesses?" done="Publishing resumed" />
          ) : (
            <Action path="/system/pause" label="Pause all" tone="danger" body={{ reason: 'paused from the console' }} confirm="Pause publishing for all businesses?" detail="Use for security events and days of mourning. Nothing publishes until someone resumes it." done="Publishing paused" />
          )}
        </div>
        <form className="ctl" data-testid="cost-cap-form" data-api={api('/system/agent-cost-cap')} data-confirm="Change the agent daily cost cap?" data-done="Cost cap saved">
          <label className="ctl-l field">
            <b>Agent daily cost cap</b>
            <span>US dollars a day across every business; turns stop with a hand-off past it</span>
          </label>
          <input className="in cell" style={{ maxWidth: 120 }} name="usd" type="number" step="0.01" min="0.01" data-type="number" defaultValue={s.agentDailyCostCapUsd} aria-label="Daily cap in USD" />
          <button className="btn sm" type="submit">
            Save
          </button>
        </form>
      </div>
    </Section>
  );
}

const ils = (agorot: number) => `${agorot % 100 === 0 ? agorot / 100 : (agorot / 100).toFixed(2)} ILS`;

function PriceBox({ price, now }: { price: NonNullable<ConsolePageData['manage']>['price']; now: number }) {
  return (
    <Section title="Monthly price" meta={price.current ? `${ils(price.current.amountAgorot)} (${price.current.plan})` : 'not set'}>
      <div className="box">
        <form className="ctl" data-testid="price-form" data-api={api('/price')} data-confirm="Change the monthly price? Payment links sent afterwards charge it." data-done="Price saved">
          <label className="ctl-l field">
            <b>New price in ILS</b>
            <span>Applies to payment links sent after the change</span>
          </label>
          <input className="in cell" style={{ maxWidth: 120 }} name="amountAgorot" type="number" min="1" step="0.01" data-type="number" data-scale="100" required aria-label="Price in ILS" />
          <button className="btn sm" type="submit">
            Change
          </button>
        </form>
        <ul className="feed">
          {price.history.slice(0, 5).map((h) => (
            <li key={h.id}>
              <span className="title">{ils(h.amountAgorot)}</span>
              <span className="when">
                <When d={h.createdAt} now={now} />
              </span>
              <span className="facts">
                <span>{h.changedBy}</span>
                {h.reason && <span dir="auto">{h.reason}</span>}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

const AGENT_FIELDS = [
  ['maxSteps', 'Steps', '1'],
  ['maxToolCalls', 'Tool calls', '1'],
  ['maxTurnCostUsd', 'Turn USD', '0.001'],
  ['maxBusinessDailyCostUsd', 'Business/day USD', '0.01'],
  ['timeoutMs', 'Timeout ms', '1000'],
  ['minConfidence', 'Min confidence', '0.05'],
  ['maxRefusals', 'Refusals', '1'],
  ['maxRepeatedQuestions', 'Repeats', '1'],
] as const;

function AgentLimits({ rows, now }: { rows: NonNullable<ConsolePageData['manage']>['agentConfigs']; now: number }) {
  return (
    <Section title="Agent limits" meta="a turn past any limit ends with a hand-off">
      <div className="box tbl-scroll">
        <table className="tbl cards" data-testid="agent-config">
          <thead>
            <tr>
              <th>Agent</th>
              {AGENT_FIELDS.map(([, label]) => (
                <th key={label}>{label}</th>
              ))}
              <th>Updated</th>
              <th className="r" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const form = `ac-${r.agent}`;
              return (
                <tr key={r.agent}>
                  <td className="primary">
                    <b>{humanize(r.agent)}</b>
                  </td>
                  {AGENT_FIELDS.map(([name, label, step]) => (
                    <td key={name} data-label={label}>
                      <input className="in cell" form={form} name={name} type="number" step={step} min="0" data-type="number" defaultValue={r[name]} aria-label={`${r.agent} ${label}`} />
                    </td>
                  ))}
                  <td data-label="Updated" className="nowrap">
                    <When d={r.updatedAt} now={now} />
                  </td>
                  <td className="actions">
                    <form id={form} className="actions" data-testid="agent-config-form" data-agent={r.agent} data-api={api(`/agent-config/${r.agent}`)} data-confirm={`Save the ${r.agent} agent's limits?`} data-done="Limits saved">
                      <button className="btn sm" type="submit">
                        Save
                      </button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function ModelTasks({ rows, now }: { rows: NonNullable<ConsolePageData['manage']>['modelTasks']; now: number }) {
  return (
    <Section title="Model tasks" meta="the provider is fixed; a prompt version change switches a customer-facing prompt (H7)" id="model-tasks">
      <div className="box tbl-scroll">
        <table className="tbl cards" data-testid="model-tasks">
          <thead>
            <tr>
              <th>Task</th>
              <th>Provider</th>
              <th>Model</th>
              <th>Fallback model</th>
              <th>Temp</th>
              <th>Max USD</th>
              <th>Retries</th>
              <th>Prompt</th>
              <th>Updated</th>
              <th className="r" />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const form = `mt-${c.task}`;
              return (
                <tr key={c.task}>
                  <td className="primary">
                    <b>{humanize(c.task)}</b>
                  </td>
                  <td data-label="Provider">{c.provider}</td>
                  <td data-label="Model">
                    <input className="in cell" form={form} name="model" defaultValue={c.model} aria-label={`${c.task} model`} />
                  </td>
                  <td data-label="Fallback model">
                    <input className="in cell" form={form} name="fallbackModel" defaultValue={c.fallbackModel ?? ''} aria-label={`${c.task} fallback model`} />
                  </td>
                  <td data-label="Temp">
                    <input className="in cell" form={form} name="temperature" type="number" step="0.05" min="0" max="2" data-type="number" defaultValue={c.temperature} aria-label={`${c.task} temperature`} />
                  </td>
                  <td data-label="Max USD">
                    <input className="in cell" form={form} name="maxCostUsd" type="number" step="0.001" min="0" data-type="number" defaultValue={c.maxCostUsd} aria-label={`${c.task} max cost`} />
                  </td>
                  <td data-label="Retries">
                    <input className="in cell" form={form} name="maxRetries" type="number" min="0" max="5" data-type="number" defaultValue={c.maxRetries} aria-label={`${c.task} retries`} />
                  </td>
                  <td data-label="Prompt">
                    <select className="in cell" form={form} name="activePromptVersion" data-type="number" defaultValue={String(c.activePromptVersion)} aria-label={`${c.task} prompt version`}>
                      {(c.promptVersions.length ? c.promptVersions : [c.activePromptVersion]).map((v) => (
                        <option key={v} value={v}>
                          v{v}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td data-label="Updated" className="nowrap">
                    <When d={c.updatedAt} now={now} />
                  </td>
                  <td className="actions">
                    <form id={form} className="actions" data-api={api(`/model-tasks/${c.task}`)} data-confirm={`Save the settings of ${humanize(c.task)}?`} data-done="Model task saved">
                      <button className="btn sm" type="submit">
                        Save
                      </button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function ActionLog({ rows, names, now }: { rows: NonNullable<ConsolePageData['manage']>['actions']; names: Map<string, string>; now: number }) {
  return (
    <Section title="Action log" meta="configuration and profile changes, newest first">
      <div className="box">
        {rows.length === 0 ? (
          <Empty title="No changes yet" />
        ) : (
          <ul className="feed" data-testid="action-log">
            {rows.map((a) => (
              <li key={a.id}>
                <span className="title">
                  <Badge value={a.action} tone="neutral" />
                  <span dir="auto">{a.businessId ? (names.get(a.businessId) ?? short(a.businessId)) : humanize(a.target)}</span>
                </span>
                <span className="when">
                  <When d={a.createdAt} now={now} />
                </span>
                <span className="facts">
                  <span>{a.actor}</span>
                  {a.reason && <span dir="auto">{a.reason}</span>}
                </span>
                <div className="facts">
                  <JsonBlock title="Change" value={{ before: a.before, after: a.after }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

function ManageTab({ data, names, now }: { data: ConsolePageData; names: Map<string, string>; now: number }) {
  const m = data.manage!;
  const { query } = data;
  const kinds = [...new Set(data.items.map((i) => i.kind))].sort();
  const items = data.items.filter(
    (i) => (!query.kind || i.kind === query.kind) && matches(`${i.businessId ? (names.get(i.businessId) ?? '') : ''} ${JSON.stringify(i.details)}`, query.q),
  );
  return (
    <div data-testid="manage">
      <div className="page-h">
        <h1>Manage</h1>
        <span className="muted">Every change is recorded as {data.actor}. Approval and publishing stay with the owner.</span>
      </div>
      <div className="grid-mg">
        <div>
          {query.business && query.panel === 'profile' && (m.profile ? <ProfileEditor b={m.profile} /> : <Empty title="Business not found" />)}
          <Section title="Review queue" meta={`${items.length} open`} id="review-queue">
            <div data-testid="review-queue">
            <form className="list-h box" method="get" action="/console" style={{ marginBottom: 8 }}>
              <input type="hidden" name="tab" value="manage" />
              <label className="search">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-4-4" />
                </svg>
                <span className="sr">Search review items</span>
                <input className="in" type="search" name="q" defaultValue={query.q} placeholder="Search business or details" />
              </label>
              <nav className="chips" aria-label="Filter by kind">
                <a className="chip" aria-current={!query.kind ? 'true' : undefined} href={href({ tab: 'manage', q: query.q })}>
                  all <span className="n">{data.items.length}</span>
                </a>
                {kinds.map((k) => (
                  <a key={k} className="chip" aria-current={query.kind === k ? 'true' : undefined} href={href({ tab: 'manage', q: query.q, kind: k })}>
                    {humanize(k)} <span className="n">{data.items.filter((i) => i.kind === k).length}</span>
                  </a>
                ))}
              </nav>
            </form>
            <ReviewQueue items={items} names={names} query={query} now={now} />
            </div>
          </Section>
        </div>
        <div>
          <GlobalControls data={data} />
          <PriceBox price={m.price} now={now} />
          <ActionLog rows={m.actions} names={names} now={now} />
        </div>
        <div className="span-2">
          <AgentLimits rows={m.agentConfigs} now={now} />
          <ModelTasks rows={m.modelTasks} now={now} />
        </div>
      </div>
    </div>
  );
}

// ---------- businesses ----------

function BusinessesTab({ data, now }: { data: ConsolePageData; now: number }) {
  const { query } = data;
  const list = data.businesses.filter((b) => listFilter(b, query.kind) && matches(b.name, query.q));
  const countOf = (k: string) => data.businesses.filter((b) => listFilter(b, k)).length;
  return (
    <div data-testid="businesses-tab">
      <div className="page-h">
        <h1>Businesses</h1>
        <span className="muted">{data.businesses.length} in all. Open one to see its conversation and client panel.</span>
      </div>
      <form className="list-h box" method="get" action="/console" style={{ marginBottom: 8 }}>
        <input type="hidden" name="tab" value="businesses" />
        {query.kind && <input type="hidden" name="kind" value={query.kind} />}
        <label className="search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-4-4" />
          </svg>
          <span className="sr">Search businesses</span>
          <input className="in" type="search" name="q" defaultValue={query.q} placeholder="Search by name" />
        </label>
        <nav className="chips" aria-label="Filter businesses">
          {LIST_FILTERS.filter((k) => k === 'all' || countOf(k) > 0).map((k) => (
            <a key={k} className="chip" aria-current={(query.kind ?? 'all') === k ? 'true' : undefined} href={href({ tab: 'businesses', q: query.q, kind: k === 'all' ? undefined : k })}>
              {humanize(k)} <span className="n">{countOf(k)}</span>
            </a>
          ))}
        </nav>
      </form>
      {list.length === 0 && data.businesses.length > 0 ? (
        <div className="box">
          <Empty title="No businesses match" text="Clear the search or pick another filter." />
        </div>
      ) : (
        <BusinessesTable businesses={list} now={now} />
      )}
    </div>
  );
}

// ---------- insights ----------

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
const pct = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);
const num = (v: number) => v.toLocaleString('en-US');
function duration(minutes: number | null): string {
  if (minutes === null) return 'n/a';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / 1440).toFixed(1)} d`;
}

/** Horizontal bars, one row per category: one hue, or the row's status tone when the rows are states. */
function HBars({ rows, testId }: { rows: Array<{ label: string; n: number; tone?: Tone; href?: string }>; testId?: string }) {
  const max = Math.max(...rows.map((r) => r.n), 1);
  const total = rows.reduce((s, r) => s + r.n, 0);
  return (
    <ul className="hbars" data-testid={testId}>
      {rows.map((r) => (
        <li key={r.label} className="hbar" data-tone={r.tone}>
          <span className="lbl">{r.href ? <a href={r.href}>{r.label}</a> : r.label}</span>
          <span className="track" title={`${r.label}: ${r.n}${total ? ` (${Math.round((r.n / total) * 100)}%)` : ''}`}>
            <i className={r.n === 0 ? 'fill zero' : 'fill'} style={{ width: `${(r.n / max) * 100}%` }} />
          </span>
          <span className="v">{num(r.n)}</span>
        </li>
      ))}
    </ul>
  );
}

function RangeForm({ data }: { data: ConsolePageData }) {
  const { query } = data;
  const insights = data.insights!;
  const custom = Boolean(query.from && query.to) && !insights.rangeError;
  const preset = custom ? undefined : (query.range ?? '30d');
  return (
    <form className="range box" method="get" action="/console" data-testid="insights-range">
      <input type="hidden" name="tab" value="insights" />
      <nav className="chips" aria-label="Date range">
        {(['7d', '30d', '90d'] as const).map((r) => (
          <a key={r} className="chip" aria-current={preset === r ? 'true' : undefined} href={href({ tab: 'insights', range: r })}>
            Last {r.replace('d', ' days')}
          </a>
        ))}
      </nav>
      <label className="field">
        <span>From</span>
        <input className="in cell" type="date" name="from" defaultValue={insights.data.range.from} required />
      </label>
      <label className="field">
        <span>To</span>
        <input className="in cell" type="date" name="to" defaultValue={insights.data.range.to} required />
      </label>
      <button className="btn sm" type="submit">
        Apply
      </button>
      {insights.rangeError && (
        <span className="form-errors" role="alert">
          That range was refused ({insights.rangeError}); showing the last 30 days.
        </span>
      )}
    </form>
  );
}

type WeeklyKey = 'done' | 'reminded' | 'awaiting' | 'skipped' | 'noRow';
const WEEKLY_ROWS: Array<[WeeklyKey, string, Tone]> = [
  ['done', 'Sent their update', 'good'],
  ['reminded', 'Reminded, no reply yet', 'warn'],
  ['awaiting', 'Not reminded yet', 'info'],
  ['skipped', 'Skipped the week', 'neutral'],
  ['noRow', 'No week started', 'neutral'],
];

function InsightsTab({ data }: { data: ConsolePageData }) {
  const i = data.insights!.data;
  const span = `${i.range.from} to ${i.range.to}, ${days(i.range.days)}`;
  return (
    <div className="stack" data-testid="insights">
      <div className="page-h">
        <h1>Insights</h1>
        <span className="muted">Across every business. Days are UTC; the funnel, statuses and the weekly update are as of now.</span>
      </div>
      <RangeForm data={data} />
      <section className="tiles" aria-label={`Totals, ${span}`}>
        <StatTile label="New businesses" value={num(i.newBusinesses.total)} sub={`in ${days(i.range.days)}`} testId="insights-tile-new" />
        <StatTile label="Messages" value={num(i.messages.inbound + i.messages.outbound)} sub={`${num(i.messages.inbound)} from owners, ${num(i.messages.outbound)} sent; ${i.messages.businessesWriting} businesses wrote`} />
        <StatTile label="Posts published" value={num(i.posts.published)} sub={`${num(i.posts.drafted)} drafted, ${num(i.posts.approved)} approved`} />
        <StatTile label="Approval rate" value={pct(i.approval.rate)} sub={`${i.approval.approved} of ${i.approval.versioned} drafts; median ${duration(i.approval.medianMinutes)}, p90 ${duration(i.approval.p90Minutes)}`} />
        <StatTile label="Agent hand-offs" value={num(i.agent.handedOff)} tone={i.agent.handOffRate !== null && i.agent.handOffRate > 0.2 ? 'warn' : undefined} sub={`${pct(i.agent.handOffRate)} of ${num(i.agent.turns)} turns`} />
        <StatTile label="Model cost" value={usd(i.cost.totalUsd)} sub={i.cost.perBusinessUsd === null ? 'No spend' : `${usd(i.cost.perBusinessUsd)} per business that spent`} />
      </section>
      <div className="grid-ov">
        <DayBars title="New businesses per day" meta={`${num(i.newBusinesses.total)} in ${days(i.range.days)}`} days={i.newBusinesses.perDay.map((d) => ({ day: d.day, value: d.n }))} format={num} testId="insights-new-businesses" lastLabel={i.range.to.slice(5)} />
        <DayBars title="Model cost per day" meta={`${usd(i.cost.totalUsd)} in ${days(i.range.days)}`} days={i.cost.perDay.map((d) => ({ day: d.day, value: d.usd }))} format={usd} testId="insights-cost" lastLabel={i.range.to.slice(5)} />
        <section>
          <div className="sect-h">
            <h2>Onboarding funnel</h2>
            <span className="meta">onboarding businesses by step, now</span>
          </div>
          <div className="box" data-testid="insights-funnel">
            <HBars rows={i.funnel.onboarding.map((f) => ({ label: humanize(f.step), n: f.n }))} />
            <div className="sub-h" style={{ padding: '0 14px' }}>
              Active businesses by conversation state
            </div>
            <HBars rows={i.funnel.conversation.map((f) => ({ label: humanize(f.step), n: f.n }))} />
          </div>
        </section>
        <section>
          <div className="sect-h">
            <h2>This week's update</h2>
            <span className="meta">
              week of {i.weekly.weekStart}, {i.weekly.active} active businesses
            </span>
          </div>
          <div className="box" data-testid="insights-weekly">
            <HBars rows={WEEKLY_ROWS.map(([k, label, tone]) => ({ label, n: i.weekly[k], tone }))} />
          </div>
          <div className="sect-h" style={{ marginTop: 16 }}>
            <h2>Businesses by status</h2>
            <span className="meta">now</span>
          </div>
          <div className="box">
            <HBars rows={Object.entries(i.statuses).map(([k, n]) => ({ label: humanize(k), n, tone: toneOf(k), href: href({ tab: 'businesses', kind: k }) }))} />
          </div>
        </section>
        <section>
          <div className="sect-h">
            <h2>Posts by network</h2>
            <span className="meta">publications in the range</span>
          </div>
          <div className="box">
            {i.posts.byNetwork.length === 0 ? (
              <Empty title="No publications in this range" />
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Network</th>
                    <th className="r">Scheduled</th>
                    <th className="r">Published</th>
                    <th className="r">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {i.posts.byNetwork.map((n) => (
                    <tr key={n.network}>
                      <td className="name">{n.network}</td>
                      <td className="r">{num(n.scheduled)}</td>
                      <td className="r">{num(n.published)}</td>
                      <td className="r">{n.failed > 0 ? <Badge value="failed" label={String(n.failed)} /> : 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="sect-h" style={{ marginTop: 16 }}>
            <h2>New businesses per week</h2>
            <span className="meta">business weeks: Sunday 00:00 in each business's timezone</span>
          </div>
          <div className="box">
            <HBars rows={i.newBusinesses.perWeek.map((w) => ({ label: w.weekStart, n: w.n }))} />
          </div>
        </section>
        <section>
          <div className="sect-h">
            <h2>Busiest conversations</h2>
            <span className="meta">messages in the range, top 20</span>
          </div>
          <div className="box">
            {i.messages.top.length === 0 ? (
              <Empty title="No messages in this range" />
            ) : (
              <table className="tbl" data-testid="insights-top">
                <thead>
                  <tr>
                    <th>Business</th>
                    <th className="r">From owner</th>
                    <th className="r">Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {i.messages.top.map((t) => (
                    <tr key={t.businessId}>
                      <td className="name">
                        <a dir="auto" href={href({ tab: 'conversations', business: t.businessId })}>
                          {t.name}
                        </a>
                      </td>
                      <td className="r">{num(t.inbound)}</td>
                      <td className="r">{num(t.outbound)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------- conversations ----------

const LIST_FILTERS = ['all', 'onboarding', 'active', 'paused', 'cancelled', 'archived', 'handoff', 'open_items'] as const;

/** An archived business is hidden from every list but its own filter, and its panel still opens (2026-11-07). */
function listFilter(b: BusinessRow, kind: string | undefined) {
  if (kind === 'archived') return b.status === 'archived';
  if (b.status === 'archived') return false;
  if (!kind || kind === 'all') return true;
  if (kind === 'handoff') return Boolean(b.handoffAt);
  if (kind === 'open_items') return b.openItems > 0;
  return b.status === kind;
}

function ConversationsTab({ data, names, now }: { data: ConsolePageData; names: Map<string, string>; now: number }) {
  const { query } = data;
  const convo = data.conversation;
  const list = data.businesses.filter((b) => listFilter(b, query.kind) && matches(b.name, query.q));
  const view = !query.business ? 'list' : query.panel === 'client' ? 'panel' : 'thread';
  const filterCount = (k: string) => data.businesses.filter((b) => listFilter(b, k)).length;
  const selected = data.businesses.find((b) => b.id === query.business);
  return (
    <div className="convo" data-view={view} data-testid="conversations">
      <aside className="col c-list" aria-label="Businesses">
        <form className="list-h" method="get" action="/console">
          <input type="hidden" name="tab" value="conversations" />
          {query.kind && <input type="hidden" name="kind" value={query.kind} />}
          <label className="search">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-4-4" />
            </svg>
            <span className="sr">Search businesses</span>
            <input className="in" type="search" name="q" defaultValue={query.q} placeholder="Search by name" />
          </label>
          <nav className="chips" aria-label="Filter by status">
            {LIST_FILTERS.filter((k) => k === 'all' || filterCount(k) > 0).map((k) => (
              <a key={k} className="chip" aria-current={(query.kind ?? 'all') === k ? 'true' : undefined} href={href({ tab: 'conversations', q: query.q, kind: k === 'all' ? undefined : k })}>
                {humanize(k)} <span className="n">{filterCount(k)}</span>
              </a>
            ))}
          </nav>
        </form>
        <div className="col-scroll">
          <ul className="blist" data-testid="conversation-list">
            {list.map((b) => (
              <li key={b.id}>
                <a className="bitem" href={href({ tab: 'conversations', business: b.id, q: query.q, kind: query.kind })} aria-current={b.id === query.business ? 'page' : undefined}>
                  <span className="name" dir="auto">
                    {b.name}
                  </span>
                  <span className="when">
                    <When d={b.lastMessage?.createdAt} now={now} />
                  </span>
                  <span className="preview" dir="auto">
                    {b.lastMessage?.direction === 'outbound' && <span className="me">Postly: </span>}
                    {b.lastMessage ? (b.lastMessage.body ?? `[${humanize(b.lastMessage.kind)}]`) : 'No messages yet'}
                  </span>
                  <span className="tags">
                    <Badge value={b.status} />
                    {b.handoffAt && <Badge value="handoff" label="person" />}
                    {b.openItems > 0 && (
                      <span className="count end" data-tone="warn" title="Open review items">
                        {b.openItems}
                      </span>
                    )}
                  </span>
                </a>
              </li>
            ))}
          </ul>
          {list.length === 0 && <Empty title="No businesses match" text="Clear the search or pick another filter." />}
        </div>
      </aside>

      <section className="col c-thread" aria-label="Conversation">
        {convo ? (
          <>
            <header className="col-h">
              <a className="back only-narrow" href={href({ tab: 'conversations', q: query.q, kind: query.kind })}>
                <span className="sr">Back to </span>List
              </a>
              <div className="who">
                <h2 dir="auto">{convo.business.name}</h2>
                <div className="sub">
                  <Badge value={convo.business.status} />
                  {convo.business.step && <span className="muted">{humanize(convo.business.step)}</span>}
                </div>
              </div>
              <a className="btn sm only-narrow" data-testid="open-client" href={href({ tab: 'conversations', business: convo.business.id, panel: 'client' })}>
                Client
              </a>
            </header>
            <div className="col-scroll" data-chat>
              {convo.business.handoffAt && (
                <div className="banner inline" data-tone="human" style={{ margin: 12 }}>
                  <strong>A person is handling this chat</strong>
                  <span className="facts">
                    <span>since {time(convo.business.handoffAt)}</span>
                  </span>
                </div>
              )}
              <ChatThread messages={convo.messages} />
            </div>
          </>
        ) : query.business ? (
          <Empty title="Business not found" />
        ) : (
          <Empty title="Pick a business" text="Its WhatsApp conversation opens here." />
        )}
      </section>

      <aside className="col c-panel" aria-label="Client">
        {convo && selected && <ClientPanel data={data} selected={selected} names={names} now={now} />}
      </aside>
    </div>
  );
}

function ChatThread({ messages }: { messages: Message[] }) {
  let lastDay = '';
  let prev: Message | undefined;
  return (
    <div className="chat" data-testid="chat">
      {messages.length === 0 && <Empty title="No messages yet" text="Messages appear here once the owner writes." />}
      {messages.map((m) => {
        const day = iso(m.createdAt).slice(0, 10);
        const cont = Boolean(prev && prev.direction === m.direction && +new Date(m.createdAt) - +new Date(prev.createdAt) < 5 * 60e3 && day === lastDay);
        const out = (
          <Fragment key={m.id}>
            {day !== lastDay && <div className="day">{day}</div>}
            <Bubble m={m} cont={cont} />
          </Fragment>
        );
        lastDay = day;
        prev = m;
        return out;
      })}
    </div>
  );
}

function buttonsOf(m: Message): string[] {
  const p = m.payload as { buttons?: Array<{ title?: string; text?: string } | string> } | null;
  if (!p || !Array.isArray(p.buttons)) return [];
  return p.buttons.map((b) => (typeof b === 'string' ? b : (b.title ?? b.text ?? ''))).filter(Boolean);
}

/** An owner's tap on a draft's button (InboundMessage content `button_reply`): which button and which post. */
function tapOf(m: Message): { action: string; postId?: string } | null {
  const p = m.payload as { payload?: { action?: string; postId?: string } } | null;
  return p?.payload?.action ? { action: p.payload.action, ...(p.payload.postId ? { postId: p.payload.postId } : {}) } : null;
}

function templateOf(m: Message): string | null {
  const p = m.payload as { templateName?: string } | null;
  return p?.templateName ?? null;
}

function Bubble({ m, cont }: { m: Message; cont: boolean }) {
  const inbound = m.direction === 'inbound';
  const images = m.kind === 'image' || m.kind === 'buttons' ? (m.mediaAssetIds ?? []) : [];
  return (
    <div className={`msg ${inbound ? 'in' : 'out'}${cont ? ' cont' : ''}`} data-testid={inbound ? 'bubble-inbound' : 'bubble-outbound'}>
      <div className="bubble">
        {images.map((id) => (
          <a key={id} className="media" href={media(id)} target="_blank" rel="noopener">
            <img src={media(id)} alt={inbound ? 'Photo from the owner' : 'Image sent to the owner'} loading="lazy" />
          </a>
        ))}
        {m.kind === 'voice' && <div className="voice">Voice note</div>}
        {m.kind === 'template' && <span className="reply-tag">template {templateOf(m) ?? ''}</span>}
        {m.kind === 'button_reply' && (
          <span className="reply-tag" data-testid="button-tap">
            Tapped {tapOf(m)?.action ?? 'a button'}
            {tapOf(m)?.postId ? ` on post ${short(tapOf(m)!.postId!)}` : ''}
          </span>
        )}
        {m.body && (
          <div className="text" dir="auto">
            {m.body}
          </div>
        )}
        {m.kind === 'buttons' && buttonsOf(m).length > 0 && (
          <div className="btn-chips">
            {buttonsOf(m).map((t) => (
              <span key={t} dir="auto">
                {t}
              </span>
            ))}
          </div>
        )}
        <div className="stamp">
          {m.kind !== 'text' && <span className="kind">{humanize(m.kind)}</span>}
          <time dateTime={iso(m.createdAt)}>{iso(m.createdAt).slice(11, 16)}</time>
        </div>
      </div>
    </div>
  );
}

function profileFacts(profile: unknown): Array<[string, string]> {
  const p = (profile ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (v === undefined || v === null ? '' : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ') : typeof v === 'object' ? Object.values(v as object).filter((x) => typeof x === 'string').join(', ') : String(v));
  const loc = (p.location ?? {}) as Record<string, unknown>;
  const rows: Array<[string, unknown]> = [
    ['Field', p.field],
    ['Products', p.mainProducts],
    ['City', loc.city],
    ['Address', loc.address],
    ['Hours', loc.hours],
    ['Languages', p.languages],
    ['Channels', p.channels],
    ['Style', p.style],
    ['Posts a week', p.postsPerWeek],
    ['Tone', p.tone],
    ['Contact', p.contact],
    ['Approver', p.approverPhone],
  ];
  return rows.map(([k, v]) => [k, s(v)] as [string, string]).filter(([, v]) => v !== '');
}

function ClientPanel({ data, selected, names, now }: { data: ConsolePageData; selected: BusinessRow; names: Map<string, string>; now: number }) {
  const c = data.conversation!;
  const b = c.business;
  const items = data.items.filter((i) => i.businessId === b.id);
  const facts = profileFacts(b.profile);
  return (
    <div className="col-scroll" data-testid="client-panel">
      <header className="col-h">
        <a className="back only-narrow" href={href({ tab: 'conversations', business: b.id })}>
          Chat
        </a>
        <div className="who">
          <h2 dir="auto">{b.name}</h2>
          <div className="sub">
            <Badge value={b.status} />
            <span className="muted">
              {usd(b.costUsd.last24h)} today, {usd(b.costUsd.total)} total
            </span>
          </div>
        </div>
      </header>
      <div className="box-pad">
        <BusinessActions b={selected} withProfile={false} />
      </div>

      {items.length > 0 && (
        <details className="disc psec" open>
          <summary>
            <h3>Open review items</h3>
            <span className="end">
              <span className="count" data-tone="warn">
                {items.length}
              </span>
            </span>
          </summary>
          <div className="disc-body">
            <ReviewQueue items={items} names={names} query={data.query} now={now} compact />
          </div>
        </details>
      )}

      <details className="disc psec" open>
        <summary>
          <h3>Profile</h3>
        </summary>
        <div className="disc-body">
          {facts.length === 0 ? (
            <p className="muted">No profile fields yet.</p>
          ) : (
            <dl className="kv">
              {facts.map(([k, v]) => (
                <Fragment key={k}>
                  <dt>{k}</dt>
                  <dd dir="auto">{v}</dd>
                </Fragment>
              ))}
            </dl>
          )}
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>Conversation</dt>
            <dd>{b.step ? humanize(b.step) : 'none'}</dd>
            {b.openQuestion && (
              <>
                <dt>Open question</dt>
                <dd dir="auto">{b.openQuestion}</dd>
              </>
            )}
            <dt>Last inbound</dt>
            <dd>{b.lastInboundAt ? time(b.lastInboundAt) : 'never'}</dd>
            <dt>Channels</dt>
            <dd>
              {b.channels.length === 0
                ? 'none'
                : b.channels.map((ch) => (
                    <span key={ch.id} style={{ marginRight: 6 }}>
                      {ch.network} <Badge value={ch.status} />
                    </span>
                  ))}
            </dd>
            <dt>Subscription</dt>
            <dd>{b.subscription ? <Badge value={b.subscription.heldAt ? 'held' : b.subscription.status} /> : 'none'}</dd>
          </dl>
          <p style={{ marginTop: 8 }}>
            <a href={href({ tab: 'manage', business: b.id, panel: 'profile' })}>Edit profile</a>
          </p>
        </div>
      </details>

      <details className="disc psec" open={c.posts.length <= 6}>
        <summary>
          <h3>Posts and drafts</h3>
          <span className="end muted">{c.posts.length}</span>
        </summary>
        <div className="disc-body">
          {c.posts.length === 0 ? <p className="muted">No posts yet.</p> : c.posts.map((p) => <PostCard key={p.id} p={p} now={now} />)}
        </div>
      </details>

      <details className="disc psec">
        <summary>
          <h3>Agent turns</h3>
          <span className="end muted">{c.turns.length}</span>
        </summary>
        <div className="disc-body">
          {c.turns.length === 0 ? <p className="muted">No agent turns.</p> : c.turns.map((t) => <TurnDetail key={t.id} t={t} query={data.query} now={now} />)}
        </div>
      </details>

      <details className="disc psec" open>
        <summary>
          <h3>Model runs</h3>
          <span className="end muted">
            {c.runs.length}, {usd(c.runs.reduce((s, r) => s + r.costUsd, 0))}
          </span>
        </summary>
        <div className="disc-body box" style={{ padding: 0 }}>
          {c.runs.length === 0 ? (
            <p className="muted box-pad">No model runs.</p>
          ) : (
            <ul className="feed" data-testid="model-runs">
              {c.runs.map((r) => (
                <RunItem key={r.id} r={r} query={data.query} now={now} />
              ))}
            </ul>
          )}
        </div>
      </details>
    </div>
  );
}

function captionOf(captions: PostDetail['versions'][number]['captions']): string {
  const first = Object.values(captions ?? {})[0];
  if (!first) return '';
  const tags = Array.isArray(first.hashtags) && first.hashtags.length ? `\n${first.hashtags.join(' ')}` : '';
  return `${first.text ?? ''}${tags}`;
}

function PostCard({ p, now }: { p: PostDetail; now: number }) {
  const v = p.versions[0];
  const slides = v ? (Object.values(v.renderedMedia ?? {})[0] ?? []) : [];
  const attention = ['failed', 'needs_review', 'partially_published'].includes(p.status);
  return (
    <article className="post" data-tone={attention ? toneOf(p.status) : undefined} data-testid="post-card">
      <header className="post-h">
        <Badge value={p.status} />
        <span>{humanize(p.format)}</span>
        {p.weekStart && <span className="muted">week {p.weekStart}</span>}
        <span className="id">{short(p.id)}</span>
        <span className="when">
          <When d={p.updatedAt} now={now} />
        </span>
      </header>
      {slides.length > 0 && (
        <div className="thumbs">
          {slides.map((id, i) => (
            <a key={id} href={media(id)} target="_blank" rel="noopener">
              <img src={media(id)} alt={`Rendered slide ${i + 1}`} loading="lazy" data-testid="rendered-image" />
              {slides.length > 1 && <span className="slide">{i + 1}</span>}
            </a>
          ))}
        </div>
      )}
      {v && (
        <p className="caption clamp" dir="auto">
          {captionOf(v.captions)}
        </p>
      )}
      {p.versions.length > 0 && (
        <>
          <div className="sub-h">Versions</div>
          <ol className="versions">
            {p.versions.map((ver) => {
              const standing = ver.approvals.find((a) => !a.invalidatedAt);
              return (
                <li key={ver.id} data-testid="version">
                  <span className="vn">v{ver.versionNumber}</span>
                  <span className="hash" title={ver.contentHash}>
                    {ver.contentHash.slice(0, 10)}
                  </span>
                  <Badge value={ver.factCheckPassed ? 'fact_ok' : 'fact_failed'} label={ver.factCheckPassed ? 'facts ok' : 'facts failed'} />
                  {ver.approvals.map((a) => (
                    <Badge key={a.id} value={a.invalidatedAt ? 'invalidated' : 'approved'} strike={Boolean(a.invalidatedAt)} label={a.invalidatedAt ? `approval invalidated ${ago(a.invalidatedAt, now)}` : `approved ${ago(a.approvedAt, now)}`} />
                  ))}
                  {ver.approvals.length === 0 && <span className="muted">not approved</span>}
                  {ver.id === p.currentVersionId && <span className="live">current</span>}
                  {standing && p.publications.some((x) => x.approvedVersionHash === ver.contentHash) && <span className="live">publications use this hash</span>}
                </li>
              );
            })}
          </ol>
        </>
      )}
      {p.publications.length > 0 && (
        <>
          <div className="sub-h">Publications</div>
          <ul className="pubs">
            {p.publications.map((x) => (
              <li key={x.id} data-testid="publication">
                <span className="net">{x.network}</span>
                <Badge value={x.status} />
                {x.status === 'failed' ? <Action size="sm" tone="danger" path={`/publications/${x.id}/retry`} label="Retry" confirm="Retry this publication? The publishing job still checks the approved hash." done="Retry queued" /> : <span />}
                <span className="facts">
                  {x.scheduledFor && <span>scheduled {time(x.scheduledFor)}</span>}
                  {x.publishedAt && <span>published {time(x.publishedAt)}</span>}
                  <span>attempts {x.attempts}</span>
                  <span className="hash" title={x.approvedVersionHash}>
                    {x.approvedVersionHash.slice(0, 10)}
                  </span>
                </span>
                {x.lastError && <span className="err">{x.lastError}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="ro">Approval comes only from the owner's WhatsApp. This console cannot approve or publish.</p>
    </article>
  );
}

interface Step {
  confidence?: number;
  costUsd?: number;
  calls?: Array<{ call?: { tool?: string; name?: string } & Record<string, unknown>; result?: { status?: string } & Record<string, unknown> }>;
}

function TurnDetail({ t, query, now }: { t: NonNullable<ConsolePageData['conversation']>['turns'][number]; query: PageQuery; now: number }) {
  const steps = (Array.isArray(t.steps) ? t.steps : []) as Step[];
  void query;
  return (
    <details className="turn">
      <summary>
        <span className="title">
          <Badge value={t.agent} tone="neutral" />
          <Badge value={t.stopReason ?? t.status} />
        </span>
        <span className="when">
          <When d={t.startedAt} now={now} />
        </span>
        <span className="facts">
          <span>
            <b>{steps.length}</b> steps
          </span>
          <span>
            <b>{usd(t.costUsd)}</b>
          </span>
          {t.durationMs !== null && <span>{t.durationMs} ms</span>}
        </span>
      </summary>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={i}>
            <div className="step-h">
              {(s.calls ?? []).map((c, j) => (
                <Badge key={j} value={c.result?.status === 'refused' ? 'failed' : 'ok'} label={String(c.call?.tool ?? c.call?.name ?? 'call')} tone={c.result?.status === 'refused' ? 'bad' : 'neutral'} />
              ))}
              {typeof s.confidence === 'number' && <span className="muted">confidence {s.confidence}</span>}
              {typeof s.costUsd === 'number' && <span className="muted">{usd(s.costUsd)}</span>}
            </div>
            <JsonBlock title="Calls and results" value={s.calls ?? s} />
          </li>
        ))}
      </ol>
      <JsonBlock title="Trigger" value={t.trigger} />
    </details>
  );
}

function RunItem({ r, query, now }: { r: ModelRunSummary; query: PageQuery; now: number }) {
  const ok = runOk(r);
  return (
    <li data-tone={ok ? undefined : 'bad'}>
      <span className="title">
        {humanize(r.task)}
        <Badge value={ok ? 'ok' : 'run_failed'} label={ok ? 'ok' : 'failed'} />
      </span>
      <span className="when">
        <When d={r.createdAt} now={now} />
      </span>
      <span className="facts">
        <span>{r.model}</span>
        <span>v{r.promptVersion}</span>
        <span>try {r.attempt}</span>
        <span>{usd(r.costUsd)}</span>
        {r.durationMs !== null && <span>{r.durationMs} ms</span>}
        <a href={href({ ...query, run: r.id })}>Details</a>
      </span>
      {r.error && <span className="err">{r.error}</span>}
    </li>
  );
}

// ---------- model run view ----------

function RunView({ data, names }: { data: ConsolePageData; names: Map<string, string> }) {
  const r = data.run;
  const back = href({ ...data.query, run: undefined });
  if (!r) {
    return (
      <div data-testid="model-run">
        <a className="back" href={back}>
          Back
        </a>
        <Empty title="Model run not found" />
      </div>
    );
  }
  const ok = runOk(r);
  const rows: Array<[string, ReactNode]> = [
    ['Business', r.businessId ? <a dir="auto" href={href({ tab: 'conversations', business: r.businessId })}>{names.get(r.businessId) ?? short(r.businessId)}</a> : 'none'],
    ['Task', <code>{r.task}</code>],
    ['Provider', r.provider],
    ['Model', r.model],
    ['Prompt version', `v${r.promptVersion}`],
    ['Attempt', r.attempt],
    ['Tokens', `${r.inputTokens ?? 0} in, ${r.outputTokens ?? 0} out`],
    ['Cost', usd(r.costUsd)],
    ['Duration', r.durationMs === null ? 'n/a' : `${r.durationMs} ms`],
    ['Agent turn', r.agentTurnId ? short(r.agentTurnId) : 'none'],
    ['At', time(r.createdAt)],
  ];
  return (
    <div data-testid="model-run">
      <a className="back" href={back}>
        Back
      </a>
      <div className="run-h">
        <h1>{humanize(r.task)}</h1>
        <Badge value={ok ? 'ok' : 'run_failed'} label={ok ? 'valid' : 'failed'} />
        <span className="id">{r.id}</span>
      </div>
      <dl className="run-kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {r.error && <JsonBlock title="Error" value={r.error} open err />}
      <JsonBlock title="Output" value={r.output} open />
      <JsonBlock title="Input" value={r.input} />
    </div>
  );
}

// ---------- page ----------

function ConfirmDialog({ actor }: { actor: string }) {
  return (
    <dialog id="confirm" className="confirm" aria-labelledby="confirm-title">
      <form method="dialog">
        <h2 id="confirm-title" data-f="title" />
        <p className="muted" data-f="text" />
        <pre className="changes" data-f="changes" hidden />
        <label className="field">
          <span>Reason (optional)</span>
          <input className="in" name="reason" autoComplete="off" maxLength={500} />
        </label>
        <p className="who">Recorded as {actor}</p>
        <div className="row">
          <button className="btn primary" value="ok">
            Confirm
          </button>
          <button className="btn quiet" value="cancel" formNoValidate>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

function ConsolePage({ data, now }: { data: ConsolePageData; now: number }) {
  const names = new Map(data.businesses.map((b) => [b.id, b.name]));
  const convoTab = data.query.tab === 'conversations' && !data.query.run;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="light dark" />
        <meta name="robots" content="noindex" />
        <title>Postly console</title>
        <style>{CSS}</style>
      </head>
      <body className={convoTab ? 'is-convo' : undefined} data-actor={data.actor}>
        <TopBar data={data} />
        <PauseBanner data={data} />
        <main className="wrap">
          {data.query.run ? (
            <RunView data={data} names={names} />
          ) : data.query.tab === 'manage' ? (
            <ManageTab data={data} names={names} now={now} />
          ) : data.query.tab === 'insights' && data.insights ? (
            <InsightsTab data={data} />
          ) : data.query.tab === 'businesses' ? (
            <BusinessesTab data={data} now={now} />
          ) : convoTab ? (
            <ConversationsTab data={data} names={names} now={now} />
          ) : (
            <OverviewTab data={data} names={names} now={now} />
          )}
        </main>
        <ConfirmDialog actor={data.actor} />
        <p id="status" role="status" aria-live="polite" />
        <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />
      </body>
    </html>
  );
}

export function renderConsolePage(data: ConsolePageData, now: Date = new Date()): string {
  jsonCounter = 0;
  return `<!doctype html>${renderToStaticMarkup(<ConsolePage data={data} now={now.getTime()} />)}`;
}
