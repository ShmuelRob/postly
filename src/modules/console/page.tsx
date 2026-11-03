import { renderToStaticMarkup } from 'react-dom/server';
import type * as schema from '../../db/schema.js';
import type { BusinessSummary, ConsoleService, Draft } from './console.js';

// The console page, rendered on the server. Buttons carry a data-action URL; the small script at the
// bottom POSTs it to the console API and reloads, so every action goes through the same routes as the tests.

export interface ConsolePageData {
  businesses: BusinessSummary[];
  drafts: Draft[];
  items: Array<typeof schema.consoleItem.$inferSelect>;
  system: Awaited<ReturnType<ConsoleService['system']>>;
  conversations: Record<string, Array<typeof schema.message.$inferSelect>>;
}

const api = (path: string) => `/console/api${path}`;
const time = (d: Date | null) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '');
const short = (id: string) => id.slice(0, 8);

function Action({ path, label, tone = 'plain', body }: { path: string; label: string; tone?: 'plain' | 'warn' | 'go'; body?: object }) {
  return (
    <button className={`btn ${tone}`} data-action={api(path)} data-body={body ? JSON.stringify(body) : undefined}>
      {label}
    </button>
  );
}

function Badge({ value }: { value: string }) {
  return <span className={`badge s-${value}`}>{value.replaceAll('_', ' ')}</span>;
}

function SystemBar({ system }: { system: ConsolePageData['system'] }) {
  return (
    <section className={`system ${system.publishingPaused ? 'paused' : ''}`}>
      <div>
        <strong>Publishing: {system.publishingPaused ? 'paused for all businesses' : 'running'}</strong>
        {system.publishingPaused && (
          <span className="muted">
            {' '}
            by {system.pausedBy} at {time(system.pausedAt)}
            {system.pausedReason ? ` (${system.pausedReason})` : ''}
          </span>
        )}
      </div>
      {system.publishingPaused ? (
        <Action path="/system/resume" label="Resume all publishing" tone="go" body={{ by: 'console' }} />
      ) : (
        <Action path="/system/pause" label="Pause all publishing" tone="warn" body={{ by: 'console', reason: 'paused from the console' }} />
      )}
    </section>
  );
}

