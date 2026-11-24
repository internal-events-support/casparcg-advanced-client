// App shell: unified top bar, library | tabs | preview + inspector, bottom bar, and keyboard.
import type { Action, AppState, Doc, Library, LogLine, Settings } from '../shared/types';
import { buildInspector } from './inspector';
import { button, confirmSheet, h, icon, popover, segmented, textField, toggle } from './kit';
import { buildLibrary } from './library';
import { buildChannels } from './channels';
import { buildPreview, previewToggle } from './preview';
import { buildRundown, closeDoc, setCollapsed } from './rundown';
import { activate, call, copy, doc, duplicate, emit, execute, homeDevice, moveSelection, newDoc, on, openFiles, paste, removeSelected, save, store, sync, toast, undo, ungroup, visible, vt, wrap } from './store';

type Tab = 'rundown' | 'channels' | 'activity';
let tab: Tab = 'rundown';
const hosts = new Map<Tab, HTMLElement>();
let nav: ReturnType<typeof segmented>;
function showTab(t: Tab): void {
  tab = t;
  nav.set(t);
  for (const [k, el] of hosts) el.hidden = k !== t;
}

// ---- top bar ----------------------------------------------------------------------------------------------
function topBar(): HTMLElement {
  nav = segmented([{ value: 'rundown', label: 'Rundown' }, { value: 'channels', label: 'Channels' }, { value: 'activity', label: 'Activity' }], tab, (v) => showTab(v as Tab));
  const dot = h('span.dot');
  const label = h('span', 'Connecting');
  const pill = h('button.btn.pill.conn', dot, label) as HTMLButtonElement;
  pill.addEventListener('click', () => {
    const s = store.state;
    if (!s) return;
    const rows = s.devices.map((d) => h('div.group-row', h(`span.dot.${d.connected ? 'ok' : 'bad'}`), h('div.grow', h('div', d.name), h('div.caption', d.connected ? `CasparCG ${d.version}  ·  ${d.channels.length} channels` : d.error || 'Connecting'))));
    const svc = ([['HTTP remote', s.services.http], ['OSC remote', s.services.osc], ['Countdown feed', s.services.countdown]] as const).map(([n, v]) => h('div.group-row', h(`span.dot.${v.startsWith('On') ? 'ok' : v === 'Off' ? '' : 'warn'}`), h('div.grow', n), h('span.caption', v)));
    popover(pill, h('div.conn-pop', h('div.group', ...rows), h('div.group', ...svc)), { width: 330, align: 'start' });
  });
  on('state', () => {
    const ds = store.state!.devices;
    const up = ds.filter((d) => d.connected).length;
    dot.className = `dot ${up === ds.length ? 'ok' : up ? 'warn' : 'bad'}`;
    label.textContent = ds.length === 1 ? (up ? ds[0].name : 'Not connected') : `${up} of ${ds.length} servers`;
  });
  const settings = h('button.btn.pill', icon('gear'), 'Settings') as HTMLButtonElement;
  settings.addEventListener('click', () => void call('openSettings'));
  return h('header.topbar', h('div.left', h('span.app-title', 'Caspar VT'), pill), h('div.center', nav.el), h('div.right', settings));
}

