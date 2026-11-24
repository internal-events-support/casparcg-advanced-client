// App shell: windows, settings, documents and IPC. Playback keeps running here if the window is closed.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, Tray, type IpcMainInvokeEvent } from 'electron';
import type dgram from 'node:dgram';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { newItem } from '../shared/tools';
import { DEFAULT_SETTINGS, stem, uid, type Action, type AppState, type Doc, type Item, type Library, type Loc, type LogLine, type Settings } from '../shared/types';
import { parseRundown, writeRundown } from '../shared/xml';
import { readLegacy, startCountdown, startHttp, startOsc, takeOpts, type ApiHooks } from './api';
import { q } from './commands';
import { Device } from './device';
import { Engine, Refused } from './engine';
import { Preview } from './preview';
import { Runner } from './runner';

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

// ---- settings -------------------------------------------------------------------------------------
function loadSettings(): Settings {
  let s: Partial<Settings> = {};
  try { s = JSON.parse(fs.readFileSync(ud('settings.json'), 'utf8')) as Partial<Settings>; } catch { /* first run */ }
  const d = structuredClone(DEFAULT_SETTINGS);
  const known = Object.fromEntries(Object.entries(s).filter(([k]) => k in d)); // drop settings from earlier versions
  return { ...d, ...known, http: { ...d.http, ...s.http }, osc: { ...d.osc, ...s.osc }, countdown: { ...d.countdown, ...s.countdown } };
}
let settings: Settings;
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
  win?.webContents.send('log', l);
}
const toast = (text: string, kind: 'ok' | 'bad' = 'ok') => win?.webContents.send('toast', text, kind);
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
  library[name] = { media: await safe(d.media(), []), templates: await safe(d.templates(), []), data: await safe(d.data(), []), presets: presetNames() };
  win?.webContents.send('library', name, library[name]);
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
const services = { http: 'Off', osc: 'Off', countdown: 'Off' };

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
    const layer = engine.layer(engine.home(), ch, settings.countdown.layer);
    return { layer, next: layer.next ? layer.next.replace(/\\/g, '/').split('/').pop()! : '' };
  },
  log: (k, t) => log(k, 'Remote', t),
};
const flat = (items: Item[]): Item[] => items.flatMap((i) => [i, ...flat(i.items ?? [])]);

function syncServices(): void {
  httpSrv?.close(); httpSrv?.closeAllConnections?.(); httpSrv = null;
  try { oscSrv?.close(); } catch { /* was not open */ }
  oscSrv = null;
  cdSrv?.close(); cdSrv?.closeAllConnections?.(); cdSrv = null;
  services.http = services.osc = services.countdown = 'Off';
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
  const doc: Doc = { id: uid(), path: file, name: path.basename(file).replace(/\.xml$/i, ''), allowRemote, dirty: false, items };
  remember(file);
  return doc;
}
function remember(file: string): void {
  settings.recent = [file, ...settings.recent.filter((f) => f !== file)].slice(0, 10);
  saveSettings();
  win?.webContents.send('settings', settings);
}
function saveSettings(): void { writeSafe(ud('settings.json'), JSON.stringify(settings, null, 2)); }

function setDocs(docs: Doc[]): void {
  const before = new Map(runner.playlists().map((p) => [p.id, JSON.stringify([p.props, (p.items ?? []).map((i) => [i.id, i.name])])]));
  runner.docs = new Map(docs.map((d) => [d.id, d]));
  for (const p of runner.playlists()) {
    const now = JSON.stringify([p.props, (p.items ?? []).map((i) => [i.id, i.name])]);
    if (before.has(p.id) && before.get(p.id) !== now) void engine.run(() => engine.playlistEdited(p)).catch(problem);
  }
  scheduleSession(docs);
}
let sessionTimer: NodeJS.Timeout | null = null;
function scheduleSession(docs: Doc[]): void {
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => { sessionTimer = null; writeSafe(ud('session.json'), JSON.stringify(docs)); }, 300);
}
function loadSession(): Doc[] {
  try { return (JSON.parse(fs.readFileSync(ud('session.json'), 'utf8')) as Doc[]).filter((d) => Array.isArray(d.items)); } catch { return []; }
}

