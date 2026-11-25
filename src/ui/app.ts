// App shell: top bar, tabs, status bar and keyboard. Edit has the library, preview and inspector, Show has the preview and details; the other tabs are full width.
import type { Action, AppState, DocPut, Library, LogLine, Settings, UpdateState } from '../shared/types';
import { buildInfo } from './info';
import { buildInspector } from './inspector';
import { button, confirmSheet, h, icon, iconButton, popover, segmented, textField, toggle } from './kit';
import { buildLibrary } from './library';
import { buildChannels } from './channels';
import { buildPreview, previewMode, previewKey, previewPause, previewToggle } from './preview';
import { buildRundown, closeDoc, markUsed, setCollapsed } from './rundown';
import { splitters } from './split';
import { activate, applyTemplate, call, copy, copyTemplate, doc, duplicate, emit, execute, fromOther, gotDocs, homeDevice, moveSelection, newDoc, on, openFiles, paste, touch, removeSelected, save, store, sync, toast, undo, ungroup, visible, vt, wrap } from './store';

type Tab = 'edit' | 'show' | 'channels' | 'activity';
let tab: Tab = 'edit';
let body: HTMLElement;
let columns: ReturnType<typeof splitters>;
const hosts = new Map<Tab, HTMLElement>();
let inspector: HTMLElement;
let info: HTMLElement;
let nav: ReturnType<typeof segmented>;
/** On a small screen the columns take turns. */
let panels: ReturnType<typeof segmented>;
function showPanel(p: string): void {
  body.dataset.panel = p;
  panels.set(p);
}
function showTab(t: Tab): void {
  tab = t;
  nav.set(t);
  for (const [k, el] of hosts) el.hidden = k !== t;
  body.classList.toggle('show', t === 'show');
  body.classList.toggle('wide', t !== 'edit' && t !== 'show');
  columns.apply();
  inspector.hidden = t !== 'edit';
  info.hidden = t !== 'show';
  panels.el.parentElement!.hidden = t !== 'edit' && t !== 'show';
  panels.el.querySelector<HTMLElement>('button')!.hidden = t !== 'edit'; // the library is for editing
  if (t !== 'edit' && body.dataset.panel === 'library') showPanel('rundown');
  previewPause();
  if (t === 'edit' || t === 'show') previewMode(t === 'show');
  try { if (t === 'edit' || t === 'show') localStorage.setItem('vt.tab', t); } catch { /* not kept */ }
  emit('tab');
}

// ---- top bar ----------------------------------------------------------------------------------------------
function topBar(): HTMLElement {
  nav = segmented([{ value: 'edit', label: 'Edit' }, { value: 'show', label: 'Show' }, { value: 'channels', label: 'Channels' }, { value: 'activity', label: 'Activity' }], tab, (v) => showTab(v as Tab));
  const settings = h('button.btn.pill.settings-btn', icon('gear'), h('span', 'Settings')) as HTMLButtonElement;
  settings.addEventListener('click', openSettings);
  return h('header.topbar', h('div.left', h('span.app-title', 'CasparCG Advanced Client')), h('div.center', nav.el), h('div.right', updateBtn, settings));
}

// ---- updates (in the app only) ------------------------------------------------------------------------------
const updateBtn = h('button.btn.pill', { title: 'A new version is ready to install' }, icon('download'), h('span', 'Update')) as HTMLButtonElement;
updateBtn.hidden = true;
updateBtn.addEventListener('click', () => void call('updateAsk'));
let ready = '';
function gotUpdate(u: UpdateState): void {
  updateBtn.hidden = !u.ready;
  if (u.ready && u.ready !== ready) toast(`Version ${u.ready} is ready${store.settings.autoUpdate ? '. It is installed when you quit' : ''}`);
  ready = u.ready;
}
async function askUpdate(playing: string[]): Promise<void> {
  if (!ready || document.querySelector('.sheet-layer')) return;
  const air = playing.length ? ` ${playing.join(', ')} ${playing.length > 1 ? 'are' : 'is'} playing: the clip on air and the one already queued carry on, but nothing after them until the app is back.` : ' Anything on air carries on.';
  const later = store.settings.autoUpdate ? ' If you cancel, it is installed when you quit.' : '';
  if (await confirmSheet(`Update to version ${ready}?`, `The app closes, updates and opens again, which takes about 10 seconds.${air}${later}`, 'Update', playing.length > 0)) await call('updateInstall');
}

