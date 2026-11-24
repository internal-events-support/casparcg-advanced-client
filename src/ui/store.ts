// Renderer state: documents, selection, undo, live state, and calls to the main process.
import { cloneItem, findItem, isContainer, isPlaylist, newItem, tool, walk } from '../shared/tools';
import { DEFAULT_SETTINGS, uid, type Action, type AppState, type Doc, type Item, type Library, type LogLine, type MediaEntry, type Settings } from '../shared/types';

interface Bridge { call(name: string, ...a: unknown[]): Promise<{ ok: boolean; value?: unknown; error?: string }>; on(name: string, fn: (...a: never[]) => void): void }
export const vt = (window as unknown as { vt: Bridge }).vt;

// ---- events ------------------------------------------------------------------------------------------
type Ev = 'doc' | 'select' | 'state' | 'library' | 'settings' | 'log' | 'tabs' | 'tab';
const subs = new Map<Ev, Set<() => void>>();
export function on(ev: Ev, fn: () => void): void {
  if (!subs.has(ev)) subs.set(ev, new Set());
  subs.get(ev)!.add(fn);
}
export function emit(ev: Ev): void {
  for (const f of subs.get(ev) ?? []) f();
}

export const store = {
  settings: structuredClone(DEFAULT_SETTINGS) as Settings,
  docs: [] as Doc[],
  active: '',
  sel: new Set<string>(),
  anchor: '',
  state: null as AppState | null,
  library: {} as Record<string, Library>,
  logs: [] as LogLine[],
  version: '',
};

// ---- toasts --------------------------------------------------------------------------------------------
export function toast(text: string, kind: 'ok' | 'bad' = 'ok'): void {
  if (!text) return;
  let host = document.querySelector('.toasts');
  if (!host) document.body.append((host = Object.assign(document.createElement('div'), { className: 'toasts' })));
  const t = Object.assign(document.createElement('div'), { className: `toast ${kind}`, textContent: text });
  host.append(t);
  while (host.children.length > 4) host.firstElementChild!.remove();
  setTimeout(() => t.remove(), kind === 'bad' ? 5000 : 2200);
}

/** Call the main process. Shows problems as a toast and returns undefined. */
export async function call<T>(name: string, ...args: unknown[]): Promise<T | undefined> {
  const r = await vt.call(name, ...args);
  if (r.ok) return r.value as T;
  toast(r.error ?? 'Something went wrong', 'bad');
  return undefined;
}

// ---- documents -----------------------------------------------------------------------------------------
/** The server used when nothing else is chosen: the first one in Settings. */
export const homeDevice = () => store.settings.devices[0]?.name ?? '';
export const doc = (): Doc | undefined => store.docs.find((d) => d.id === store.active);
interface Undo { past: string[]; future: string[] }
const undos = new Map<string, Undo>();
const undoOf = (id: string) => { if (!undos.has(id)) undos.set(id, { past: [], future: [] }); return undos.get(id)!; };

let pending: Promise<unknown> = Promise.resolve();
/** Send documents to the main process, which is what actually plays them. */
export function sync(): void {
  pending = vt.call('docs', store.docs);
}
export const flush = () => pending;

let mergeKey = '';
let mergeAt = 0;
/** Change the active document with undo. Edits with the same `merge` key within a second share one undo step. */
export function mutate(fn: (items: Item[], d: Doc) => void, merge = ''): void {
  const d = doc();
  if (!d) return;
  const u = undoOf(d.id);
  if (!merge || merge !== mergeKey || Date.now() - mergeAt > 1000) {
    u.past.push(JSON.stringify(d.items));
    if (u.past.length > 150) u.past.shift();
  }
  mergeKey = merge;
  mergeAt = Date.now();
  u.future = [];
  fn(d.items, d);
  d.dirty = true;
  sync();
  emit('doc');
  emit('tabs');
}
export function undo(redo = false): void {
  const d = doc();
  if (!d) return;
  const u = undoOf(d.id);
  const s = (redo ? u.future : u.past).pop();
  if (!s) return;
  (redo ? u.past : u.future).push(JSON.stringify(d.items));
  d.items = JSON.parse(s) as Item[];
  d.dirty = true;
  mergeKey = '';
  for (const id of [...store.sel]) if (!findItem(d.items, id)) store.sel.delete(id);
  sync();
  emit('doc');
  emit('select');
  emit('tabs');
}

