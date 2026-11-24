// App shell: windows, settings, documents and IPC. Playback keeps running here if the window is closed.
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import type dgram from 'node:dgram';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import type { Seen } from '../shared/relink';
import { newItem } from '../shared/tools';
import { DEFAULT_SETTINGS, stem, uid, type Action, type AppState, type Doc, type DocPut, type DocSync, type Item, type Library, type Loc, type LogLine, type Settings } from '../shared/types';
import { parseRundown, writeRundown } from '../shared/xml';
import { readLegacy, startCountdown, startHttp, startOsc, takeOpts, type ApiHooks } from './api';
import { q } from './commands';
import { Device } from './device';
import { Engine, Refused } from './engine';
import { Preview } from './preview';
import { Runner } from './runner';
import { addresses, Web, type Client, type WebHooks } from './web';

if (process.env.CASPARVT_USERDATA) app.setPath('userData', process.env.CASPARVT_USERDATA);
else app.setPath('userData', path.join(app.getPath('appData'), 'Caspar VT'));
if (!app.requestSingleInstanceLock()) app.quit();

const ROOT = path.join(__dirname, '..', '..');
const ud = (f: string) => path.join(app.getPath('userData'), f);
const ICON = path.join(ROOT, 'static', 'icon.png');

let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

// ---- screens --------------------------------------------------------------------------------------
/** Whose request is being handled. Follows the work through anything it starts. */
const asking = new AsyncLocalStorage<Client>();
const PC: Client = { id: 'pc', web: false, local: true, send: (name, ...args) => win?.webContents.send(name, ...args) };
const who = () => asking.getStore() ?? PC;
/** Tell every screen. */
function tell(name: string, ...args: unknown[]): void {
  win?.webContents.send(name, ...args);
  webSrv?.send(name, args);
}

// ---- settings -------------------------------------------------------------------------------------
function loadSettings(): Settings {
  let s: Partial<Settings> = {};
  try { s = JSON.parse(fs.readFileSync(ud('settings.json'), 'utf8')) as Partial<Settings>; } catch { /* first run */ }
  const d = structuredClone(DEFAULT_SETTINGS);
  const known = Object.fromEntries(Object.entries(s).filter(([k]) => k in d)); // drop settings from earlier versions
  return { ...d, ...known, http: { ...d.http, ...s.http }, osc: { ...d.osc, ...s.osc }, countdown: { ...d.countdown, ...s.countdown }, web: { ...d.web, ...s.web } };
}
let settings: Settings;
function webKey(): string {
  try { return fs.readFileSync(ud('web.key'), 'utf8'); } catch { const k = crypto.randomBytes(32).toString('hex'); writeSafe(ud('web.key'), k); return k; }
}
const newCode = () => String(crypto.randomInt(100000, 1000000));
/** Write via a temporary file so a crash never leaves half a file behind. */
function writeSafe(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', text, 'utf8');
  fs.renameSync(file + '.tmp', file);
}

// ---- log --------------------------------------------------------------------------------------------
const logs: LogLine[] = [];
function log(dir: LogLine['dir'], device: string, text: string): void {
  const l = { t: Date.now(), dir, device, text };
  logs.push(l);
  if (logs.length > 2000) logs.splice(0, 500);
  tell('log', l);
}
const toast = (text: string, kind: 'ok' | 'bad' = 'ok') => { const c = asking.getStore(); if (c) c.send('toast', text, kind); else tell('toast', text, kind); };
const problem = (e: unknown) => { const m = e instanceof Error ? e.message : String(e); log('err', '', m); toast(m, 'bad'); };

// ---- devices ----------------------------------------------------------------------------------------
const devices = new Map<string, Device>();
const device = (n: string) => devices.get(n);
let engine: Engine;
let runner: Runner;
let preview: Preview;
const library: Record<string, Library> = {};

function syncDevices(): void {
  for (const [n, d] of devices) {
    const c = settings.devices.find((x) => x.name === n);
    if (!c || c.host !== d.cfg.host || c.port !== d.cfg.port) { d.close(); devices.delete(n); }
    else d.cfg = c;
  }
  for (const c of settings.devices) {
    if (devices.has(c.name)) continue;
    const d = new Device(c);
    devices.set(c.name, d);
    d.on('log', (dir: LogLine['dir'], text: string) => log(dir, c.name, text));
    d.on('connected', () => { void refresh(c.name); void engine.resume(c.name); void findMedia(d); });
  }
}