/** In a browser the settings open over the page; in the app they have their own window. */
let frame: HTMLElement | null = null;
function openSettings(): void {
  if (!vt.web) return void call('openSettings');
  frame?.remove();
  const close = () => { frame?.remove(); frame = null; };
  frame = h('div.sheet-layer.web-settings', h('div', iconButton('x', close, 'Close', 'plain'), h('iframe', { src: '/settings', title: 'Settings' })));
  frame.addEventListener('mousedown', (e) => { if (e.target === frame) close(); });
  document.body.append(frame);
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
  const dot = h('span.dot');
  const label = h('span', 'Connecting');
  const pill = h('button.btn.pill.conn', { title: 'Servers' }, dot, label) as HTMLButtonElement;
  pill.addEventListener('click', () => {
    const s = store.state;
    if (!s) return;
    const rows = s.devices.map((d) => h('div.group-row', h(`span.dot.${d.connected ? 'ok' : 'bad'}`), h('div.grow', h('div', d.name), h('div.caption', d.connected ? `CasparCG ${d.version}  ·  ${d.channels.length} channels` : d.error || 'Connecting'))));
    popover(pill, h('div.conn-pop', h('div.group', ...rows)), { width: 330, align: 'start' });
  });
  on('state', () => {
    const ds = store.state!.devices;
    const up = ds.filter((d) => d.connected).length;
    const cls = `dot ${up === ds.length ? 'ok' : up ? 'warn' : 'bad'}`;
    const text = ds.length === 1 ? (up ? ds[0].name : 'Not connected') : `${up} of ${ds.length} servers`;
    if (dot.className !== cls) dot.className = cls;
    if (label.textContent !== text) label.textContent = text;
  });
  return h('footer.statusbar', pill, h('span.spacer'), h('span', __APP_VERSION__));
}

