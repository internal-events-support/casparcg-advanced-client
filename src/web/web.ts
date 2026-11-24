// The web interface: control the open rundowns and channels from a browser. No editing here.
interface It { id: string; type: string; label: string; name: string; device: string; channel: number; layer: number; color?: string; secs: number; missing: boolean; auto: boolean; loop: boolean; items?: It[] }
interface Lay { producer: string; name: string; pos: number; start: number; end: number; paused: boolean; loop: boolean; next: string }
interface Dk { device: string; channel: number; layer: number; playlistId: string; label: string; index: number; count: number; loop: boolean; manual?: boolean; queued: number | null }
interface St { devices: { name: string; connected: boolean; channels: string[] }[]; layers: Record<string, Lay>; decks: Dk[]; items: Record<string, { state: string; used: boolean }> }
interface At { device: string; channel: number; layer: number }

type Kid = Node | string | null | undefined | false;
function h(tag: string, attrs: Record<string, unknown> | null = null, ...kids: Kid[]): HTMLElement {
  const [name, ...cls] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (cls.length) el.className = cls.join(' ');
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  el.append(...kids.filter((x): x is Node | string => !!x));
  return el;
}
const D: Record<string, string> = {
  stop: 'M5 5h14v14H5z', play: 'M6 4l14 8-14 8z', pause: 'M6 4h4v16H6zM14 4h4v16h-4z', next: 'M4 4l11 8-11 8zM17 4h3v16h-3z', prev: 'M20 4 9 12l11 8zM4 4h3v16H4z',
  load: 'M11 3h2v9l3-3 1.4 1.4L12 16l-5.4-5.6L8 9l3 3zM4 18h16v3H4z', back: 'M11 6v12l-8-6zM21 6v12l-8-6z', fwd: 'M3 6l8 6-8 6zM13 6l8 6-8 6z', fold: 'M5 8l7 8 7-8z', take: 'M4 8h11V4l6 6-6 6v-4H4z',
};
function ico(n: string): SVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', D[n]);
  s.append(p);
  return s;
}
const clock = (s: number): string => {
  const n = Math.max(0, Math.ceil(s - 0.05));
  const p = (x: number) => String(x).padStart(2, '0');
  return n >= 3600 ? `${Math.floor(n / 3600)}:${p(Math.floor((n % 3600) / 60))}:${p(n % 60)}` : `${p(Math.floor(n / 60))}:${p(n % 60)}`;
};
const short = (n: string) => n.replace(/\\/g, '/').split('/').pop() ?? '';
const keep = {
  get: (k: string) => { try { return localStorage.getItem('vt.' + k) ?? ''; } catch { return ''; } },
  set: (k: string, v: string) => { try { localStorage.setItem('vt.' + k, v); } catch { /* not kept */ } },
};

const app = document.getElementById('app')!;
let docs: { id: string; name: string; items: It[] }[] = [];
let skip = 5;
let st: St | null = null;
let doc = '';
let sel = '';
let tab = keep.get('tab') === 'channels' ? 'channels' : 'rundown';
const shut = new Set<string>();

function toast(text: string): void {
  document.querySelector('.toast')?.remove();
  const t = h('div.toast.bad', null, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 4500);
}
const post = (path: string, body: unknown) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VT': '1' }, body: JSON.stringify(body) });
async function act(body: unknown): Promise<void> {
  try {
    const r = await post('/do', body);
    if (r.status === 401) return login();
    const j = (await r.json()) as { ok: boolean; text: string };
    if (!j.ok) toast(j.text);
  } catch { toast('Not sent: no connection'); }
}

// ---- sign in --------------------------------------------------------------------------------------------
function login(msg = ''): void {
  es?.close();
  es = null;
  const bad = h('div.bad', null, msg);
  const i = h('input', { inputMode: 'numeric', autocomplete: 'off', maxLength: 12, 'aria-label': 'Access code' }) as HTMLInputElement;
  const go = async (code: string) => {
    if (!code) return;
    try {
      const r = await post('/login', { code });
      if (r.ok) return start();
      bad.textContent = await r.text();
      i.select();
    } catch { bad.textContent = 'No connection'; }
  };
  i.addEventListener('input', () => { if (i.value.trim().length === 6) void go(i.value.trim()); });
  i.addEventListener('keydown', (e) => { if (e.key === 'Enter') void go(i.value.trim()); });
  app.replaceChildren(h('div.login', null, h('h1', null, 'CasparCG Client'), h('p', null, 'Enter the access code from Settings, Web Interface'), i, bad, h('button.primary', { onclick: () => void go(i.value.trim()) }, 'Connect')));
  i.focus();
}

