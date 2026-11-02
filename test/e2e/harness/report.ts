import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { E2eRecord, ImageAttachment, PublishingEntry, RenderedImage, TranscriptEntry } from './record.js';

export interface ReportTest {
  name: string;
  file: string;
  state: 'passed' | 'failed' | 'skipped' | 'pending';
  durationMs?: number;
  errors: string[];
  record?: E2eRecord;
}

export interface ReportRun {
  title: string;
  generatedAt: string;
  tests: ReportTest[];
}

/** Writes the report as one self-contained `index.html` in `dir` and returns its path. */
export function writeReport(dir: string, run: ReportRun): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'index.html');
  writeFileSync(path, renderReport(run), 'utf8');
  return path;
}

/** Renders a static HTML report a human can open without running the code. */
export function renderReport(run: ReportRun): string {
  const count = (state: ReportTest['state']) => run.tests.filter((t) => t.state === state).length;
  const summary = [
    `${count('passed')} passed`,
    `${count('failed')} failed`,
    ...(count('skipped') ? [`${count('skipped')} skipped`] : []),
    ...(count('pending') ? [`${count('pending')} not finished`] : []),
  ].join(' · ');
  const overall = count('failed') > 0 ? 'failed' : 'passed';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(run.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>${esc(run.title)}</h1>
  <p class="summary" data-state="${overall}">${esc(summary)}</p>
  <p class="meta">Generated ${esc(run.generatedAt)}</p>
</header>
<main>
${run.tests.map(renderTest).join('\n')}
</main>
</body>
</html>
`;
}

function renderTest(test: ReportTest): string {
  const duration = test.durationMs === undefined ? '' : ` · ${Math.round(test.durationMs)} ms`;
  const errors = test.errors.length
    ? `<section><h3>Errors</h3>${test.errors.map((e) => `<pre class="error">${esc(e)}</pre>`).join('')}</section>`
    : '';
  const r = test.record;
  return `<article class="test" data-state="${test.state}">
  <h2><span class="badge">${esc(test.state)}</span> ${esc(test.name)}</h2>
  <p class="meta">${esc(test.file)}${esc(duration)}</p>
  ${errors}
  ${r ? renderTranscript(r.transcript) + renderRenders(r.renders) + renderPublishing(r.publishing) : ''}
</article>`;
}

function renderTranscript(entries: TranscriptEntry[]): string {
  if (!entries.length) return '';
  return `<section><h3>WhatsApp conversation</h3><div class="chat">${entries.map(renderMessage).join('')}</div></section>`;
}

function renderMessage(m: TranscriptEntry): string {
  const who = m.direction === 'from_owner' ? `Owner ${m.phone}` : `Postly → ${m.phone}`;
  const parts: string[] = [];
  if (m.image) parts.push(img(m.image));
  if (m.kind === 'voice') parts.push('<p class="note">[voice message]</p>');
  if (m.kind === 'button_reply') parts.push('<p class="note">[tapped button]</p>');
  if (m.text !== undefined) parts.push(`<p dir="auto">${esc(m.text)}</p>`);
  if (m.template) {
    const vars = Object.entries(m.template.variables)
      .map(([k, v]) => `${esc(k)}=<span dir="auto">${esc(v)}</span>`)
      .join(', ');
    parts.push(`<p class="note">Template <code>${esc(m.template.name)}</code> (${esc(m.template.language)}) ${vars}</p>`);
  }
  if (m.buttons?.length) {
    parts.push(
      `<div class="buttons">${m.buttons.map((b) => `<span class="button" dir="auto" title="${esc(b.id)}">${esc(b.title)}</span>`).join('')}</div>`,
    );
  }
  return `<div class="bubble" data-direction="${m.direction}" data-kind="${m.kind}">
  <p class="who">${esc(who)} · ${esc(m.at)}</p>${parts.join('')}
</div>`;
}

function renderRenders(renders: RenderedImage[]): string {
  if (!renders.length) return '';
  const cards = renders
    .map(
      (r) => `<figure>${img(r.image)}<figcaption>${esc(r.network)} · ${esc(r.style)} · ${r.width}×${r.height}</figcaption></figure>`,
    )
    .join('');
  return `<section><h3>Rendered images</h3><div class="gallery">${cards}</div></section>`;
}

function renderPublishing(entries: PublishingEntry[]): string {
  if (!entries.length) return '';
  const rows = entries
    .map((p) => {
      const outcome = p.outcome.ok
        ? `<span class="ok">published as ${esc(p.outcome.providerPostId)}</span>`
        : `<span class="fail">failed: ${esc(p.outcome.error)}</span>`;
      return `<tr>
  <td>${esc(p.network)}<br><span class="meta">${esc(p.providerAccountId)}</span></td>
  <td>${esc(p.scheduledFor)}<br><span class="meta">${esc(p.format)}</span></td>
  <td><p dir="auto">${esc(p.caption)}</p><div class="thumbs">${p.media.map(img).join('')}</div></td>
  <td>${outcome}<br><span class="meta">key ${esc(p.idempotencyKey)}</span></td>
</tr>`;
    })
    .join('');
  return `<section><h3>Publishing log</h3><table>
<thead><tr><th>Network</th><th>Scheduled for</th><th>Post</th><th>Outcome</th></tr></thead>
<tbody>${rows}</tbody></table></section>`;
}

function img(image: ImageAttachment): string {
  if (!image.src?.startsWith('data:image/')) {
    return `<p class="note">[image not available: ${esc(image.ref)}]</p>`;
  }
  return `<img src="${esc(image.src)}" alt="${esc(image.ref)}" loading="lazy">`;
}

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
:root { --bg: #f6f7f9; --card: #fff; --text: #1d2330; --muted: #6b7280; --line: #e3e6ea;
  --pass: #16794c; --fail: #b42318; --skip: #8a6d00; --owner: #dcf8c6; --postly: #fff; --chat: #ece5dd; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #111418; --card: #1a1f26; --text: #e6e8eb; --muted: #9aa3ad; --line: #2b323b;
    --pass: #4ade80; --fail: #f87171; --skip: #facc15; --owner: #144d37; --postly: #222a33; --chat: #0b1014; }
}
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Arial, sans-serif; background: var(--bg); color: var(--text); }
header, main { max-width: 960px; margin: 0 auto; padding: 16px; }
h1 { margin: 8px 0 4px; font-size: 22px; }
h2 { font-size: 17px; margin: 0 0 2px; }
h3 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 18px 0 8px; }
.meta { color: var(--muted); font-size: 13px; margin: 0; }
.summary { font-weight: 600; margin: 0 0 4px; }
.summary[data-state="passed"] { color: var(--pass); } .summary[data-state="failed"] { color: var(--fail); }
.test { background: var(--card); border: 1px solid var(--line); border-left: 5px solid var(--line); border-radius: 8px; padding: 14px 16px; margin: 0 0 16px; }
.test[data-state="passed"] { border-left-color: var(--pass); } .test[data-state="failed"] { border-left-color: var(--fail); }
.test[data-state="skipped"], .test[data-state="pending"] { border-left-color: var(--skip); }
.badge { font-size: 12px; text-transform: uppercase; padding: 1px 6px; border-radius: 4px; color: #fff; background: var(--muted); vertical-align: 2px; }
[data-state="passed"] > h2 .badge { background: var(--pass); } [data-state="failed"] > h2 .badge { background: var(--fail); }
pre.error { white-space: pre-wrap; overflow-x: auto; background: var(--bg); border: 1px solid var(--fail); border-radius: 6px; padding: 8px; color: var(--fail); }
.chat { background: var(--chat); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.bubble { max-width: min(420px, 85%); background: var(--postly); border-radius: 8px; padding: 6px 10px; box-shadow: 0 1px 1px rgba(0,0,0,.08); }
.bubble[data-direction="from_owner"] { align-self: flex-end; background: var(--owner); }
.bubble p { margin: 2px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.bubble .who { font-size: 11px; color: var(--muted); }
.bubble img { display: block; width: 240px; max-width: 100%; border-radius: 6px; margin: 4px 0; }
.note { color: var(--muted); font-size: 13px; }
.buttons { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.button { border: 1px solid var(--line); border-radius: 6px; padding: 2px 10px; color: #0a7cff; background: var(--card); }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
figure { margin: 0; } figure img { width: 100%; border: 1px solid var(--line); border-radius: 6px; }
figcaption { font-size: 13px; color: var(--muted); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; vertical-align: top; border-top: 1px solid var(--line); padding: 6px; }
td p { margin: 0 0 4px; white-space: pre-wrap; }
.thumbs img { width: 64px; height: 64px; object-fit: cover; border-radius: 4px; margin-right: 4px; }
.ok { color: var(--pass); } .fail { color: var(--fail); }
@media (max-width: 600px) { table, tbody, tr, td { display: block; } thead { display: none; } td { border-top: none; } tr { border-top: 1px solid var(--line); padding: 6px 0; } }
`;