async function refresh(name: string): Promise<void> {
  const d = device(name);
  if (!d?.connected) return;
  const safe = <T,>(p: Promise<T>, fallback: T) => p.catch((e: Error) => { log('err', name, e.message); return fallback; });
  setLibrary(name, { media: await safe(d.media(), []), templates: await safe(d.templates(), []), data: await safe(d.data(), []), presets: presetNames() });
}
function setLibrary(name: string, lib: Library): void {
  library[name] = lib;
  tell('library', name, lib);
  noteSeen(name, lib);
}
/** Every clip ever seen, so a renamed file can be recognised by its size and length. */
let seen: Record<string, Seen> = {};
function noteSeen(name: string, lib: Library): void {
  const s = (seen[name] ??= {});
  let changed = false;
  for (const m of lib.media) {
    const k = m.name.replace(/\\/g, '/').toLowerCase();
    if (s[k] && s[k].size === m.size && s[k].frames === m.frames) continue;
    s[k] = m;
    changed = true;
  }
  if (changed) writeSafe(ud('seen.json'), JSON.stringify(seen));
}
/** Notice files being added, renamed or deleted without anyone pressing refresh. */
async function watchMedia(): Promise<void> {
  for (const [name, d] of devices) {
    if (!d.connected || !library[name]) continue;
    const r = await d.scan();
    if (!r || (!r.media.length && library[name].media.length)) continue;
    const key = (l: { media: Library['media']; templates: string[] }) => JSON.stringify([l.media.map((m) => [m.name, m.size, m.frames]).sort(), [...l.templates].sort()]);
    if (key(r) !== key(library[name])) setLibrary(name, { ...library[name], ...r });
  }
}

// ---- local media for preview ---------------------------------------------------------------------------
let autoFfmpeg = 'ffmpeg';
const autoMedia = new Map<string, string>();
/** When the server runs on this PC, ask it where its media is and remember that, so preview also works with the server off. */
async function findMedia(d: Device): Promise<void> {
  if (!['127.0.0.1', 'localhost', '::1'].includes(d.cfg.host)) return;
  try {
    const x = (await d.cmd('INFO PATHS', true)).lines.join('\n');
    const tag = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(x)?.[1] ?? '';
    const root = tag('initial-path');
    const folder = path.resolve(root, tag('media-path'));
    if (fs.existsSync(folder)) {
      autoMedia.set(d.cfg.name, folder);
      writeSafe(ud('media.json'), JSON.stringify([...autoMedia]));
    }
    const ff = path.join(root, 'ffmpeg.exe');
    if (fs.existsSync(ff)) autoFfmpeg = ff;
  } catch { /* preview falls back to Settings */ }
}
function mediaFolder(dev: string): string {
  const c = settings.devices.find((x) => x.name === dev) ?? settings.devices[0];
  return c?.media || autoMedia.get(c?.name ?? '') || '';
}

// ---- presets ----------------------------------------------------------------------------------------
const presetDir = () => ud('presets');
function presetNames(): string[] {
  try { return fs.readdirSync(presetDir()).filter((f) => f.endsWith('.xml')).map((f) => f.slice(0, -4)).sort(); } catch { return []; }
}
const presetFile = (n: string) => path.join(presetDir(), n.replace(/[^\w .()-]/g, '_').slice(0, 80) + '.xml');

// ---- remote control -----------------------------------------------------------------------------------
let httpSrv: http.Server | null = null;
let oscSrv: dgram.Socket | null = null;
let cdSrv: http.Server | null = null;
let webSrv: Web | null = null;
const services = { http: 'Off', osc: 'Off', countdown: 'Off', web: 'Off' };

/** "1-10" on the first server, or "Server name:1-10". */
function loc(ref: string): Loc | null {
  const m = /^(?:(.+):)?(\d{1,3})-(\d{1,5})$/.exec(ref);
  if (!m) return null;
  const device = m[1] ? settings.devices.find((d) => d.name.toLowerCase() === m[1].toLowerCase())?.name : engine.home();
  return device ? { device, channel: Number(m[2]), layer: Number(m[3]) } : null;
}

