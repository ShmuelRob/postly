// The console page's only script: writes go through a confirm dialog (with an optional reason) and
// POST JSON to the console API, then reload. Reads are plain links, so the page works without it.
// Kept free of the closing script tag, since it is inlined.

export const SCRIPT = String.raw`
(() => {
  const status = document.getElementById('status');
  const dlg = document.getElementById('confirm');
  const toast = (msg, tone) => { status.textContent = msg; status.dataset.tone = tone || 'bad'; clearTimeout(toast.t);
    toast.t = setTimeout(() => { status.textContent = ''; }, tone === 'good' ? 2500 : 8000); };
  try { const f = sessionStorage.getItem('flash'); if (f) { sessionStorage.removeItem('flash'); toast(f, 'good'); } } catch (e) {}

  const ask = (o) => new Promise((resolve) => {
    if (!dlg || !dlg.showModal) return resolve(confirm(o.title) ? '' : null);
    dlg.querySelector('[data-f=title]').textContent = o.title;
    dlg.querySelector('[data-f=text]').textContent = o.text || '';
    const ch = dlg.querySelector('[data-f=changes]'); ch.textContent = o.changes || ''; ch.hidden = !o.changes;
    const ok = dlg.querySelector('button[value=ok]'); ok.textContent = o.ok || 'Confirm';
    ok.className = 'btn ' + (o.danger ? 'danger-solid' : 'primary');
    const reason = dlg.querySelector('input[name=reason]'); reason.value = '';
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? reason.value.trim() : null), { once: true });
    dlg.showModal(); reason.focus();
  });

  const refusal = (out) => 'Refused: ' + (out.reason || 'error') + (out.detail ? ' (' + out.detail + ')' : '');
  const send = async (url, body, done) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) { try { sessionStorage.setItem('flash', done || 'Saved'); } catch (e) {} location.reload(); return null; }
    return res.json().catch(() => ({ reason: String(res.status) }));
  };
  const diffKeys = (a, b) => {
    const out = [];
    for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
      const x = JSON.stringify((a || {})[k]), y = JSON.stringify((b || {})[k]);
      if (x !== y) out.push((x === undefined ? '+ ' : y === undefined ? '- ' : '~ ') + k);
    }
    return out.join('\n');
  };

  document.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) { const el = document.getElementById(c.dataset.copy);
      if (el && navigator.clipboard) navigator.clipboard.writeText(el.textContent).then(() => toast('Copied', 'good'));
      return; }
    const b = e.target.closest('[data-action]');
    if (!b || b.disabled) return;
    e.preventDefault();
    const label = b.textContent.trim();
    const reason = await ask({ title: b.dataset.confirm || label + '?', text: b.dataset.detail, ok: label,
      danger: b.classList.contains('danger') || b.dataset.v === 'off' });
    if (reason === null) return;
    const body = Object.assign({}, b.dataset.body ? JSON.parse(b.dataset.body) : {}, reason ? { reason } : {});
    b.disabled = true;
    const out = await send(b.dataset.action, body, b.dataset.done);
    if (out) { toast(refusal(out)); b.disabled = false; }
  });

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (!f.matches('form[data-api]')) return;
    e.preventDefault();
    const errs = f.querySelector('.form-errors') || document.querySelector('[data-errors-for="' + f.id + '"]');
    if (errs) errs.textContent = '';
    const body = {}; let changes = '';
    for (const el of Array.from(f.elements)) {
      if (!el.name || el.disabled || el.type === 'submit' || el.type === 'button') continue;
      let v = el.type === 'checkbox' ? el.checked : el.value.trim();
      if (v === '') continue;
      const t = el.dataset.type;
      if (t === 'number') { v = Number(v) * Number(el.dataset.scale || 1); if (el.dataset.scale) v = Math.round(v);
        if (!Number.isFinite(v)) { toast(el.name + ' must be a number'); el.focus(); return; } }
      if (t === 'json') {
        try { v = JSON.parse(v); } catch (x) { (errs ? (errs.textContent = 'Not valid JSON: ' + x.message) : toast('Not valid JSON')); el.focus(); return; }
        if (el.dataset.original) { changes = diffKeys(JSON.parse(el.dataset.original), v); if (!changes) { toast('No changes to save', 'good'); return; } }
      }
      body[el.name] = v;
    }
    if (f.dataset.confirm) {
      const reason = await ask({ title: f.dataset.confirm, changes: changes ? 'Changed keys:\n' + changes : '' });
      if (reason === null) return;
      if (reason && !body.reason) body.reason = reason;
    }
    const btn = f.querySelector('[type=submit]'); if (btn) btn.disabled = true;
    const out = await send(f.dataset.api, body, f.dataset.done);
    if (!out) return;
    if (btn) btn.disabled = false;
    if (errs && Array.isArray(out.issues)) {
      errs.textContent = refusal(out);
      const ul = document.createElement('ul');
      for (const i of out.issues) { const li = document.createElement('li'); li.textContent = (i.path || []).join('.') + ': ' + i.message; ul.appendChild(li); }
      errs.appendChild(ul);
    } else toast(refusal(out));
  });

  const chat = document.querySelector('[data-chat]');
  if (chat) {
    if (chat.scrollHeight > chat.clientHeight + 4) chat.scrollTop = chat.scrollHeight;
    else if (!location.hash) window.scrollTo(0, document.documentElement.scrollHeight);
  }
})();
`;
