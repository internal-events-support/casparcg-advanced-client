// Runs the client's own pages in a browser: signs in, then stands in for the app's link to its main process.
type Fn = (...a: unknown[]) => void;
interface Reply { ok: boolean; value?: unknown; error?: string; lost?: boolean }
interface Bridge { call(name: string, ...a: unknown[]): Promise<Reply>; on(name: string, fn: Fn): void; web: { local: boolean } }
const here = window as unknown as { vt?: Bridge };

function run(src: string): void {
  const s = document.createElement('script');
  s.src = src;
  document.body.append(s);
}
const el = (tag: string, cls: string, text = '') => Object.assign(document.createElement(tag), { className: cls, textContent: text });
const post = (path: string, body: unknown) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VT': '1' }, body: JSON.stringify(body) });
const id = [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---- sign in ------------------------------------------------------------------------------------------------
function login(msg = ''): void {
  document.querySelector('.login-layer')?.remove();
  const bad = el('div', 'bad', msg);
  const i = Object.assign(document.createElement('input'), { type: 'password', autocomplete: 'current-password' as AutoFill, maxLength: 64, autocapitalize: 'off', spellcheck: false });
  i.setAttribute('aria-label', 'Access code');
  const go = async () => {
    const code = i.value.trim();
    if (!code) return;
    try {
      const r = await post('/login', { code });
      if (r.ok) { location.reload(); return; }
      bad.textContent = await r.text();
      i.select();
    } catch { bad.textContent = 'No connection'; }
  };
  i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') void go(); });
  const b = el('button', 'primary', 'Connect');
  b.addEventListener('click', () => void go());
  const box = el('div', 'login');
  box.append(el('h1', '', 'CasparCG Advanced Client'), el('p', '', 'Enter the access code from Settings, Web Interface'), i, bad, b);
  const layer = el('div', 'login-layer');
  layer.append(box);
  document.body.append(layer);
  i.focus();
}

// ---- the link -------------------------------------------------------------------------------------------------
const subs = new Map<string, Fn[]>();
const lost = el('div', 'web-lost', 'No connection to the show PC. Trying again…');
lost.hidden = true;
let es: EventSource | null = null;
let seen = 0;
function connect(): void {
  es?.close();
  const e = (es = new EventSource(`/events?c=${id}`));
  e.addEventListener('vt', (m) => {
    const [name, ...args] = JSON.parse((m as MessageEvent<string>).data) as [string, ...unknown[]];
    if (name === 'hello') {
      lost.hidden = true;
      if (seen++) for (const f of subs.get('back') ?? []) f();
      return;
    }
    for (const f of subs.get(name) ?? []) f(...args);
  });
  e.onerror = () => {
    if (es !== e) return;
    lost.hidden = false;
    // A dropped connection tries again by itself; a refused one (signed out) is closed for good.
    if (e.readyState !== EventSource.CLOSED) return;
    fetch('/me').then((r) => { if (r.status === 401) login('Enter the new access code'); else setTimeout(connect, 2000); }, () => setTimeout(connect, 2000));
  };
}
const bridge = (local: boolean): Bridge => ({
  web: { local },
  on: (name, fn) => { if (!subs.has(name)) subs.set(name, []); subs.get(name)!.push(fn); },
  call: async (name, ...args) => {
    try {
      const r = await post('/call', { client: id, name, args });
      if (r.status === 401) { login('Enter the new access code'); return { ok: false, error: 'Signed out', lost: true }; }
      if (!r.ok) return { ok: false, error: await r.text() };
      return (await r.json()) as Reply;
    } catch { return { ok: false, error: 'Not sent: no connection to the show PC', lost: true }; }
  },
});

async function start(): Promise<void> {
  const page = document.body.dataset.page;
  if (page === 'settings') {
    // Inside the client: use its link. Nothing here stays subscribed once the frame closes.
    const up = (window.parent as unknown as { vt?: Bridge }).vt;
    here.vt = window.parent !== window && up ? { call: up.call, on: () => undefined, web: up.web } : undefined;
    if (!here.vt) { const r = await fetch('/me'); if (r.status === 401) { location.href = '/'; return; } here.vt = bridge(((await r.json()) as { local: boolean }).local); }
    return run('/ui/settings.js');
  }
  // "Open here" in Settings passes the code after the #, which is never sent to a server.
  let code = location.hash.slice(1);
  try { code = decodeURIComponent(code); } catch { /* as it is */ }
  if (code) {
    history.replaceState(null, '', '/');
    const r = await post('/login', { code });
    if (!r.ok) return login('That code is out of date');
  }
  const me = await fetch('/me');
  if (me.status === 401) return login();
  here.vt = bridge(((await me.json()) as { local: boolean }).local);
  document.body.append(lost);
  connect();
  run('/ui/app.js');
}
start().catch(() => login('No connection'));