const hooks: ApiHooks = {
  loc,
  transport: (t, v) => engine.run(() => engine.transport(t, v)),
  take: (a, b, o) => engine.run(() => engine.take(a, b, o)),
  remoteItem: async (rid, a) => {
    const i = runner.byRemoteId(rid) ?? [...runner.docs.values()].flatMap((d) => flat(d.items)).find((x) => x.allowRemote && x.remoteId.toLowerCase() === rid.toLowerCase());
    if (!i) throw new Refused(`No open item has the remote ID ${rid}`);
    return runner.execute(i.id, a);
  },
  rundown: (verb) => win?.webContents.send('rundown', verb),
  playlist: async (ref, verb, n) => {
    const all = runner.playlists();
    const pl = /^\d+$/.test(ref) ? all[Number(ref) - 1] : all.find((x) => x.label.toLowerCase() === ref.toLowerCase() || x.remoteId.toLowerCase() === ref.toLowerCase());
    if (!pl) throw new Refused(`No open playlist matches ${ref}`);
    if ((verb === 'load' || verb === 'play') && n) return engine.run(async () => { await engine.startPlaylist(pl, n - 1, verb === 'play'); return `${pl.label}: ${verb} ${n}`; });
    if (['load', 'play', 'pause', 'stop', 'next', 'prev'].includes(verb)) return runner.execute(pl.id, verb as Action);
    throw new Refused(`Unknown playlist command ${verb}`);
  },
  // The URLs of the earlier VT controller, so existing Companion buttons and rundowns keep working.
  legacy: async (p) => {
    const c = settings.legacyConfig ? readLegacy(settings.legacyConfig) : null;
    const d = device(engine.home());
    // The earlier controller called two particular channels PGM and PVW; its file says which.
    const at = (b: string): Loc => ({ device: engine.home(), channel: (b === 'pgm' ? c?.pgm_channel : c?.pvw_channel) ?? 1, layer: c?.layer ?? 10 });
    const t = at('pvw');
    if (c && (p[0] === 'pgm' || p[0] === 'pvw') && p.length === 2) return hooks.transport(at(p[0]), p[1]);
    if (c && p[0] === 'take' && p.length === 2 && ['cut', 'cutplay', 'fade', 'fadeplay'].includes(p[1])) return hooks.take(at('pvw'), at('pgm'), takeOpts(p[1], String(c.fade_frames ?? 25)));
    if (p[0] === 'gfx') {
      const ch = c?.gfx_channel ?? 4;
      if (p[1] === 'clear') { for (const l of [20, 30]) await d?.cmd(`PLAY ${ch}-${l} #00000000 MIX 12`); return 'Graphics off'; }
      const e = (p[1] === 'lt' || p[1] === 'rq') && c ? c[p[1]][Number(p[2]) - 1] : null;
      if (!e) return null;
      await d?.cmd(`PLAY ${ch}-${p[1] === 'lt' ? 20 : 30} ${q(e.file)}`);
      return e.title;
    }
    if (p[0] === 'pvw' && p[1] === 'load' && c) {
      if (p[2] === 'clip' && c.clips[Number(p[3]) - 1]) { await d?.cmd(`LOAD ${t.channel}-${t.layer} ${q(c.clips[Number(p[3]) - 1])}`); return `PVW: ${c.clips[Number(p[3]) - 1]}`; }
      const pl = p[2] === 'playlist' ? c.playlists[p[3]] : null;
      if (pl) {
        const item = newItem('PLAYLIST', { id: `legacy-${p[3]}`, label: p[3], items: pl.clips.map((name, k) => newItem('MOVIE', { id: `legacy-${p[3]}-${k}`, name, label: name })), props: { cgloop: pl.loop ? 'Loop forever' : 'Stop on last' } });
        await engine.run(() => engine.startPlaylist(item, Math.max(0, Number(p[4] ?? 1) - 1), false, t));
        return `PVW: playlist ${p[3]}`;
      }
    }
    return null;
  },
  status: () => ({ connected: !!device(engine.home())?.connected, layers: Object.fromEntries([...devices].flatMap(([n, d]) => [...d.layers()].filter(([, l]) => l.producer !== 'empty').map(([k, l]) => { const [c, y] = k.split('-').map(Number); const deck = engine.deckAt({ device: n, channel: c, layer: y }); return [n === engine.home() ? k : `${n}:${k}`, { ...l, playlist: deck?.label ?? null, index: deck ? deck.index + 1 : 0, count: deck?.count ?? 0 }]; }))) }),
  countdown: (ch) => {
    // The main layer when it has a clip; otherwise whichever layer does (lower thirds, cues): one still running first, then the top one.
    const clips = [...(device(engine.home())?.layers() ?? [])].filter(([k, l]) => k.startsWith(`${ch}-`) && l.producer !== 'empty' && l.end > 0).map(([k, l]) => ({ n: Number(k.split('-')[1]), l }))
      .sort((x, y) => Number(engine.ended(x.l)) - Number(engine.ended(y.l)) || y.n - x.n);
    const main = clips.find((x) => x.n === settings.countdown.layer) ?? clips[0] ?? { n: settings.countdown.layer, l: engine.layer(engine.home(), ch, settings.countdown.layer) };
    const layer = main.l;
    const others = clips.filter((x) => x !== main && !engine.ended(x.l));
    return { layer, at: main.n, others, next: layer.next ? layer.next.replace(/\\/g, '/').split('/').pop()! : '' };
  },
  log: (k, t) => log(k, 'Remote', t),
};
const webHooks: WebHooks = {
  call: (c, name, args) => dispatch(c, name, args),
  state: () => state(),
  media: (token, range) => preview.serve(token, range),
  left: (c) => preview.cancel(c.id),
  log: hooks.log,
};
const flat = (items: Item[]): Item[] => items.flatMap((i) => [i, ...flat(i.items ?? [])]);

