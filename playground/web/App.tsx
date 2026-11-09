import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { ChatMessage, CheckoutOutcome, CheckoutState, FeedPost, OwnerInput, PlaygroundState } from '../server/api-types.ts';

const POLL_MS = 700;

async function post(input: OwnerInput) {
  const res = await fetch('/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
}

async function fileInput(file: File, kind: 'image' | 'voice'): Promise<OwnerInput> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return { kind, mimeType: file.type || (kind === 'image' ? 'image/jpeg' : 'audio/ogg'), dataBase64: btoa(binary) };
}

export function App() {
  const [state, setState] = useState<PlaygroundState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/state');
        if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
        const next = (await res.json()) as PlaygroundState;
        if (!stop) {
          setState(next);
          setError(null);
        }
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      }
      if (!stop) setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, []);

  const call = (path: string) =>
    void fetch(path, { method: 'POST' })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  const act = (input: OwnerInput | Promise<OwnerInput>) =>
    void Promise.resolve(input)
      .then(post)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  return (
    <div className="layout">
      <header className="top">
        <strong>Postly</strong>
        <span className="tag">{state?.mode === 'sandbox' ? 'ארגז חול dev · סימולטורים בלבד' : 'מגרש משחקים · סימולטורים בלבד'}</span>
        {!state && <span className="tag">מפעיל את מסד הנתונים…</span>}
        {state && error && <span className="error">{error}</span>}
        {state?.mode === 'sandbox' && (
          // In the header, so it is on screen on a phone too; the earlier chat stays until it is pressed.
          <button
            type="button"
            className="sign-up"
            data-testid="sign-up"
            onClick={() => {
              if (window.confirm('להתחיל הרשמה חדשה מהמספר הזה? השיחה הנוכחית והפיד יתרוקנו.')) call('/api/sign-up');
            }}
          >
            הרשמה חדשה מהמספר הזה
          </button>
        )}
      </header>
      <Chat messages={state?.messages ?? []} ready={!!state} onSend={act} handoff={!!state?.conversation?.handoff} />
      <Feed feed={state?.feed} />
      <StatePanel
        state={state}
        onPublishDue={() => call('/api/publish-due')}
        onPublishNow={() => call('/api/publish-now')}
        onConnect={() => call('/api/connect')}
      />
    </div>
  );
}

type Send = (input: OwnerInput | Promise<OwnerInput>) => void;

/** How long after the owner's last message the chat shows Postly typing, unless she answered or a person took over. */
const TYPING_FOR_MS = 3 * 60 * 1000;