export function newDoc(name = 'New rundown'): Doc {
  const d: Doc = { id: uid(), path: '', name, allowRemote: true, dirty: false, items: [] };
  store.docs.push(d);
  activate(d.id);
  return d;
}
export function activate(id: string): void {
  store.active = id;
  store.sel.clear();
  const first = doc()?.items[0];
  if (first) { store.sel.add(first.id); store.anchor = first.id; }
  sync();
  emit('tabs');
  emit('doc');
  emit('select');
}
export function addDocs(docs: Doc[]): void {
  // A single untouched empty tab is replaced rather than kept around.
  if (store.docs.length === 1 && !store.docs[0].path && !store.docs[0].dirty && !store.docs[0].items.length) store.docs = [];
  for (const d of docs) {
    const open = store.docs.find((x) => x.path && x.path === d.path);
    if (open) { activate(open.id); continue; }
    store.docs.push(d);
    activate(d.id);
  }
}
export async function openFiles(): Promise<void> {
  const r = await call<Doc[]>('open');
  if (r?.length) addDocs(r);
}
export async function openPath(f: string): Promise<void> {
  const r = await call<Doc>('openPath', f);
  if (r) addDocs([r]);
}
export async function save(as = false, d = doc()): Promise<boolean> {
  if (!d) return false;
  const r = await call<{ path: string; name: string } | null>('save', d, as);
  if (!r) return false;
  Object.assign(d, r, { dirty: false });
  sync();
  emit('tabs');
  toast(`Saved ${r.name}`);
  return true;
}