function syncServices(): void {
  httpSrv?.close(); httpSrv?.closeAllConnections?.(); httpSrv = null;
  try { oscSrv?.close(); } catch { /* was not open */ }
  oscSrv = null;
  cdSrv?.close(); cdSrv?.closeAllConnections?.(); cdSrv = null;
  webSrv?.close(); webSrv = null;
  services.http = services.osc = services.countdown = services.web = 'Off';
  if (settings.web.enabled) webSrv = new Web(settings.web, webKey(), ROOT, webHooks, (s) => (services.web = s || `On, port ${settings.web.port}`));
  if (settings.http.enabled) httpSrv = startHttp(settings.http.port, hooks, (s) => (services.http = s || `On, port ${settings.http.port}`));
  if (settings.osc.enabled) oscSrv = startOsc(settings.osc.port, hooks, (s) => (services.osc = s || `On, port ${settings.osc.port}`));
  if (settings.countdown.enabled) cdSrv = startCountdown(settings.countdown, hooks, (s) => (services.countdown = s || `On, port ${settings.countdown.port}`));
}

// ---- state to the window --------------------------------------------------------------------------------
function state(): AppState {
  const layers: AppState['layers'] = {};
  const audio: AppState['audio'] = {};
  for (const [n, d] of devices) {
    for (const [k, l] of d.layers()) layers[`${n}|${k}`] = l;
    for (const [c, v] of d.audio()) audio[`${n}|${c}`] = v;
  }
  return {
    devices: settings.devices.map((c) => { const d = device(c.name); return { name: c.name, connected: !!d?.connected, error: d?.error ?? '', version: d?.version ?? '', channels: d?.channels ?? [], fps: (d?.channels ?? []).map((_, k) => d!.fps(k + 1)) }; }),
    layers, decks: engine.list(), audio, items: runner.states(), services: { ...services }, busy: engine.busy,
  };
}