function Chat({ messages, ready, onSend, handoff }: { messages: ChatMessage[]; ready: boolean; onSend: Send; handoff: boolean }) {
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);
  const last = messages.at(-1);
  const typing = !handoff && last?.direction === 'from_owner' && Date.now() - Date.parse(last.at) < TYPING_FOR_MS;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onSend({ kind: 'text', text });
    setText('');
  };
  const upload = (kind: 'image' | 'voice') => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onSend(fileInput(file, kind));
    e.target.value = '';
  };

  return (
    <section className="chat" data-testid="chat">
      <div className="chat-head">
        <div className="avatar">P</div>
        <div>
          <div className="chat-title">Postly</div>
          <div className="chat-sub">אתם בעלי העסק</div>
        </div>
      </div>
      <div className="chat-body">
        {messages.length === 0 && <div className="hint">כתבו הודעה כדי להתחיל. נסו גם «כפתורים», תמונה או הקלטה.</div>}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.direction}`} data-testid={`bubble-${m.direction}`}>
            {m.media?.mimeType === 'image' && <img src={m.media.url} alt="" />}
            {m.media?.mimeType === 'audio' && <audio controls src={m.media.url} />}
            {m.text && <div className="text">{m.text}</div>}
            {m.buttons && (
              <div className="buttons">
                {m.buttons.map((b) => (
                  <button key={b.id} type="button" onClick={() => onSend({ kind: 'button', buttonId: b.id })}>
                    {b.title}
                  </button>
                ))}
              </div>
            )}
            <time>{new Date(m.at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}</time>
          </div>
        ))}
        {typing && (
          <div className="bubble to_owner typing" data-testid="typing" aria-live="polite">
            פוסטלי מקלידה…
          </div>
        )}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={submit}>
        <label className="attach" title="תמונה">
          📷
          <input data-testid="upload-image" type="file" accept="image/*" hidden onChange={upload('image')} />
        </label>
        <label className="attach" title="הודעה קולית (קובץ שמע)">
          🎤
          <input data-testid="upload-voice" type="file" accept="audio/*" hidden onChange={upload('voice')} />
        </label>
        <input className="type" placeholder="הקלידו הודעה" value={text} disabled={!ready} onChange={(e) => setText(e.target.value)} />
        <button className="send" type="submit" disabled={!ready} aria-label="שליחה">
          ➤
        </button>
      </form>
    </section>
  );
}

function Feed({ feed }: { feed: PlaygroundState['feed'] | undefined }) {
  const [network, setNetwork] = useState<'instagram' | 'facebook'>('instagram');
  const posts: FeedPost[] = feed?.[network] ?? [];
  return (
    <section className="feed" data-testid="feed">
      <div className="tabs">
        <button type="button" className={network === 'instagram' ? 'on' : ''} onClick={() => setNetwork('instagram')}>
          Instagram ({feed?.instagram.length ?? 0})
        </button>
        <button type="button" className={network === 'facebook' ? 'on' : ''} onClick={() => setNetwork('facebook')}>
          Facebook ({feed?.facebook.length ?? 0})
        </button>
      </div>
      <div className="posts">
        {posts.length === 0 && <div className="hint">עוד לא הגיע לכאן אף פוסט.</div>}
        {posts.map((p) => (
          <article key={p.id} className={`post ${network}`} data-testid="feed-post">
            <div className="post-head">
              <div className="avatar small">ע</div>
              <strong>העסק של המגרש</strong>
              <span className={`status ${p.status}`}>{p.status}</span>
            </div>
            {p.images.map((src) => (
              <img key={src} src={src} alt="" />
            ))}
            <p>{p.caption}</p>
            <time>{new Date(p.scheduledFor).toLocaleString('he-IL')}</time>
          </article>
        ))}
      </div>
    </section>
  );
}

function StatePanel({
  state,
  onConnect,
  onPublishDue,
  onPublishNow,
}: {
  state: PlaygroundState | null;
  onConnect: () => void;
  onPublishDue: () => void;
  onPublishNow: () => void;
}) {
  if (!state) {
    return (
      <aside className="state" data-testid="state">
        טוען…
      </aside>
    );
  }
  return (
    <aside className="state" data-testid="state">
      <h3>עסק</h3>
      <dl>
        <dt>שם</dt>
        <dd>{state.business.name}</dd>
        <dt>מספר המאשר</dt>
        <dd dir="ltr">{state.owner}</dd>
        <dt>מצב</dt>
        <dd className="code" data-testid="business-status">{state.business.status}</dd>
      </dl>
      <h3>שיחה</h3>
      <dl>
        <dt>שלב</dt>
        <dd className="code" data-testid="conversation-step">{state.conversation?.step ?? '—'}</dd>
        <dt>העברה לנציג</dt>
        <dd>{state.conversation?.handoff ? 'כן' : 'לא'}</dd>
      </dl>
      <h3>רשתות</h3>
      <dl>
        {state.channels.map((c) => (
          <div key={c.network} className="row">
            <dt>{c.network}</dt>
            <dd className="code" data-testid={`channel-${c.network}`}>{c.status}</dd>
          </div>
        ))}
      </dl>
      {state.connectionLinkSent && (
        <button type="button" className="connect" data-testid="connect-networks" onClick={onConnect}>
          חיבור הרשתות בסימולטור
        </button>
      )}
      <h3>פוסטים ({state.posts.length})</h3>
      <ul>
        {state.posts.map((p) => (
          <li key={p.id} data-testid="post-status">
            <span className="code">{p.status}</span> · {p.format}
          </li>
        ))}
      </ul>
      {state.payment && (
        <>
          <h3>תשלום</h3>
          <dl>
            <dt>מצב</dt>
            <dd className="code" data-testid="payment-status">{state.payment.status}</dd>
          </dl>
          <a className="connect" data-testid="open-checkout" href={`/checkout/${state.payment.customerId}`} target="_blank" rel="noreferrer">
            לדף התשלום המדומה
          </a>
        </>
      )}
      {state.mode === 'sandbox' && state.posts.some((p) => p.status === 'scheduled') && (
        <>
          <button type="button" className="connect" data-testid="publish-now" onClick={onPublishNow}>
            פרסום המתוזמנים עכשיו (dev)
          </button>
          <p className="clock" data-testid="publish-now-note">
            מקדים את הפוסטים המתוזמנים לעכשיו; ה-worker מפרסם אותם תוך דקה בערך.
          </p>
        </>
      )}
      {state.mode !== 'sandbox' && state.posts.some((p) => p.status === 'scheduled') && (
        <button type="button" className="connect" data-testid="publish-due" onClick={onPublishDue}>
          קפיצה בזמן ופרסום המתוזמנים
        </button>
      )}
      <p className="clock">
        שעון: <span dir="ltr">{new Date(state.clock).toLocaleString('he-IL')}</span>
      </p>
      <h3>תור הבדיקה ({state.reviewQueue.filter((i) => i.status === 'open').length})</h3>
      <ul>
        {state.reviewQueue.map((i) => (
          <li key={i.id}>
            <span className="code">{i.kind}</span> · {i.status}
          </li>
        ))}
      </ul>
    </aside>
  );
}

/** The dev sandbox's mock checkout for a payment link (WP-51): the provider's page, simulated. */
export function Checkout({ customerId }: { customerId: string }) {
  const [current, setCurrent] = useState<CheckoutState | null>(null);
  const [result, setResult] = useState<string>('');
  useEffect(() => {
    void fetch(`/api/checkout/${encodeURIComponent(customerId)}`)
      .then(async (res) => (res.ok ? setCurrent((await res.json()) as CheckoutState) : setResult((await res.json()).error ?? res.statusText)))
      .catch((e: unknown) => setResult(String(e)));
  }, [customerId]);
  const act = (outcome: CheckoutOutcome) =>
    void fetch(`/api/checkout/${encodeURIComponent(customerId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome }),
    })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? res.statusText);
        setResult(`${body.status} (webhook ${body.webhookStatus})`);
        setCurrent((c) => c && { ...c, status: body.status });
      })
      .catch((e: unknown) => setResult(e instanceof Error ? e.message : String(e)));
  return (
    <main className="checkout" dir="ltr">
      <h1>Mock checkout</h1>
      <p>Simulated payment provider, dev only. No card, no money.</p>
      <dl>
        <dt>Plan</dt>
        <dd>Postly basic</dd>
        <dt>Customer</dt>
        <dd className="code">{customerId}</dd>
        <dt>Status</dt>
        <dd className="code" data-testid="checkout-status">{current?.status ?? '…'}</dd>
      </dl>
      <div className="actions">
        <button type="button" onClick={() => act('pay')}>Pay</button>
        <button type="button" onClick={() => act('fail')}>Fail</button>
        <button type="button" onClick={() => act('cancel')}>Cancel</button>
      </div>
      <p data-testid="checkout-result">{result}</p>
    </main>
  );
}