// ---- IPC ---------------------------------------------------------------------------------------------------
const XML_FILTER = [{ name: 'CasparCG rundown', extensions: ['xml'] }];
const handlers: Record<string, (...a: never[]) => unknown> = {
  init: () => ({ settings, docs: loadSession(), library, logs: logs.slice(-500), state: state(), version: __APP_VERSION__ }),
  docs: (docs: Doc[]) => setDocs(docs),
  execute: (id: string, a: Action) => runner.execute(id, a),
  transport: (t: Loc, v: string) => hooks.transport(t, v),
  seek: (t: Loc, s: number) => engine.run(() => engine.seek(t, s, true)),
  take: (a: Loc, b: Loc, o: { fade: boolean; roll: boolean; hold: boolean; frames: number }) => hooks.take(a, b, o),
  used: (ids: string[], u: boolean) => runner.setUsed(ids, u),
  previewOpen: (dev: string, name: string) => preview.open(mediaFolder(dev), name),
  previewCancel: () => preview.cancel(),
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
  openPath: (f: string) => openDoc(f),
  save: async (doc: Doc, as: boolean) => {
    let f = doc.path;
    if (as || !f) {
      const r = await dialog.showSaveDialog(win!, { title: 'Save rundown', filters: XML_FILTER, defaultPath: f || doc.name + '.xml' });
      if (r.canceled || !r.filePath) return null;
      f = r.filePath;
    }
    writeSafe(f, writeRundown(doc.items, doc.allowRemote));
    remember(f);
    return { path: f, name: path.basename(f).replace(/\.xml$/i, '') };
  },
  presetSave: (name: string, items: Item[]) => { writeSafe(presetFile(name), writeRundown(items, false)); for (const n of devices.keys()) if (library[n]) { library[n].presets = presetNames(); win?.webContents.send('library', n, library[n]); } return presetNames(); },
  presetLoad: (name: string) => parseRundown(fs.readFileSync(presetFile(name), 'utf8')).items,
  presetRemove: (name: string) => { fs.rmSync(presetFile(name), { force: true }); return presetNames(); },
  presets: () => presetNames(),
  getSettings: () => settings,
  setSettings: async (patch: Partial<Settings>) => {
    const svc = JSON.stringify([settings.http, settings.osc, settings.countdown]);
    settings = { ...settings, ...patch };
    saveSettings();
    syncDevices();
    if (JSON.stringify([settings.http, settings.osc, settings.countdown]) !== svc) syncServices();
    win?.webContents.send('settings', settings);
    settingsWin?.webContents.send('settings', settings);
    return settings;
  },
  openSettings: () => openSettings(),
  services: () => services,
  deviceStates: () => state().devices,
  browseFolder: async () => { const r = await dialog.showOpenDialog(settingsWin ?? win!, { properties: ['openDirectory'] }); return r.filePaths[0] ?? ''; },
  browseExe: async () => { const r = await dialog.showOpenDialog(settingsWin ?? win!, { title: 'Choose ffmpeg.exe', filters: [{ name: 'ffmpeg', extensions: ['exe'] }], properties: ['openFile'] }); return r.filePaths[0] ?? ''; },
  browse: async () => { const r = await dialog.showOpenDialog(settingsWin ?? win!, { filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] }); return r.filePaths[0] ?? ''; },
  quit: () => { quitting = true; app.quit(); },
  hide: () => win?.hide(),
};

ipcMain.handle('vt', async (e: IpcMainInvokeEvent, name: string, ...args: unknown[]) => {
  if (!e.senderFrame?.url.startsWith('file:')) throw new Error('Refused');
  const h = handlers[name] as ((...a: unknown[]) => unknown) | undefined;
  if (!h) throw new Error(`Unknown call ${name}`);
  try { return { ok: true, value: await h(...args) }; } catch (err) { const m = (err as Error).message; log('err', '', m); return { ok: false, error: m }; }
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
    width: 1560, height: 960, minWidth: 1180, minHeight: 700, title: 'Caspar VT', icon: ICON, backgroundColor: '#1e1e1e',
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
  preview?.cancel();
});

protocol.registerSchemesAsPrivileged([{ scheme: 'vtmedia', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);

void app.whenReady().then(() => {
  preview = new Preview(ud('preview-cache'), () => settings.ffmpeg || autoFfmpeg, (p) => win?.webContents.send('previewProgress', p));
  protocol.handle('vtmedia', (r) => preview.serve(r));
  Menu.setApplicationMenu(null);
  settings = loadSettings();
  engine = new Engine(device, () => settings, ud('decks.json'));
  engine.on('log', (k: 'info', t: string) => log(k, 'Playlist', t));
  runner = new Runner(device, () => [...devices.values()], engine, () => settings);
  runner.on('log', (k: 'info', t: string) => log(k, '', t));
  runner.on('problem', problem);
  runner.on('playout', (c: string) => win?.webContents.send('playout', c));
  try { for (const [k, v] of JSON.parse(fs.readFileSync(ud('media.json'), 'utf8')) as [string, string][]) autoMedia.set(k, v); } catch { /* none yet */ }
  for (const [, v] of autoMedia) { const ff = path.join(path.dirname(v), 'ffmpeg.exe'); if (fs.existsSync(ff)) autoFfmpeg = ff; }
  runner.docs = new Map(loadSession().map((d) => [d.id, d]));
  syncDevices();
  syncServices();
  openMain();
  if (fs.existsSync(ICON)) {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip('Caspar VT');
    tray.on('click', openMain);
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Show Caspar VT', click: openMain }, { type: 'separator' }, { label: 'Quit', click: () => { quitting = true; app.quit(); } }]));
  }
  setInterval(() => { if (win?.isVisible()) win.webContents.send('state', state()); }, 66);
});
// Referenced so the tray is not collected.
export const _keep = () => [tray, stem];