// ---- documents ---------------------------------------------------------------------------------------------
function openDoc(file: string): Doc {
  const { items, allowRemote } = parseRundown(fs.readFileSync(file, 'utf8'));
  for (const i of flat(items)) if (i.type === 'SHELL') knownShell.add(shellOf(i)); // it came from this PC
  const doc: Doc = { id: uid(), path: file, name: path.basename(file).replace(/\.xml$/i, ''), allowRemote, dirty: false, items };
  remember(file);
  return doc;
}
function remember(file: string): void {
  settings.recent = [file, ...settings.recent.filter((f) => f !== file)].slice(0, 10);
  saveSettings();
  tell('settings', settings);
}
function saveSettings(): void { writeSafe(ud('settings.json'), JSON.stringify(settings, null, 2)); }

/** The open rundowns live here; every screen shows them. Each has a number that goes up when it changes. */
const revs = new Map<string, number>();
let lastRev = Date.now(); // ahead of anything a screen still remembers from before a restart
const nextRev = () => (lastRev = Math.max(lastRev + 1, Date.now()));
const copyOf = (id: string): DocPut => ({ doc: runner.docs.get(id)!, rev: revs.get(id)! });
const sig = (p: Item) => JSON.stringify([p.props, (p.items ?? []).map((i) => [i.id, i.name, i.props.seek, i.props.length])]);

/** A screen changed some rundowns. What somebody else changed first comes back for it to merge. */
function syncDocs(put: { doc: Doc; base: number }[], drop: string[]): DocSync {
  const c = who();
  const out: DocSync = { revs: {}, conflicts: [] };
  const before = new Map(runner.playlists().map((p) => [p.id, sig(p)]));
  const done: string[] = [];
  if (c.web) for (const { doc } of put) checkShell(c, doc.items);
  for (const { doc, base } of put) {
    const was = runner.docs.get(doc.id);
    if (was && revs.get(doc.id) !== base) { out.conflicts.push(copyOf(doc.id)); continue; }
    if (c.web && doc.path && doc.path !== was?.path && !allowedFile(doc.path)) doc.path = was?.path ?? '';
    runner.docs.set(doc.id, doc);
    revs.set(doc.id, nextRev());
    out.revs[doc.id] = revs.get(doc.id)!;
    done.push(doc.id);
  }
  const gone = drop.filter((id) => runner.docs.delete(id));
  for (const id of gone) revs.delete(id);
  if (!done.length && !gone.length) return out;
  for (const p of runner.playlists()) if (before.has(p.id) && before.get(p.id) !== sig(p)) void engine.run(() => engine.playlistEdited(p)).catch(problem);
  scheduleSession();
  const news = { put: done.map(copyOf), drop: gone };
  if (c.id !== 'pc') win?.webContents.send('docs', news);
  webSrv?.send('docs', [news], c.id);
  return out;
}