// ---- activity ---------------------------------------------------------------------------------------------
function buildActivity(): HTMLElement {
  const list = h('div.s-log-list');
  let only = false;
  let follow = true;
  const time = (t: number) => new Date(t).toLocaleTimeString('en-GB') + '.' + String(t % 1000).padStart(3, '0');
  const add = (l: LogLine) => {
    if (only && l.dir !== 'err') return;
    list.append(h(`div.s-log-row.lv-${l.dir === 'err' ? 'error' : l.dir === 'in' ? 'verbose' : 'info'}`, h('span.t', time(l.t)), h('span.g', l.device), h('span.l', { out: 'Sent', in: 'Reply', info: 'Info', err: 'Problem' }[l.dir]), h('span.m', l.text)));
    while (list.children.length > 800) list.firstElementChild!.remove();
    if (follow) list.scrollTop = list.scrollHeight;
  };
  const all = () => { list.textContent = ''; follow = false; store.logs.forEach(add); follow = true; list.scrollTop = list.scrollHeight; };
  // Stay on the newest line unless scrolled back; a hidden or resized list loses its place, so put it back.
  let height = 0;
  list.addEventListener('scroll', () => { if (list.clientHeight && list.clientHeight === height) follow = list.scrollTop + height > list.scrollHeight - 40; });
  new ResizeObserver(() => { height = list.clientHeight; if (height && follow) list.scrollTop = list.scrollHeight; }).observe(list);
  const hist: string[] = [];
  let hi = 0;
  const cmd = textField('', () => undefined, { placeholder: 'Send a command to the server, e.g. INFO 1', cls: 'cmd' });
  cmd.el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && hist.length) { hi = Math.max(0, hi - 1); cmd.el.value = hist[hi]; e.preventDefault(); }
    if (e.key === 'ArrowDown' && hist.length) { hi = Math.min(hist.length, hi + 1); cmd.el.value = hist[hi] ?? ''; e.preventDefault(); }
    if (e.key !== 'Enter' || !cmd.el.value.trim()) return;
    e.stopImmediatePropagation();
    const c = cmd.el.value.trim();
    hist.push(c);
    hi = hist.length;
    cmd.el.value = '';
    void call<string[]>('raw', homeDevice(), c).then((r) => { for (const l of (r ?? []).slice(0, 200)) add({ t: Date.now(), dir: 'in', device: '', text: l }); });
  });
  vt.on('log', ((l: LogLine) => { store.logs.push(l); if (store.logs.length > 1500) store.logs.splice(0, 300); add(l); }) as never);
  all();
  return h('section.s-logs', list, h('div.s-log-bar', cmd.el, h('span.spacer'), h('span.s-log-group', 'Problems only', toggle(false, (v) => { only = v; all(); }, { cls: 'sm' }).el), button('Clear', () => { store.logs = []; all(); }, 'sm')));
}

// ---- bottom bar ---------------------------------------------------------------------------------------------
function bottomBar(): HTMLElement {
  const host = h('div.bb-meters');
  let built = '';
  let sets: { key: string; bars: HTMLElement[] }[] = [];
  const title = h('h2', '');
  const sub = h('span.caption', '');
  const [c1, c2, c3, c4] = [h('span'), h('span'), h('span'), h('span')];
  on('state', () => {
    const s = store.state!;
    const d = homeDevice();
    const dev = s.devices.find((x) => x.name === d);
    const n = Math.min(8, dev?.channels.length ?? 0);
    // Audio levels, one block per channel of the first server.
    if (built !== `${d}|${n}`) {
      built = `${d}|${n}`;
      sets = [...Array(n)].map((_, k) => ({ key: `${d}|${k + 1}`, bars: [0, 1].map(() => h('i')) }));
      host.replaceChildren(...sets.map((x, k) => h('div.bb-meter', { title: `Audio on channel ${k + 1}` }, h('div.bb-bars', ...x.bars.map((b) => h('div.meter-v', b))), h('span.caption', String(k + 1)))));
    }
    for (const x of sets) x.bars.forEach((b, k) => { const v = s.audio[x.key]?.[k] ?? 0; b.style.height = `${v > 0 ? Math.max(0, Math.min(100, (20 * Math.log10(v) + 60) / 0.6)) : 0}%`; });
    const playing = Object.values(s.layers).filter((l) => l.producer !== 'empty' && l.end && !l.paused && l.end - l.pos > 0.05).length;
    title.textContent = !dev?.connected ? 'Not connected' : playing ? `${playing} clip${playing > 1 ? 's' : ''} playing` : 'Nothing playing';
    sub.textContent = s.decks.length ? s.decks.map((x) => `${x.label} ${x.index + 1}/${x.count} on ${x.channel}-${x.layer}`).join('  ·  ') : '';
    c1.textContent = `Server: ${dev?.connected ? dev.version.split(' ')[0] : 'offline'}`;
    c2.textContent = `Channels: ${dev?.channels.length ?? 0}`;
    c3.textContent = `Playlists loaded: ${s.decks.length}`;
    c4.textContent = `Remote: ${Object.values(s.services).filter((x) => x.startsWith('On')).length} of 3 on`;
  });
  return h('footer.bottombar', host, h('div.rf-title', title, sub), h('div.rf-spacer'), h('div.rf-stats', h('div.col', c1, c2), h('div.col', c3, c4)), h('div.rf-right', h('div.version', h('span', __APP_VERSION__))));
}