// ---- selection -------------------------------------------------------------------------------------------
export function selected(): Item[] {
  const out: Item[] = [];
  const d = doc();
  if (d) walk(d.items, (i) => { if (store.sel.has(i.id)) out.push(i); });
  return out;
}
/** Selected items without children of selected containers. */
export function selectedTop(): Item[] {
  const out: Item[] = [];
  const d = doc();
  if (d) walk(d.items, (i, p) => { if (store.sel.has(i.id) && !(p && store.sel.has(p.id))) out.push(i); });
  return out;
}
/** Rows in display order. */
export function visible(): { item: Item; parent: Item | null }[] {
  const out: { item: Item; parent: Item | null }[] = [];
  for (const i of doc()?.items ?? []) {
    out.push({ item: i, parent: null });
    if (isContainer(i) && i.expanded !== false) for (const c of i.items ?? []) out.push({ item: c, parent: i });
  }
  return out;
}
export function select(id: string, mode: 'one' | 'toggle' | 'range' = 'one'): void {
  if (mode === 'toggle') {
    if (store.sel.has(id)) store.sel.delete(id);
    else store.sel.add(id);
    store.anchor = id;
  } else if (mode === 'range' && store.anchor) {
    const v = visible().map((x) => x.item.id);
    const a = v.indexOf(store.anchor);
    const b = v.indexOf(id);
    if (a >= 0 && b >= 0) store.sel = new Set(v.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else {
    store.sel = new Set([id]);
    store.anchor = id;
  }
  emit('select');
}
export function moveSelection(by: number, extend = false): void {
  const v = visible().map((x) => x.item.id);
  if (!v.length) return;
  const cur = [...store.sel].pop() ?? '';
  const at = v.indexOf(cur);
  const n = Math.max(0, Math.min(v.length - 1, at < 0 ? 0 : at + by));
  if (extend) { store.sel.delete(v[n]); store.sel.add(v[n]); emit('select'); } else select(v[n]);
}

// ---- editing ---------------------------------------------------------------------------------------------
/** Only videos go inside playlists; containers never go inside containers. */
export const canHold = (c: Item, i: Item) => !isContainer(i) && (!isPlaylist(c) || i.type === 'MOVIE');

export interface Spot { parent: string | null; index: number }
export function insert(items: Item[], at?: Spot): void {
  if (!items.length) return;
  const d = doc() ?? newDoc();
  let spot = at;
  if (!spot) {
    const last = [...store.sel].pop();
    const f = last ? findItem(d.items, last) : null;
    if (!f) spot = { parent: null, index: d.items.length };
    else if (f.parent && items.every((i) => canHold(f.parent!, i))) spot = { parent: f.parent.id, index: f.parent.items!.indexOf(f.item) + 1 };
    else spot = { parent: null, index: d.items.indexOf(f.parent ?? f.item) + 1 };
  }
  const s = spot;
  let refused = 0;
  mutate((root) => {
    const p = s.parent ? findItem(root, s.parent)?.item : null;
    const list = p ? p.items! : root;
    const ok = items.filter((i) => !p || canHold(p, i));
    refused = items.length - ok.length;
    list.splice(s.index, 0, ...ok);
    if (p) p.expanded = true;
    store.sel = new Set(ok.map((i) => i.id));
    store.anchor = ok[0]?.id ?? '';
  });
  if (refused) toast(refused === items.length ? 'Playlists hold videos only' : `${refused} skipped: playlists hold videos only`, 'bad');
  emit('select');
}
export function removeSelected(): void {
  if (!store.sel.size) return;
  const v = visible().map((x) => x.item.id);
  const at = v.findIndex((id) => store.sel.has(id));
  const gone = new Set(store.sel);
  mutate((root) => {
    const prune = (l: Item[]): void => {
      for (let k = l.length - 1; k >= 0; k--) {
        if (gone.has(l[k].id)) l.splice(k, 1);
        else if (l[k].items) prune(l[k].items!);
      }
    };
    prune(root);
  });
  const left = visible().map((x) => x.item.id);
  store.sel = new Set(left.length ? [left[Math.min(Math.max(0, at), left.length - 1)]] : []);
  emit('select');
}
export function moveItems(ids: string[], to: Spot): void {
  const d = doc();
  if (!d) return;
  let bad = false;
  mutate((root) => {
    const picked: Item[] = [];
    walk(root, (i, p) => { if (ids.includes(i.id) && !(p && ids.includes(p.id))) picked.push(i); });
    const target = to.parent ? findItem(root, to.parent)?.item : null;
    if (target && (picked.includes(target) || !picked.every((i) => canHold(target, i)))) { bad = true; return; }
    const list = target ? target.items! : root;
    const before = list.slice(0, to.index).filter((i) => !picked.includes(i)).length;
    const strip = (l: Item[]): void => { for (let k = l.length - 1; k >= 0; k--) { if (picked.includes(l[k])) l.splice(k, 1); else if (l[k].items) strip(l[k].items!); } };
    strip(root);
    list.splice(before, 0, ...picked);
  });
  if (bad) { undo(); toast('That cannot go in there', 'bad'); }
}
let clip: Item[] = [];
export function copy(cut = false): void {
  const s = selectedTop();
  if (!s.length) return;
  clip = s.map((i) => structuredClone(i));
  if (cut) removeSelected();
  else toast(s.length === 1 ? `Copied ${s[0].label}` : `Copied ${s.length} items`);
}
export function paste(): void {
  insert(clip.map(cloneItem));
}
// ---- copy template: everything about an entry except what it plays and what it is called
let template: Item | null = null;
export const hasTemplate = () => template;
export function copyTemplate(): void {
  const s = selected();
  if (s.length !== 1) { toast('Select the one entry to copy the settings from', 'bad'); return; }
  template = structuredClone(s[0]);
  toast(`Template copied from ${template.label}`);
  emit('select');
}
/** Put the template's settings on an item. The clip, label, remote ID and story ID stay its own. */
export function stamp(i: Item, t: Item): void {
  const to = tool(i.type);
  const same = i.type === t.type;
  for (const k of ['device', 'channel', 'layer', 'delay', 'duration'] as const) if (to.out.includes(k) && tool(t.type).out.includes(k)) (i as unknown as Record<string, unknown>)[k] = t[k];
  if (t.color) i.color = t.color; else delete i.color;
  i.allowGpi = t.allowGpi;
  i.allowRemote = t.allowRemote;
  for (const p of to.props) if (p.key in t.props) i.props[p.key] = t.props[p.key];
  if (same && t.data) i.data = structuredClone(t.data);
}
export function applyTemplate(): void {
  const t = template;
  if (!t) { toast('Copy a template first (Ctrl+Shift+C)', 'bad'); return; }
  const ids = selected().filter((i) => i.type !== 'SEPARATOR').map((i) => i.id);
  if (!ids.length) { toast('Select the entries to apply it to', 'bad'); return; }
  mutate((root) => walk(root, (i) => { if (ids.includes(i.id)) stamp(i, t); }));
  emit('select');
  toast(`Template applied to ${ids.length === 1 ? '1 entry' : `${ids.length} entries`}`);
}
export function duplicate(): void {
  insert(selectedTop().map(cloneItem));
}
export function wrap(type: 'GROUP' | 'PLAYLIST'): void {
  const s = selectedTop().filter((i) => !isContainer(i) && (type === 'GROUP' || i.type === 'MOVIE'));
  if (!s.length) { toast(type === 'PLAYLIST' ? 'Select some videos first' : 'Select some items first', 'bad'); return; }
  mutate((root) => {
    const f = findItem(root, s[0].id)!;
    const at = root.indexOf(f.parent ?? f.item);
    const strip = (l: Item[]): void => { for (let k = l.length - 1; k >= 0; k--) { if (s.includes(l[k])) l.splice(k, 1); else if (l[k].items) strip(l[k].items!); } };
    strip(root);
    const c = newItem(type, { items: s, ...(type === 'PLAYLIST' ? { device: s[0].device || homeDevice(), channel: s[0].channel, layer: s[0].layer, label: `Playlist ${playlists().length + 1}` } : {}) });
    root.splice(Math.min(at, root.length), 0, c);
    store.sel = new Set([c.id]);
  });
  emit('select');
}
export function ungroup(): void {
  const cs = selectedTop().filter(isContainer);
  if (!cs.length) return;
  mutate((root) => {
    for (const c of cs) {
      const at = root.indexOf(c);
      if (at >= 0) root.splice(at, 1, ...(c.items ?? []));
    }
  });
  emit('select');
}
/** Edit every selected item in one undo step per field. */
export function edit(ids: string[], key: string, fn: (i: Item) => void): void {
  mutate((root) => walk(root, (i) => { if (ids.includes(i.id)) fn(i); }), `${key}:${ids.join()}`);
}

export function playlists(): { doc: Doc; item: Item }[] {
  return store.docs.flatMap((d) => d.items.filter(isPlaylist).map((item) => ({ doc: d, item })));
}

// ---- playing -------------------------------------------------------------------------------------------------
export async function execute(a: Action, id = [...store.sel].pop()): Promise<void> {
  if (!id) return;
  const f = findItem(doc()?.items ?? [], id);
  await flush();
  const r = await call<string>('execute', id, a);
  if (r === undefined || !f) return;
  // Auto step: move on to the next item after playing.
  const g = f.item.type === 'GROUP' ? f.item : f.parent?.type === 'GROUP' ? f.parent : null;
  if ((a === 'play' || a === 'playNow') && g?.props.autostep && store.sel.has(id)) {
    const v = visible().map((x) => x.item);
    let n = v.indexOf(f.item) + 1;
    if (f.item === g) while (n < v.length && g.items!.includes(v[n])) n++;
    if (v[n]) {
      select(v[n].id);
      if (store.settings.autoStepPreview) void call('execute', v[n].id, 'preview');
    }
  }
}

// ---- media helpers ---------------------------------------------------------------------------------------------
let mediaIx: { src: unknown; map: Map<string, MediaEntry> } = { src: null, map: new Map() };
export function media(name: string, device = homeDevice()): MediaEntry | undefined {
  const lib = store.library[device] ?? Object.values(store.library)[0];
  if (!lib) return undefined;
  if (mediaIx.src !== lib) mediaIx = { src: lib, map: new Map(lib.media.map((m) => [m.name.toLowerCase(), m])) };
  return mediaIx.map.get(name.replace(/\\/g, '/').toLowerCase());
}
const thumbs = new Map<string, Promise<string>>();
/** data: URL of a clip's thumbnail, or ''. */
export function thumb(name: string, device = homeDevice()): Promise<string> {
  const k = `${device}|${name.toLowerCase()}`;
  if (!thumbs.has(k)) {
    const p = vt.call('thumb', device, name).then((r) => (r.ok && r.value ? `data:image/png;base64,${r.value as string}` : ''));
    thumbs.set(k, p);
    void p.then((v) => { if (!v) setTimeout(() => thumbs.delete(k), 20000); });
  }
  return thumbs.get(k)!;
}
export function clock(s: number, up = false): string {
  const n = Math.max(0, up ? Math.ceil(s - 0.02) : Math.floor(s));
  const h = Math.floor(n / 3600);
  const mm = String(Math.floor((n % 3600) / 60)).padStart(2, '0');
  const ss = String(n % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
/** The playlist a clip is in: that decides where it plays, not the clip's own output. */
export const playlistOf = (i: Item): Item | undefined => doc()?.items.find((x) => isPlaylist(x) && x.items?.includes(i));
/** Frame rate of the channel an item plays on. Seek and length count in its frames. */
export function fpsOf(i: Item): number {
  const at = playlistOf(i) ?? i;
  return store.state?.devices.find((d) => d.name === (at.device || homeDevice()))?.fps[at.channel - 1] || 50;
}
export function itemSeconds(i: Item): number {
  if (i.type !== 'MOVIE' && i.type !== 'AUDIO') return i.duration > 0 ? i.duration / 1000 : 0;
  const m = media(i.name, i.device || undefined);
  if (!m) return 0;
  const len = Number(i.props.length) || 0;
  const fps = fpsOf(i);
  const left = Math.max(0, m.seconds - (Number(i.props.seek) || 0) / fps);
  return len > 0 ? Math.min(len / fps, left) : left;
}
/** A rundown item for a library entry, aimed at sensible defaults. */
export function itemFromMedia(m: MediaEntry): Item {
  const base = m.name.split('/').pop()!;
  return newItem(m.type, { label: base, name: m.name, device: homeDevice() });
}