// ---- what a browser may not do -------------------------------------------------------------------------------
/** Shell commands run programs on this PC, so a browser on another device can play the ones that are here but not write its own. */
const shellOf = (i: Item) => JSON.stringify([i.props.cgshell ?? '', i.props.cgshellstop ?? '', i.props.cgshelldir ?? '']);
const knownShell = new Set<string>(['["","",""]']);
function checkShell(c: Client, items: Item[]): void {
  if (!c.web || c.local) return;
  const known = new Set([...knownShell, ...[...runner.docs.values()].flatMap((d) => flat(d.items)).filter((i) => i.type === 'SHELL').map(shellOf)]);
  if (flat(items).some((i) => i.type === 'SHELL' && !known.has(shellOf(i)))) throw new Refused('Shell commands can only be written on the show PC');
}
function checkSettings(c: Client, patch: Partial<Settings>): void {
  if (!c.web) return;
  delete patch.recent;
  if (c.local) return;
  const differs = (k: keyof Settings) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(settings[k]);
  const folders = (l: Settings['devices']) => l.filter((d) => d.media).map((d) => JSON.stringify([d.name, d.media]));
  if (differs('allowShell') || differs('ffmpeg') || differs('web') || differs('legacyConfig') || (patch.devices && folders(patch.devices).some((x) => !folders(settings.devices).includes(x)))) throw new Refused('That can only be changed on the show PC');
}
/** Folders a browser may open rundowns from and save them to: the ones already in use here. */
function rundownDirs(): string[] {
  const used = [...settings.recent, ...[...runner.docs.values()].map((d) => d.path)].filter(Boolean).map((f) => path.dirname(path.resolve(f)));
  return [...new Set([...used, app.getPath('documents')])];
}
function allowedFile(f: string): boolean {
  const full = path.resolve(String(f));
  const base = path.basename(full);
  if (!/\.xml$/i.test(base) || /[<>:"|?*]/.test(base) || /^(con|prn|aux|nul|com\d|lpt\d)\./i.test(base)) return false;
  return rundownDirs().some((d) => d.toLowerCase() === path.dirname(full).toLowerCase());
}

let sessionTimer: NodeJS.Timeout | null = null;
function scheduleSession(): void {
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => { sessionTimer = null; writeSafe(ud('session.json'), JSON.stringify([...runner.docs.values()])); }, 300);
}
function loadSession(): Doc[] {
  try { return (JSON.parse(fs.readFileSync(ud('session.json'), 'utf8')) as Doc[]).filter((d) => Array.isArray(d.items)); } catch { return []; }
}

// ---- IPC ---------------------------------------------------------------------------------------------------
const XML_FILTER = [{ name: 'CasparCG rundown', extensions: ['xml'] }];
const handlers: Record<string, (...a: never[]) => unknown> = {
  init: () => ({ settings, docs: [...runner.docs.keys()].map(copyOf), library, logs: logs.slice(-500), state: state(), version: __APP_VERSION__ }),
  docs: (put: { doc: Doc; base: number }[], drop: string[]) => syncDocs(put, drop),
  execute: (id: string, a: Action) => runner.execute(id, a),
  transport: (t: Loc, v: string) => hooks.transport(t, v),
  seek: (t: Loc, s: number) => engine.run(() => engine.seek(t, s, true)),
  take: (a: Loc, b: Loc, o: { fade: boolean; roll: boolean; hold: boolean; frames: number }) => hooks.take(a, b, o),
  used: (ids: string[], u: boolean) => runner.setUsed(ids, u),
  previewOpen: async (dev: string, name: string) => {
    const c = who();
    const r = await preview.open(c.id, mediaFolder(dev), name, (p) => c.send('previewProgress', p));
    return c.web ? { ...r, url: r.url.replace('vtmedia://clip/', '/media/') } : r;
  },
  previewCancel: () => preview.cancel(who().id),
  refresh: (n: string) => refresh(n),
  thumb: async (n: string, name: string) => (device(n)?.connected ? device(n)!.thumbnail(name).catch(() => '') : ''),
  raw: async (n: string, cmd: string) => { const r = await device(n)?.cmd(cmd); return r ? r.lines : []; },
  dataStore: async (n: string, key: string, value: string) => { await device(n)?.cmd(`DATA STORE ${q(key)} ${q(value)}`); await refresh(n); },
  dataRead: async (n: string, key: string) => (await device(n)?.cmd(`DATA RETRIEVE ${q(key)}`))?.lines[0] ?? '',
  dataRemove: async (n: string, key: string) => { await device(n)?.cmd(`DATA REMOVE ${q(key)}`); await refresh(n); },
  open: async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Open rundown', filters: XML_FILTER, properties: ['openFile', 'multiSelections'] });
    return r.filePaths.map(openDoc);
  },
  openPath: (f: string) => {
    if (who().web && !allowedFile(f)) throw new Refused('That file can only be opened on the show PC');
    return openDoc(f);
  },
  // For a browser, in place of the file dialogs.
  files: () => rundownDirs().map((dir) => { try { return { dir, files: fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /\.xml$/i.test(e.name)).map((e) => e.name).sort((a, b) => a.localeCompare(b)) }; } catch { return { dir, files: [] }; } }),
  openText: (name: string, xml: string): Doc => { const { items, allowRemote } = parseRundown(xml); checkShell(who(), items); return { id: uid(), path: '', name: name.replace(/\.xml$/i, '').slice(0, 120) || 'Rundown', allowRemote, dirty: true, items }; },
  xml: (doc: Doc) => writeRundown(doc.items, doc.allowRemote),
  saveTo: (doc: Doc, dir: string, name: string) => {
    const f = path.join(dir, /\.xml$/i.test(name) ? name : `${name}.xml`);
    if (/[\\/]/.test(name) || !allowedFile(f)) throw new Refused('That name or folder cannot be used');
    checkShell(who(), doc.items);
    return store(doc, f);
  },
  save: async (doc: Doc, as: boolean) => {
    const c = who();
    let f = doc.path;
    if (c.web) {
      if (as || !f || (f !== runner.docs.get(doc.id)?.path && !allowedFile(f))) throw new Refused('Choose where to save it');
      checkShell(c, doc.items);
    } else if (as || !f) {
      const r = await dialog.showSaveDialog(win!, { title: 'Save rundown', filters: XML_FILTER, defaultPath: f || doc.name + '.xml' });
      if (r.canceled || !r.filePath) return null;
      f = r.filePath;
    }
    return store(doc, f);
  },
  presetSave: (name: string, items: Item[]) => { checkShell(who(), items); writeSafe(presetFile(name), writeRundown(items, false)); for (const n of devices.keys()) if (library[n]) { library[n].presets = presetNames(); tell('library', n, library[n]); } return presetNames(); },
  presetLoad: (name: string) => parseRundown(fs.readFileSync(presetFile(name), 'utf8')).items,
  presetRemove: (name: string) => { fs.rmSync(presetFile(name), { force: true }); return presetNames(); },
  presets: () => presetNames(),
  getSettings: () => settings,
  setSettings: async (patch: Partial<Settings>) => {
    checkSettings(who(), patch);
    if (patch.web) {
      const code = String(patch.web.code ?? '').trim();
      if (code.length < 6 || code.length > 64) throw new Refused('The access code needs 6 to 64 characters');
      patch.web = { ...patch.web, code };
    }
    const svc = JSON.stringify([settings.http, settings.osc, settings.countdown, settings.web]);
    settings = { ...settings, ...patch };
    saveSettings();
    syncDevices();
    if (JSON.stringify([settings.http, settings.osc, settings.countdown, settings.web]) !== svc) syncServices();
    tell('settings', settings);
    settingsWin?.webContents.send('settings', settings);
    return settings;
  },
  openSettings: () => openSettings(),
  services: () => services,
  seen: (n: string) => seen[n] ?? {},
  webInfo: () => ({ state: services.web, addresses: settings.web.lan ? addresses() : [] }),
  webOpen: () => shell.openExternal(`http://127.0.0.1:${settings.web.port}/#${encodeURIComponent(settings.web.code)}`),
  webNewCode: async () => { if (who().web) throw new Refused('That can only be changed on the show PC'); settings = { ...settings, web: { ...settings.web, code: newCode() } }; saveSettings(); syncServices(); settingsWin?.webContents.send('settings', settings); return settings; },
  deviceStates: () => state().devices,
  browseFolder: async () => { const r = await dialog.showOpenDialog(settingsWin ?? win!, { properties: ['openDirectory'] }); return r.filePaths[0] ?? ''; },
  browseExe: async () => { const r = await dialog.showOpenDialog(settingsWin ?? win!, { title: 'Choose ffmpeg.exe', filters: [{ name: 'ffmpeg', extensions: ['exe'] }], properties: ['openFile'] }); return r.filePaths[0] ?? ''; },
  browse: async () => { const r = await dialog.showOpenDialog(settingsWin ?? win!, { filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] }); return r.filePaths[0] ?? ''; },
  quit: () => { quitting = true; app.quit(); },
  hide: () => win?.hide(),
};