// ---- rundown ----------------------------------------------------------------------------------------------
interface Row { it: It; parent: It | null; el: HTMLElement; badge: HTMLElement; time: HTMLElement; bar: HTMLElement; was: string }
let rows: Row[] = [];
const NAMES: Record<string, string> = { MOVIE: 'Video', STILL: 'Image', AUDIO: 'Audio', TEMPLATE: 'Template', HTML: 'Web page', PLAYLIST: 'Playlist', GROUP: 'Group', CGTAKE: 'Take', SHELL: 'Command' };
const COLOR: Record<string, string> = { PLAYLIST: '#bf5af2', GROUP: '#4673c3', MOVIE: '#b9b06b', STILL: '#b8922f', TEMPLATE: '#6b8e23', CGTAKE: '#c0504d', HTML: '#2e8b57' };
const cur = () => docs.find((d) => d.id === doc) ?? docs[0];
function find(id: string): { it: It; parent: It | null } | null {
  for (const d of docs) {
    for (const i of d.items) {
      if (i.id === id) return { it: i, parent: null };
      for (const c of i.items ?? []) if (c.id === id) return { it: c, parent: i };
    }
  }
  return null;
}
const main = h('main');
const title = h('b');
const under = h('span');
const K: Record<string, HTMLButtonElement> = {};
const key = (a: string, label: string, ic: string, cls = '') => (K[a] = h(`button${cls}`, { onclick: () => { if (sel) void act({ kind: 'item', id: sel, action: a }); } }, ico(ic), h('span', null, label)) as HTMLButtonElement);
const footer = h('footer', null, h('div.now', null, title, under), h('div.keys', null, key('stop', 'Stop', 'stop'), key('play', 'Play', 'play', '.go'), key('load', 'Load', 'load'), key('pause', 'Pause', 'pause'), key('prev', 'Prev', 'prev'), key('back', 'Back', 'back'), key('forward', 'Forward', 'fwd'), key('next', 'Next', 'next')));