function Items({ items, names }: { items: ConsolePageData['items']; names: Map<string, string> }) {
  return (
    <section>
      <h2>Console items <span className="count">{items.length} open</span></h2>
      {items.length === 0 ? (
        <p className="muted">Nothing waiting.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Kind</th><th>Business</th><th>Details</th><th>Opened</th><th /></tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td><Badge value={i.kind} /></td>
                <td dir="auto">{i.businessId ? (names.get(i.businessId) ?? short(i.businessId)) : <span className="muted">unknown number</span>}</td>
                <td><code>{JSON.stringify(i.details)}</code></td>
                <td>{time(i.createdAt)}</td>
                <td className="actions">
                  {i.businessId && <Action path={`/items/${i.id}/route`} label="Route to a person" />}
                  <Action path={`/items/${i.id}/resolve`} label="Resolve" tone="go" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Business({ b, messages }: { b: BusinessSummary; messages: ConsolePageData['conversations'][string] }) {
  return (
    <article className="business">
      <header>
        <div>
          <h3 dir="auto">{b.name}</h3>
          <Badge value={b.status} /> {b.step && <span className="muted">step: {b.step}</span>}
          {b.handoffAt && <span className="badge s-handoff">handled by a person since {time(b.handoffAt)}</span>}
        </div>
        <div className="actions">
          {b.handoffAt ? (
            <Action path={`/businesses/${b.id}/handoff/clear`} label="Return to agent" tone="go" />
          ) : (
            <Action path={`/businesses/${b.id}/handoff`} label="Take over" />
          )}
          {b.status === 'active' && <Action path={`/businesses/${b.id}/pause`} label="Pause business" tone="warn" />}
          {b.status === 'paused' && <Action path={`/businesses/${b.id}/resume`} label="Resume business" tone="go" />}
        </div>
      </header>
      <div className="chat">
        {messages.length === 0 && <p className="muted">No messages.</p>}
        {messages.slice(-12).map((m) => (
          <div key={m.id} className={`msg ${m.direction}`}>
            <div dir="auto">{m.body ?? <em>[{m.kind}]</em>}</div>
            <small>{time(m.createdAt)}</small>
          </div>
        ))}
      </div>
    </article>
  );
}

function Drafts({ drafts, names }: { drafts: Draft[]; names: Map<string, string> }) {
  return (
    <section>
      <h2>Drafts and posts</h2>
      {drafts.length === 0 ? (
        <p className="muted">No posts yet.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Business</th><th>Post</th><th>Status</th><th>Version</th><th>Caption</th><th>Publications</th></tr>
          </thead>
          <tbody>
            {drafts.map((d) => (
              <tr key={d.id}>
                <td dir="auto">{names.get(d.businessId) ?? short(d.businessId)}</td>
                <td><code>{short(d.id)}</code> {d.format}</td>
                <td><Badge value={d.status} /></td>
                <td>{d.version ? `v${d.version.versionNumber} · ${d.version.contentHash.slice(0, 10)}` : <span className="muted">none</span>}</td>
                <td className="caption" dir="auto">{d.version ? captionOf(d.version.captions) : ''}</td>
                <td>
                  {d.publications.map((p) => (
                    <div key={p.id} className="pub">
                      {p.network} <Badge value={p.status} />
                      {p.status === 'failed' && <Action path={`/publications/${p.id}/retry`} label="Retry" tone="warn" />}
                      {p.lastError && <small className="muted"> {p.lastError}</small>}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function captionOf(captions: unknown): string {
  if (captions && typeof captions === 'object') {
    const first = Object.values(captions as Record<string, unknown>).find((v) => typeof v === 'string');
    if (typeof first === 'string') return first.length > 140 ? `${first.slice(0, 140)}…` : first;
  }
  return '';
}

function ConsolePage({ data }: { data: ConsolePageData }) {
  const names = new Map(data.businesses.map((b) => [b.id, b.name]));
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Postly console</title>
        <style>{CSS}</style>
      </head>
      <body>
        <h1>Postly console</h1>
        <SystemBar system={data.system} />
        <Items items={data.items} names={names} />
        <section>
          <h2>Conversations</h2>
          <div className="grid">
            {data.businesses.map((b) => (
              <Business key={b.id} b={b} messages={data.conversations[b.id] ?? []} />
            ))}
          </div>
        </section>
        <Drafts drafts={data.drafts} names={names} />
        <p id="status" role="status" />
        <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />
      </body>
    </html>
  );
}

export function renderConsolePage(data: ConsolePageData): string {
  return `<!doctype html>${renderToStaticMarkup(<ConsolePage data={data} />)}`;
}

const SCRIPT = `
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  b.disabled = true;
  const body = b.dataset.body;
  const res = await fetch(b.dataset.action, { method: 'POST', headers: body ? { 'content-type': 'application/json' } : {}, body });
  if (res.ok) return location.reload();
  const out = await res.json().catch(() => ({}));
  document.getElementById('status').textContent = 'Refused: ' + (out.reason || res.status) + (out.detail ? ' (' + out.detail + ')' : '');
  b.disabled = false;
});`;

const CSS = `
:root { --bg:#f6f5f2; --card:#fff; --ink:#1d1c1a; --muted:#77736b; --line:#e4e1da; --warn:#b4441c; --go:#1f6b4a; }
* { box-sizing:border-box; }
body { margin:0; padding:24px 32px; background:var(--bg); color:var(--ink); font:14px/1.45 'Segoe UI', Arial, sans-serif; }
h1 { font-size:20px; margin:0 0 16px; letter-spacing:-.01em; }
h2 { font-size:15px; margin:28px 0 10px; }
h3 { font-size:15px; margin:0 0 4px; }
.count { color:var(--muted); font-weight:400; }
.muted { color:var(--muted); }
section.system { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:12px 16px; border-radius:10px; background:#e8f1ec; border:1px solid #c7ddd0; }
section.system.paused { background:#fbe9e1; border-color:#efc4b2; }
table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-weight:600; font-size:12px; color:var(--muted); background:#faf9f6; }
code { font-size:12px; color:#4b4842; }
.actions { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
.btn { font:inherit; font-size:13px; padding:5px 10px; border-radius:7px; border:1px solid var(--line); background:#fff; cursor:pointer; }
.btn:hover { border-color:#bdb8ae; }
.btn.warn { color:var(--warn); border-color:#efc4b2; }
.btn.go { color:var(--go); border-color:#c7ddd0; }
.badge { display:inline-block; font-size:12px; padding:1px 8px; border-radius:99px; background:#eeece7; margin-right:4px; }
.s-failed, .s-publication_failed, .s-draft_failed, .s-model_validation_failed, .s-extraction_failed, .s-paused, .s-channel_disconnected { background:#fbe3d9; color:var(--warn); }
.s-active, .s-published, .s-approved { background:#dcefe4; color:var(--go); }
.s-handoff, .s-unknown_number { background:#efe6fa; color:#5b3a8c; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(360px, 1fr)); gap:12px; }
.business { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px; }
.business header { display:flex; justify-content:space-between; gap:8px; margin-bottom:10px; }
.chat { display:flex; flex-direction:column; gap:6px; max-height:260px; overflow:auto; background:#f1efe9; border-radius:8px; padding:8px; }
.msg { max-width:80%; padding:6px 9px; border-radius:8px; background:#fff; }
.msg.outbound { align-self:flex-end; background:#dcf3e2; }
.msg small { display:block; color:var(--muted); font-size:11px; }
.caption { max-width:320px; }
.pub { margin-bottom:4px; }
#status { color:var(--warn); }
`;