const store = (doc: Doc, f: string) => {
  writeSafe(f, writeRundown(doc.items, doc.allowRemote));
  remember(f);
  return { path: f, name: path.basename(f).replace(/\.xml$/i, '') };
};
/** Needs a window on this PC, so not for a browser. */
const PC_ONLY = new Set(['open', 'browseFolder', 'browseExe', 'browse', 'webOpen', 'openSettings', 'quit', 'hide']);

async function dispatch(c: Client, name: string, args: unknown[]): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const h = Object.hasOwn(handlers, name) ? (handlers[name] as (...a: unknown[]) => unknown) : undefined;
  if (!h || (c.web && PC_ONLY.has(name))) return { ok: false, error: h ? 'That can only be done on the show PC' : `Unknown call ${name}` };
  try { return { ok: true, value: await asking.run(c, async () => h(...args)) }; } catch (err) { const m = (err as Error).message; log('err', '', m); return { ok: false, error: m }; }
}
ipcMain.handle('vt', async (e: IpcMainInvokeEvent, name: string, ...args: unknown[]) => {
  if (!e.senderFrame?.url.startsWith('file:')) throw new Error('Refused');
  return dispatch(settingsWin && e.sender === settingsWin.webContents ? { ...PC, id: 'settings' } : PC, name, args);
});