function renderRundown(): void {
  const top = main.scrollTop;
  rows = [];
  const d = cur();
  const out: HTMLElement[] = [];
  const one = (it: It, parent: It | null) => {
    if (it.type === 'SEPARATOR') { out.push(h('div.row.sep', null, it.label)); return; }
    const badge = h('span.badge');
    const time = h('span.time');
    const bar = h('i');
    const fold = it.items ? h(`button.fold${shut.has(it.id) ? '.shut' : ''}`, { 'aria-label': 'Open or close', onclick: (e: Event) => { e.stopPropagation(); if (shut.has(it.id)) shut.delete(it.id); else shut.add(it.id); renderRundown(); } }, ico('fold')) : null;
    const total = it.items ? it.items.reduce((a, c) => a + c.secs, 0) : it.secs;
    const sub = [NAMES[it.type] ?? '', parent?.type === 'PLAYLIST' || ['GROUP', 'CGTAKE', 'SHELL'].includes(it.type) ? '' : `${it.channel}-${it.layer}`, it.items ? `${it.items.length} ${it.type === 'PLAYLIST' ? 'clips' : 'items'}` : '', total && it.type !== 'GROUP' ? clock(total) : '', it.type === 'PLAYLIST' ? (it.loop ? 'loops' : it.auto ? '' : 'waits for Next') : ''].filter(Boolean).join('  ·  ');
    const el = h(`div.row${it.items ? '.box' : ''}${parent ? '.kid' : ''}${it.missing ? '.gone' : ''}`, { onclick: () => { sel = it.id; paint(); } }, fold, h('div.txt', null, h('div.name', null, it.label || NAMES[it.type] || it.type), h('div.sub', null, sub)), it.missing ? h('span.badge.missing', null, 'MISSING') : null, badge, time, h('div.prog', null, bar));
    el.style.setProperty('--c', it.color || COLOR[parent?.type ?? it.type] || '#666');
    rows.push({ it, parent, el, badge, time, bar, was: '' });
    out.push(el);
    if (it.items && !shut.has(it.id)) for (const c of it.items) one(c, it);
  };
  for (const i of d?.items ?? []) one(i, null);
  if (!out.length) out.push(h('div.empty', null, docs.length ? 'This rundown is empty' : 'No rundown is open in CasparCG Client'));
  main.replaceChildren(...out);
  main.scrollTop = top;
  paint();
}
function left(it: It): { t: number; pct: number; l: Lay } | null {
  const f = find(it.id);
  const pl = it.type === 'PLAYLIST' ? it : f?.parent?.type === 'PLAYLIST' ? f.parent : null;
  const dk = pl ? st!.decks.find((d) => d.playlistId === pl.id) : null;
  const l = st!.layers[dk ? `${dk.device}|${dk.channel}-${dk.layer}` : `${it.device}|${it.channel}-${it.layer}`];
  return l?.end ? { t: Math.max(0, l.end - l.pos), pct: ((l.pos - l.start) / Math.max(0.01, l.end - l.start)) * 100, l } : null;
}
/** Time left on a whole playlist or group. */
function whole(it: It): string {
  const kids = (it.items ?? []).filter((c) => c.type === 'MOVIE' || c.type === 'AUDIO');
  const rest = (a: It[]) => a.reduce((n, c) => n + c.secs, 0);
  if (it.type === 'PLAYLIST') {
    const dk = st!.decks.find((d) => d.playlistId === it.id);
    const n = dk && st!.items[it.id]?.state ? left(it) : null;
    return dk && n ? clock(n.t + rest(kids.filter((c) => c.type === 'MOVIE').slice(dk.index + 1))) : '';
  }
  const on = kids.map((c) => ({ c, n: st!.items[c.id]?.state ? left(c) : null })).filter((x) => x.n);
  if (!on.length || on.some((x) => x.n!.l.loop)) return '';
  const last = on[on.length - 1];
  return clock(it.auto ? last.n!.t + rest(kids.slice(kids.indexOf(last.c) + 1)) : Math.max(...on.map((x) => x.n!.t)));
}
function paint(): void {
  if (!st) return;
  if (tab === 'channels') return paintChannels();
  for (const r of rows) {
    const s = st.items[r.it.id];
    let badge = s?.state ?? '';
    let time = '';
    let pct = 0;
    if (r.it.items) time = whole(r.it);
    if (badge && (r.it.type === 'MOVIE' || r.it.type === 'AUDIO' || r.it.type === 'PLAYLIST')) {
      const n = left(r.it);
      if (n) {
        pct = Math.round(n.pct * 2) / 2;
        if (!r.it.items) time = clock(n.t);
        if (badge === 'playing' && !n.l.loop && n.t <= 0.05) badge = 'end';
      }
    } else if (r.parent?.type === 'PLAYLIST' && !badge) {
      const dk: Dk | undefined = st.decks.find((d) => d.playlistId === r.parent!.id);
      const nx: number | null = !dk || !st.items[r.parent.id]?.state ? null : dk.manual ? (dk.index + 1 < dk.count ? dk.index + 1 : dk.loop ? 0 : null) : dk.queued;
      if (nx !== null && nx !== dk?.index && r.parent.items!.filter((c) => c.type === 'MOVIE')[nx]?.id === r.it.id) badge = 'next';
    }
    const was = `${badge}|${time}|${pct}|${sel === r.it.id}`;
    if (was === r.was) continue;
    r.was = was;
    r.badge.textContent = { loaded: 'CUED', playing: 'PLAY', paused: 'PAUSE', end: 'END', next: 'NEXT' }[badge] ?? '';
    r.badge.className = `badge ${badge}`;
    r.time.textContent = time;
    r.bar.style.width = `${pct}%`;
    r.el.classList.toggle('on', !!s?.state);
    r.el.classList.toggle('sel', sel === r.it.id);
  }
  const f = sel ? find(sel) : null;
  const pl = !!f && (f.it.type === 'PLAYLIST' || f.parent?.type === 'PLAYLIST');
  const timed = !!f && (pl || ['MOVIE', 'AUDIO'].includes(f.it.type) || (f.it.type === 'GROUP' && f.it.auto));
  const on = (a: string, v: boolean) => { if (K[a].disabled === v) K[a].disabled = !v; };
  on('stop', !!f);
  on('play', !!f);
  on('load', !!f && !['CGTAKE', 'SHELL'].includes(f.it.type));
  on('pause', timed);
  on('back', timed);
  on('forward', timed);
  on('prev', pl);
  on('next', pl || f?.it.type === 'TEMPLATE' || (f?.it.type === 'GROUP' && f.it.auto));
  const put = (el: Element, t: string) => { if (el.textContent !== t) el.textContent = t; };
  put(K.pause.lastElementChild!, f && st.items[f.it.id]?.state === 'paused' ? 'Resume' : 'Pause');
  put(K.back.lastElementChild!, `−${skip} s`);
  put(K.forward.lastElementChild!, `+${skip} s`);
  put(title, f ? f.it.label : 'Tap an entry');
  put(under, f ? [NAMES[f.it.type] ?? '', whole(f.it) && `${whole(f.it)} left`].filter(Boolean).join('  ·  ') : '');
}