// ---- keyboard ---------------------------------------------------------------------------------------------------
const FKEYS: Record<string, Action> = { F1: 'stop', F2: 'play', F3: 'load', F4: 'pause', F5: 'next', F6: 'update', F7: 'invoke', F8: 'preview', F10: 'clear', F11: 'clearLayer', F12: 'clearChannel' };
async function act(a: Action): Promise<void> {
  // With no preview channel set for the server, F8 plays the clip in the local preview instead.
  if (a === 'preview' && !store.settings.devices.some((d) => d.preview > 0)) return previewToggle();
  if (a === 'clearChannel' && store.settings.confirmClear && !(await confirmSheet('Clear the whole channel?', 'Everything on this channel goes off air.', 'Clear', true))) return;
  await execute(a);
}
function keys(e: KeyboardEvent): void {
  if (document.querySelector('.sheet-layer')) return;
  const el = e.target as HTMLElement;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && (el as HTMLInputElement).type !== 'range' && (el as HTMLInputElement).type !== 'checkbox';
  const f = FKEYS[e.key];
  if (f) {
    e.preventDefault();
    if (typing) el.blur(); // commit the field first
    if (e.repeat) return;
    void act(e.shiftKey && e.key === 'F2' ? 'playNow' : e.shiftKey && e.key === 'F5' ? 'prev' : f);
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const done = () => e.preventDefault();
  if (ctrl && k === 's') { done(); void save(e.shiftKey); return; }
  if (ctrl && k === 'o') { done(); void openFiles(); return; }
  if (ctrl && k === 'n') { done(); newDoc(); return; }
  if (ctrl && k === 'w') { done(); const d = doc(); if (d) void closeDoc(d); return; }
  if (ctrl && k === 'f') { done(); (document.querySelector('#lib-search') as HTMLInputElement)?.focus(); return; }
  if (ctrl && k === ',') { done(); void call('openSettings'); return; }
  if (ctrl && e.key === 'Tab') {
    done();
    const n = store.docs.findIndex((d) => d.id === store.active);
    activate(store.docs[(n + (e.shiftKey ? -1 : 1) + store.docs.length) % store.docs.length].id);
    return;
  }
  if (typing) { if (e.key === 'Escape') el.blur(); return; }
  if (ctrl && k === 'z') { done(); undo(e.shiftKey); return; }
  if (ctrl && k === 'y') { done(); undo(true); return; }
  if (e.key === ' ') { done(); if (!e.repeat) previewToggle(); return; }
  if (tab === 'activity') return;
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { done(); void act(e.key === 'ArrowLeft' ? 'back' : 'forward'); return; }
  if (ctrl && k === 'c') { done(); copy(); return; }
  if (ctrl && k === 'x') { done(); copy(true); return; }
  if (ctrl && k === 'v') { done(); paste(); return; }
  if (ctrl && k === 'd') { done(); duplicate(); return; }
  if (ctrl && k === 'g') { done(); if (e.shiftKey) ungroup(); else wrap('GROUP'); return; }
  if (ctrl && k === 'p') { done(); wrap('PLAYLIST'); return; }
  if (ctrl && k === 'a') { done(); store.sel = new Set(visible().map((x) => x.item.id)); emit('select'); return; }
  if (ctrl && (k === '[' || k === ']')) { done(); setCollapsed(k === '['); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { done(); moveSelection(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey); return; }
  if (e.key === 'PageDown' || e.key === 'PageUp') { done(); moveSelection(e.key === 'PageDown' ? 10 : -10); return; }
  if (e.key === 'Home' || e.key === 'End') { done(); moveSelection(e.key === 'Home' ? -1e6 : 1e6); return; }
  if (e.key === 'Delete') { done(); removeSelected(); }
}

const PLAYOUT: Record<string, Action> = { Stop: 'stop', Play: 'play', 'Play Now': 'playNow', Load: 'load', 'Pause / Resume': 'pause', Next: 'next', Update: 'update', Invoke: 'invoke', Preview: 'preview', Clear: 'clear', 'Clear Video Layer': 'clearLayer', 'Clear Channel': 'clearChannel' };
const REMOTE: Record<string, Action> = { stop: 'stop', play: 'play', playnow: 'playNow', load: 'load', pause: 'pause', next: 'next', previous: 'prev', update: 'update', invoke: 'invoke', preview: 'preview', back: 'back', forward: 'forward', clear: 'clear', clearvideolayer: 'clearLayer', clearchannel: 'clearChannel' };

// ---- start ---------------------------------------------------------------------------------------------------------
async function start(): Promise<void> {
  const r = await call<{ settings: Settings; docs: Doc[]; library: Record<string, Library>; logs: LogLine[]; state: AppState; version: string }>('init');
  if (!r) return;
  Object.assign(store, { settings: r.settings, docs: r.docs, library: r.library, logs: r.logs, state: r.state, version: r.version });
  if (!store.docs.length) newDoc();
  else activate(store.docs[0].id);

  const root = document.getElementById('app')!;
  const top = topBar();
  const tabhost = h('main.tabhost');
  for (const [k, el] of [['rundown', buildRundown()], ['channels', buildChannels()], ['activity', buildActivity()]] as [Tab, HTMLElement][]) {
    el.classList.add('tab');
    hosts.set(k, el);
    tabhost.append(el);
  }
  const body = h('div.vt-body', buildLibrary(), h('div.vt-center', tabhost), h('div.vt-right', buildPreview(), buildInspector()));
  root.append(top, body, bottomBar());
  showTab('rundown');

  vt.on('state', ((s: AppState) => { store.state = s; emit('state'); }) as never);
  vt.on('library', ((n: string, l: Library) => { store.library = { ...store.library, [n]: l }; emit('library'); }) as never);
  vt.on('settings', ((s: Settings) => { store.settings = s; emit('settings'); }) as never);
  vt.on('toast', ((t: string, k: 'ok' | 'bad') => toast(t, k)) as never);
  vt.on('playout', ((c: string) => { if (PLAYOUT[c]) void execute(PLAYOUT[c]); }) as never);
  vt.on('rundown', ((v: string) => {
    if (!doc()?.allowRemote) return;
    if (v === 'down') moveSelection(1);
    else if (v === 'up') moveSelection(-1);
    else if (v === 'playandautostep' || v === 'playnowandautostep') void execute(v.startsWith('playnow') ? 'playNow' : 'play').then(() => moveSelection(1));
    else if (REMOTE[v]) void execute(REMOTE[v]);
  }) as never);
  vt.on('askquit', ((playing: string[]) => void askQuit(playing)) as never);
  document.addEventListener('keydown', keys);
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
  emit('state');
  sync();
}

async function askQuit(playing: string[]): Promise<void> {
  if (document.querySelector('.sheet-layer')) return;
  const dirty = store.docs.filter((d) => d.dirty && d.items.length);
  if (!playing.length && !dirty.length) { await call('quit'); return; }
  const done = () => layer.remove();
  const parts = [
    playing.length ? `${playing.join(', ')} ${playing.length > 1 ? 'are' : 'is'} playing. If you quit, ${playing.length > 1 ? 'each stops' : 'it stops'} after the clip that is already queued.` : '',
    dirty.length ? `${dirty.map((d) => d.name).join(', ')} ${dirty.length > 1 ? 'have' : 'has'} unsaved changes. They are kept and reopen next time.` : '',
  ].filter(Boolean);
  const layer = h('div.sheet-layer', h('div.sheet.wide', h('h3', playing.length ? 'A playlist is on air' : 'Quit Caspar VT?'), ...parts.map((p) => h('p', p)),
    h('div.actions', button('Cancel', done), playing.length ? button('Keep running hidden', () => { done(); void call('hide'); }, 'primary') : null, button('Quit', () => { done(); void call('quit'); }, playing.length ? 'danger' : 'primary'))));
  document.body.append(layer);
}

void start();