// ---- windows ------------------------------------------------------------------------------------------------
const web = () => ({ preload: path.join(ROOT, 'dist', 'preload.js'), contextIsolation: true, sandbox: true });
function guard(w: BrowserWindow): void {
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
}
function openMain(): void {
  if (win) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1560, height: 960, minWidth: 1180, minHeight: 700, title: 'CasparCG Client', icon: ICON, backgroundColor: '#1e1e1e',
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#383838', symbolColor: '#e8e8e8', height: 48 }, webPreferences: { ...web(), backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  guard(win);
  void win.loadFile(path.join(ROOT, 'static', 'index.html'));
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win!.webContents.send('askquit', engine.needed().map((d) => d.label));
  });
  win.on('closed', () => { win = null; });
}
function openSettings(): void {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 900, height: 700, minWidth: 760, minHeight: 520, title: 'Settings', icon: ICON, backgroundColor: '#1e1e1e', parent: win ?? undefined,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#383838', symbolColor: '#e8e8e8', height: 38 }, webPreferences: web(),
  });
  settingsWin.removeMenu();
  guard(settingsWin);
  void settingsWin.loadFile(path.join(ROOT, 'static', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

app.on('second-instance', () => openMain());
app.on('window-all-closed', () => { /* keep running: playlists need us */ });
app.on('before-quit', () => {
  engine?.saveNow();
  if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; writeSafe(ud('session.json'), JSON.stringify([...runner.docs.values()])); }
  preview?.cancel();
});

protocol.registerSchemesAsPrivileged([{ scheme: 'vtmedia', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);

void app.whenReady().then(() => {
  preview = new Preview(ud('preview-cache'), () => settings.ffmpeg || autoFfmpeg);
  protocol.handle('vtmedia', (r) => preview.serve(new URL(r.url).pathname.slice(1), r.headers.get('range') ?? undefined));
  Menu.setApplicationMenu(null);
  settings = loadSettings();
  if (!settings.web.code) { settings.web.code = newCode(); saveSettings(); }
  try { seen = JSON.parse(fs.readFileSync(ud('seen.json'), 'utf8')) as typeof seen; } catch { /* none yet */ }
  engine = new Engine(device, () => settings, ud('decks.json'));
  engine.on('log', (k: 'info', t: string) => log(k, 'Playlist', t));
  runner = new Runner(device, () => [...devices.values()], engine, () => settings);
  runner.on('log', (k: 'info', t: string) => log(k, '', t));
  runner.on('problem', problem);
  runner.on('playout', (c: string) => who().send('playout', c));
  try { for (const [k, v] of JSON.parse(fs.readFileSync(ud('media.json'), 'utf8')) as [string, string][]) autoMedia.set(k, v); } catch { /* none yet */ }
  for (const [, v] of autoMedia) { const ff = path.join(path.dirname(v), 'ffmpeg.exe'); if (fs.existsSync(ff)) autoFfmpeg = ff; }
  runner.docs = new Map(loadSession().map((d) => [d.id, d]));
  for (const d of runner.docs.values()) { revs.set(d.id, nextRev()); for (const i of flat(d.items)) if (i.type === 'SHELL') knownShell.add(shellOf(i)); }
  syncDevices();
  syncServices();
  openMain();
  if (fs.existsSync(ICON)) {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip('CasparCG Client');
    tray.on('click', openMain);
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Show CasparCG Client', click: openMain }, { type: 'separator' }, { label: 'Quit', click: () => { quitting = true; app.quit(); } }]));
  }
  setInterval(() => void watchMedia().catch(() => undefined), 8000);
  setInterval(() => { if (win?.isVisible()) win.webContents.send('state', state()); }, 66);
});
// Referenced so the tray is not collected.
export const _keep = () => [tray, stem];