// ---- channels ----------------------------------------------------------------------------------------------
let chSig = '';
let lays: { k: string; at: At; name: HTMLElement; sub: HTMLElement; time: HTMLElement; badge: HTMLElement; bar: HTMLElement; play: HTMLElement; steps: HTMLButtonElement[]; was: string }[] = [];
function paintChannels(): void {
  const s = st!;
  const sig = JSON.stringify([s.devices, Object.keys(s.layers).sort()]);
  if (sig !== chSig) {
    chSig = sig;
    lays = [];
    const top = main.scrollTop;
    main.replaceChildren(...s.devices.flatMap((d) => d.channels.map((fmt, n) => {
      const ks = Object.keys(s.layers).filter((k) => k.startsWith(`${d.name}|${n + 1}-`)).map((k) => Number(k.split('-').pop())).sort((a, b) => a - b);
      return h('section.card', null, h('h2', null, `${s.devices.length > 1 ? `${d.name} ` : ''}Channel ${n + 1}`, h('small', null, fmt)), ...ks.map((layer) => {
        const at = { device: d.name, channel: n + 1, layer };
        const b = (v: string, ic: string, label: string) => h('button', { title: label, 'aria-label': label, onclick: () => void act({ kind: 'transport', at, verb: v }) }, ico(ic)) as HTMLButtonElement;
        const x = { k: `${d.name}|${n + 1}-${layer}`, at, name: h('div.name'), sub: h('div.sub'), time: h('span.time'), badge: h('span.badge'), bar: h('i'), play: b('toggle', 'play', 'Play or pause'), steps: [b('prev', 'prev', 'Previous clip'), b('next', 'next', 'Next clip')], was: '' };
        lays.push(x);
        return h('div.lay', null, h('span.no', null, String(layer)), h('div.txt', null, x.name, x.sub), x.badge, x.time, h('div.btns', null, x.steps[0], b('back', 'back', 'Back'), x.play, b('forward', 'fwd', 'Forward'), x.steps[1], b('stop', 'stop', 'Stop'), h('button', { title: 'Take to another channel', 'aria-label': 'Take to another channel', onclick: () => takeSheet(at) }, ico('take'))), h('div.prog', null, x.bar));
      }), ks.length ? null : h('div.lay', null, h('div.sub', null, 'Empty')));
    })));
    main.scrollTop = top;
  }
  for (const x of lays) {
    const l = s.layers[x.k];
    if (!l) continue;
    const dk = s.decks.find((d) => d.device === x.at.device && d.channel === x.at.channel && d.layer === x.at.layer);
    const t = l.end ? Math.max(0, l.end - l.pos) : 0;
    const state = !l.end ? '' : !l.loop && t <= 0.05 ? 'end' : l.paused ? (l.pos - l.start < 0.1 ? 'loaded' : 'paused') : 'playing';
    const pct = l.end ? Math.round(((l.pos - l.start) / Math.max(0.01, l.end - l.start)) * 200) / 2 : 0;
    const name = l.name ? short(l.name) : ({ html: 'Web page', route: 'Route', color: 'Colour', image: 'Image', ndi: 'NDI source', decklink: 'DeckLink input' }[l.producer] ?? l.producer);
    const sub = [dk && `${dk.label} ${dk.index + 1}/${dk.count}`, l.next && `Next: ${short(l.next)}`].filter(Boolean).join('  ·  ');
    const was = [state, name, sub, l.end ? clock(t) : '', pct].join('|');
    if (was === x.was) continue;
    x.was = was;
    x.name.textContent = name;
    x.sub.textContent = sub;
    x.time.textContent = l.end ? clock(t) : '';
    x.badge.textContent = { playing: 'PLAY', paused: 'PAUSE', loaded: 'CUED', end: 'END', '': '' }[state]!;
    x.badge.className = `badge ${state}`;
    x.bar.style.width = `${pct}%`;
    x.play.replaceChildren(ico(state === 'playing' ? 'pause' : 'play'));
    for (const b of x.steps) b.disabled = !dk;
  }
}
function takeSheet(from: At): void {
  const n = st!.devices.find((d) => d.name === from.device)?.channels.length ?? 1;
  const ch = h('select', { 'aria-label': 'Channel' }, ...[...Array(n)].map((_, k) => h('option', { value: String(k + 1), selected: k + 1 === (from.channel === 1 ? 2 : 1) }, `Channel ${k + 1}`))) as HTMLSelectElement;
  const ly = h('input', { type: 'number', value: String(from.layer), min: '0', max: '9998', 'aria-label': 'Layer' }) as HTMLInputElement;
  const fade = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const roll = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const close = () => s.remove();
  const s = h('div.sheet', { onclick: (e: Event) => { if (e.target === s) close(); } }, h('div', null, h('h3', null, `Take ${from.channel}-${from.layer} to`), h('label', null, ch, 'layer', ly), h('label', null, fade, 'Fade'), h('label', null, roll, 'Play when taken'),
    h('div.acts', null, h('button', { onclick: close }, 'Cancel'), h('button.primary', { onclick: () => { close(); void act({ kind: 'take', from, to: { device: from.device, channel: Number(ch.value), layer: Number(ly.value) }, fade: fade.checked, roll: roll.checked }); } }, 'Take'))));
  document.body.append(s);
}