// ---- keyboard ---------------------------------------------------------------------------------------------------
const FKEYS: Record<string, Action> = { F1: 'stop', F2: 'play', F3: 'load', F4: 'pause', F5: 'next', F6: 'update', F7: 'invoke', F8: 'preview', F10: 'clear', F11: 'clearLayer', F12: 'clearChannel' };
async function act(a: Action): Promise<void> {
  // With no preview channel set for the server, F8 plays the clip in the local preview instead.
  if (a === 'preview' && !store.settings.devices.some((d) => d.preview > 0)) return tab === 'edit' || tab === 'show' ? previewToggle() : undefined;
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
  if (ctrl && k === 'e') { done(); showTab(tab === 'edit' ? 'show' : 'edit'); return; }
  // Everything that changes the rundown works in Edit only.
  const editing = tab === 'edit';
  if (ctrl && 'onwf'.includes(k) && !editing) { done(); return; }
  if (ctrl && k === 'o') { done(); void openFiles(); return; }
  if (ctrl && k === 'n') { done(); newDoc(); return; }
  if (ctrl && k === 'w') { done(); const d = doc(); if (d) void closeDoc(d); return; }
  if (ctrl && k === 'f') { done(); (document.querySelector('#lib-search') as HTMLInputElement)?.focus(); return; }
  if (ctrl && k === ',') { done(); openSettings(); return; }
  if (ctrl && e.key === 'Tab') {
    done();
    const n = store.docs.findIndex((d) => d.id === store.active);
    activate(store.docs[(n + (e.shiftKey ? -1 : 1) + store.docs.length) % store.docs.length].id);
    return;
  }
  if (typing) { if (e.key === 'Escape') el.blur(); return; }
  if (!editing && (e.key === 'Delete' || (ctrl && 'zyxcvdgp'.includes(k)))) return;
  if (ctrl && k === 'z') { done(); undo(e.shiftKey); return; }
  if (ctrl && k === 'y') { done(); undo(true); return; }
  if (e.key === ' ') { done(); if (!e.repeat && (editing || tab === 'show')) previewToggle(); return; }
  if (tab === 'activity' || tab === 'channels') return;
  if (editing && !e.altKey && !ctrl && (k === 'i' || k === 'o')) { done(); if (!e.repeat) previewKey(e.shiftKey ? (k === 'i' ? 'goIn' : 'goOut') : k === 'i' ? 'in' : 'out'); return; }
  if (editing && !e.altKey && !ctrl && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { done(); previewKey(`${e.key === 'ArrowLeft' ? 'back' : 'fwd'}${e.shiftKey ? '10' : ''}`); return; }
  if (tab === 'show' && k === 'u' && !ctrl && !e.altKey) { done(); if (!e.repeat) markUsed(); return; }
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { done(); void act(e.key === 'ArrowLeft' ? 'back' : 'forward'); return; }
  if (ctrl && e.shiftKey && k === 'c') { done(); copyTemplate(); return; }
  if (ctrl && e.shiftKey && k === 'v') { done(); applyTemplate(); return; }
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
  const r = await call<{ settings: Settings; docs: DocPut[]; library: Record<string, Library>; logs: LogLine[]; state: AppState; version: string }>('init');
  if (!r) return;
  Object.assign(store, { settings: r.settings, library: r.library, logs: r.logs, state: r.state, version: r.version });
  gotDocs(r.docs);
  if (!store.active || !store.sel.size) activate(store.docs[0].id);

  const root = document.getElementById('app')!;
  const top = topBar();
  const tabhost = h('main.tabhost');
  for (const [k, el] of [['edit', buildRundown('edit')], ['show', buildRundown('show', () => showTab('edit'))], ['channels', buildChannels()], ['activity', buildActivity()]] as [Tab, HTMLElement][]) {
    el.classList.add('tab');
    hosts.set(k, el);
    tabhost.append(el);
  }
  body = h('div.vt-body', buildLibrary(), h('div.vt-center', tabhost), h('div.vt-right', buildPreview(), (inspector = buildInspector()), (info = buildInfo())));
  columns = splitters(body);
  panels = segmented([{ value: 'library', label: 'Library' }, { value: 'rundown', label: 'Rundown' }, { value: 'details', label: 'Details' }], 'rundown', showPanel);
  showPanel('rundown');
  root.append(top, body, h('div.panels', panels.el), bottomBar());
  document.body.classList.toggle('touch', touch);
  let first: Tab = 'edit';
  try { if (localStorage.getItem('vt.tab') === 'show') first = 'show'; } catch { /* start in Edit */ }
  showTab(first);

  vt.on('state', ((s: AppState) => { store.state = s; emit('state'); }) as never);
  vt.on('docs', ((n: { put: DocPut[]; drop: string[] }) => fromOther(n.put, n.drop)) as never);
  // A browser that was cut off: take what happened meanwhile and send what was done here.
  vt.on('back', (() => void call<{ settings: Settings; docs: DocPut[]; library: Record<string, Library> }>('init').then((x) => { if (!x) return; Object.assign(store, { settings: x.settings, library: x.library }); emit('settings'); emit('library'); gotDocs(x.docs); })) as never);
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
  vt.on('askupdate', ((playing: string[]) => void askUpdate(playing)) as never);
  if (!vt.web) {
    vt.on('update', gotUpdate as never);
    void call<UpdateState>('update').then((u) => u && gotUpdate(u));
  }
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
  const layer = h('div.sheet-layer', h('div.sheet.wide', h('h3', playing.length ? 'A playlist is on air' : 'Quit CasparCG Advanced Client?'), ...parts.map((p) => h('p', p)),
    h('div.actions', button('Cancel', done), playing.length ? button('Keep running hidden', () => { done(); void call('hide'); }, 'primary') : null, button('Quit', () => { done(); void call('quit'); }, playing.length ? 'danger' : 'primary'))));
  document.body.append(layer);
}

void start();