// ---- page ---------------------------------------------------------------------------------------------------
let es: EventSource | null = null;
const dot = h('span.dot');
const pick = h('select', { 'aria-label': 'Rundown', onchange: () => { doc = pick.value; keep.set('name', cur()?.name ?? ''); sel = ''; renderRundown(); } }) as HTMLSelectElement;
const lost = h('div.lost', { hidden: true }, 'No connection to CasparCG Client. Trying again…');
const tabs = ['rundown', 'channels'].map((t) => h('button', { onclick: () => show(t) }, t === 'rundown' ? 'Rundown' : 'Channels'));
function show(t: string): void {
  tab = t;
  keep.set('tab', t);
  tabs.forEach((b, n) => b.classList.toggle('on', (n === 1) === (t === 'channels')));
  footer.hidden = pick.hidden = t === 'channels';
  chSig = '';
  main.scrollTop = 0;
  if (t === 'channels') { main.replaceChildren(); paint(); } else renderRundown();
}
function start(): void {
  app.replaceChildren(h('header', null, dot, pick, h('div.tabs', null, ...tabs)), lost, main, footer);
  show(tab);
  es?.close();
  const e = (es = new EventSource('/events'));
  let opened = false;
  e.onopen = () => { opened = true; lost.hidden = true; };
  e.addEventListener('docs', (m) => {
    const j = JSON.parse((m as MessageEvent<string>).data) as { skip: number; docs: typeof docs };
    docs = j.docs;
    skip = j.skip;
    if (!docs.some((d) => d.id === doc)) doc = (docs.find((d) => d.name === keep.get('name')) ?? docs[0])?.id ?? '';
    if (sel && !find(sel)) sel = '';
    pick.replaceChildren(...docs.map((d) => h('option', { value: d.id, selected: d.id === doc }, d.name)));
    if (tab === 'rundown') renderRundown();
  });
  e.addEventListener('state', (m) => {
    st = JSON.parse((m as MessageEvent<string>).data) as St;
    dot.className = `dot ${st.devices.every((d) => d.connected) ? 'ok' : ''}`;
    dot.title = st.devices.map((d) => `${d.name}: ${d.connected ? 'connected' : 'not connected'}`).join('\n');
    paint();
  });
  e.onerror = () => {
    // A dropped connection retries by itself; being refused (not signed in) closes the stream.
    if (e.readyState !== EventSource.CLOSED) { lost.hidden = false; return; }
    if (es !== e) return;
    const again = () => { lost.hidden = false; setTimeout(() => { if (es === e) start(); }, 2000); };
    if (opened) return again();
    fetch('/check').then((r) => (r.status === 401 ? login() : again()), again);
  };
}
// "Open here" in Settings passes the code after the #, which is never sent to a server.
const code = location.hash.slice(1);
if (code) {
  history.replaceState(null, '', '/');
  post('/login', { code }).then((r) => (r.ok ? start() : login('That code is out of date')), () => login('No connection'));
} else start();
