// Settings window (same layout as GMeet ISO's): sidebar plus grouped rows. Every control saves straight away.
import type { DeviceState, Settings } from '../shared/types';
import { h, icon, iconButton, popup, toggle, type Child } from './kit';
import { vt } from './store';

let s: Settings;
let pane = 'servers';
const call = async <T,>(n: string, ...a: unknown[]): Promise<T> => (await vt.call(n, ...a)).value as T;
const set = async (p: Partial<Settings>) => { s = await call<Settings>('setSettings', p); };

const row = (label: Child, ctrl: Child | Child[], note = '') => h('div.s-row', h('div.s-label', h('div', label, note ? h('div.s-cap', note) : null)), h('div.s-ctrl', ...(Array.isArray(ctrl) ? ctrl : [ctrl])));
const section = (t: string, rows: Child[], sub = '') => h('section.s-section', h('div.s-head', h('h2', t), sub ? h('p', sub) : null), h('div.s-group', ...rows));
const tog = (v: boolean, fn: (v: boolean) => void) => toggle(v, fn, { cls: 's-switch' }).el;
function field(v: string | number, fn: (v: string) => void, cls = ''): HTMLInputElement {
  const i = h('input.s-field', { type: 'text', spellcheck: 'false' }) as HTMLInputElement;
  if (cls) i.className += ' ' + cls;
  i.value = String(v);
  i.addEventListener('change', () => fn(i.value.trim()));
  i.addEventListener('keydown', (e) => e.key === 'Enter' && i.blur());
  return i;
}
function num(v: number, min: number, max: number, fn: (n: number) => void): HTMLInputElement {
  const i = field(v, (t) => { const n = Math.min(max, Math.max(min, Math.round(Number(t)))); if (!Number.isFinite(n)) { i.value = String(v); return; } i.value = String(n); fn(n); }, 'num');
  return i;
}
const sbtn = (label: string, fn: () => void) => { const b = h('button.s-btn', label) as HTMLButtonElement; b.addEventListener('click', fn); return b; };

/** Sound outputs on this PC, by name (ids differ between windows). */
async function outputs(): Promise<HTMLElement> {
  const list = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'audiooutput' && d.label && !['default', 'communications'].includes(d.deviceId)).map((d) => d.label);
  const names = [...new Set(list)];
  if (s.previewOutput && !names.includes(s.previewOutput)) names.unshift(s.previewOutput);
  return popup([{ value: '', label: 'Windows default' }, ...names.map((n) => ({ value: n, label: list.includes(n) ? n : `${n} (not connected)` }))], s.previewOutput, (v) => void set({ previewOutput: v })).el;
}

const PANES: Record<string, { label: string; icon: string; build: () => Promise<HTMLElement[]> | HTMLElement[] }> = {
  servers: { label: 'Servers', icon: 'database', build: async () => {
    const st = await call<DeviceState[]>('deviceStates');
    const edit = (n: number, p: Partial<Settings['devices'][number]>) => {
      const list = structuredClone(s.devices);
      if (p.name !== undefined && (!p.name || list.some((d, k) => k !== n && d.name === p.name))) return void render();
      Object.assign(list[n], p);
      void set({ devices: list }).then(render);
    };
    const cards = s.devices.map((d, n) => {
      const x = st.find((y) => y.name === d.name);
      return section(d.name, [
        row(h('span', h(`span.dot.${x?.connected ? 'ok' : 'bad'}`), `  ${x?.connected ? `CasparCG ${x.version}` : x?.error || 'Connecting'}`), s.devices.length > 1 ? sbtn('Remove', () => void set({ devices: s.devices.filter((_, k) => k !== n) }).then(render)) : null),
        row('Name', field(d.name, (v) => edit(n, { name: v })), 'Rundowns refer to servers by this name'),
        row('Address', field(d.host, (v) => edit(n, { host: v || '127.0.0.1' }))), row('Port', num(d.port, 1, 65535, (v) => edit(n, { port: v }))),
        row('Media folder', [h('span.s-dim', d.media || 'Found automatically'), sbtn('Choose…', () => void call<string>('browseFolder').then((f) => { if (f) edit(n, { media: f }); })), d.media ? sbtn('Reset', () => edit(n, { media: '' })) : null], 'Where previews read clips from. Found automatically when the server is on this PC'),
        row('Thumbnails from', field(d.scanner ?? '', (v) => edit(n, { scanner: v })), 'Media scanner address. Empty = port 8000 on the server'),
        row('Preview channel (F8)', num(d.preview, 0, 99, (v) => edit(n, { preview: v })), '0 makes F8 use the local preview'),
        row('Shadow server', tog(d.shadow, (v) => edit(n, { shadow: v })), 'Repeats every rundown command on this server too'),
      ]);
    });
    return [...cards, h('div.s-footer-actions', sbtn('Add server', () => { let k = s.devices.length + 1; while (s.devices.some((d) => d.name === `Server ${k}`)) k++; void set({ devices: [...s.devices, { name: `Server ${k}`, host: '127.0.0.1', port: 5250, preview: 0, shadow: false }] }).then(render); }))];
  } },
  playback: { label: 'Playback', icon: 'play', build: async () => [
    section('Transport', [row('Skip length (seconds)', num(s.skipSeconds, 1, 600, (v) => void set({ skipSeconds: v })), 'Used by back and forward')]),
    section('Clip preview', [row('Sound output', await outputs(), 'Where preview sound plays. It stays silent if this is unplugged'), row('ffmpeg', [h('span.s-dim', s.ffmpeg || 'Found automatically'), sbtn('Choose…', () => void call<string>('browseExe').then((f) => { if (f) void set({ ffmpeg: f }).then(render); })), s.ffmpeg ? sbtn('Reset', () => void set({ ffmpeg: '' }).then(render)) : null], 'Makes small preview copies of clips this PC cannot play directly, such as ProRes')], 'Previews play the file on this PC. They do not use the server.'),
  ] },
  rundown: { label: 'Rundown', icon: 'list', build: () => [section('Rundown', [
    row('Compact rows', tog(s.compact, (v) => void set({ compact: v }))), row('Mark items as used', tog(s.markUsed, (v) => void set({ markUsed: v }))),
    row('Preview after auto step', tog(s.autoStepPreview, (v) => void set({ autoStepPreview: v }))), row('Ask before Clear Channel (F12)', tog(s.confirmClear, (v) => void set({ confirmClear: v }))),
  ]), section('Shell commands', [row('Allow Shell Command items', tog(s.allowShell, (v) => void set({ allowShell: v })), 'They can run any program on this PC. Leave off unless you trust the rundowns you open')])] },
  web: { label: 'Web Interface', icon: 'globe', build: async () => {
    const w = await call<{ state: string; addresses: string[] }>('webInfo');
    const put = (p: Partial<Settings['web']>) => void set({ web: { ...s.web, ...p } }).then(later);
    return [section('Web interface', [
      row('Web interface', tog(s.web.enabled, (v) => put({ enabled: v })), w.state), row('Port', num(s.web.port, 1024, 65535, (v) => put({ port: v }))),
      row('Allow other devices', tog(s.web.lan, (v) => put({ lan: v })), 'Phones, tablets and computers on this network. Windows may ask to allow it'),
      row('Access code', [h('b.s-code', s.web.code), sbtn('New code', () => void call<Settings>('webNewCode').then((x) => { s = x; void render(); }))], 'A new code signs every device out'),
      ...(s.web.enabled ? [row('Address', h('div.s-mono', ...[`http://127.0.0.1:${s.web.port}`, ...w.addresses.map((a) => `http://${a}:${s.web.port}`)].map((a) => h('div', a))), s.web.lan ? 'Open one of these on the other device and enter the code' : 'This computer only'), h('div.s-row', sbtn('Open here', () => void call('webOpen')))] : []),
    ], 'Control the open rundowns and channels from a browser. It cannot edit. The connection is not encrypted, so use it on a network you trust.')];
  } },
  remote: { label: 'Remote Control', icon: 'osc', build: async () => {
    const sv = await call<Record<string, string>>('services');
    const b = 'http://127.0.0.1:' + s.http.port;
    return [
      section('HTTP', [row('HTTP control', tog(s.http.enabled, (v) => void set({ http: { ...s.http, enabled: v } }).then(later)), sv.http), row('Port', num(s.http.port, 1024, 65535, (v) => void set({ http: { ...s.http, port: v } }).then(later))),
        h('div.s-row', h('div.s-mono', `${b}/layer/1-10/play   pause   stop   back   forward   next   prev`, h('br'), `${b}/take/2-10/1-10/cut   cutplay   fade   fadeplay   (from, to)`, h('br'), `${b}/playlist/1/load   play   next   prev   (number or name)`, h('br'), `${b}/item/<remote id>/play   stop   load   …`))], 'Only this computer can use it.'),
      section('OSC', [row('OSC control', tog(s.osc.enabled, (v) => void set({ osc: { ...s.osc, enabled: v } }).then(later)), sv.osc), row('Port', num(s.osc.port, 1024, 65535, (v) => void set({ osc: { ...s.osc, port: v } }).then(later)))], 'Uses the same /control/… addresses as the original client.'),
      section('Countdown overlays', [row('Countdown feed', tog(s.countdown.enabled, (v) => void set({ countdown: { ...s.countdown, enabled: v } }).then(later)), sv.countdown), row('Port', num(s.countdown.port, 1024, 65535, (v) => void set({ countdown: { ...s.countdown, port: v } }).then(later))),
        row('Amber at (seconds)', num(s.countdown.caution, 0, 3600, (v) => void set({ countdown: { ...s.countdown, caution: v } }))), row('Red at (seconds)', num(s.countdown.warn, 0, 3600, (v) => void set({ countdown: { ...s.countdown, warn: v } }))), row('Flash at (seconds)', num(s.countdown.flash, 0, 3600, (v) => void set({ countdown: { ...s.countdown, flash: v } })))], 'Feeds the monitor overlays, in place of the countdown helper.'),
      section('Earlier VT controller', [row('Clip list', [h('span.s-dim', s.legacyConfig || 'Not set'), sbtn('Choose…', () => void call<string>('browse').then((f) => { if (f) void set({ legacyConfig: f }).then(render); }))], 'Keeps existing Companion buttons working (vt_config.json)')]),
    ];
  } },
  osc: { label: 'OSC Targets', icon: 'ndiSource', build: () => [section('OSC targets', [
    ...s.oscOutputs.map((o, n) => {
      const put = (p: Partial<typeof o>) => { const l = structuredClone(s.oscOutputs); Object.assign(l[n], p); void set({ oscOutputs: l }); };
      return h('div.s-row', field(o.name, (v) => put({ name: v })), field(o.host, (v) => put({ host: v })), num(o.port, 1, 65535, (v) => put({ port: v })), iconButton('trash', () => void set({ oscOutputs: s.oscOutputs.filter((_, k) => k !== n) }).then(render), 'Remove', 'plain'));
    }),
    h('div.s-row', sbtn('Add target', () => void set({ oscOutputs: [...s.oscOutputs, { name: `Target ${s.oscOutputs.length + 1}`, host: '127.0.0.1', port: 7250 }] }).then(render))),
  ], 'Where OSC Output items can send to.')] },
  keys: { label: 'Shortcuts', icon: 'bolt', build: () => [['Playing', [['F1', 'Stop'], ['F2', 'Play'], ['Shift+F2', 'Play now'], ['F3', 'Load'], ['F4', 'Pause / resume'], ['F5', 'Next'], ['Shift+F5', 'Previous (playlists)'], ['F6', 'Update'], ['F7', 'Invoke'], ['F8', 'Preview'], ['F10', 'Clear'], ['F11', 'Clear layer'], ['F12', 'Clear channel']]],
    ['Clips', [['Space', 'Play / pause the local preview'], ['Alt+Left / Right', 'Back / forward on the server']]],
    ['Editing', [['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+C / X / V', 'Copy / cut / paste'], ['Ctrl+E', 'Switch between Edit and Show'], ['Ctrl+D', 'Duplicate'], ['Ctrl+Shift+C / V', 'Copy / apply template'], ['Ctrl+G', 'Group'], ['Ctrl+Shift+G', 'Ungroup'], ['Ctrl+P', 'Make playlist'], ['Ctrl+[ / ]', 'Collapse / expand all'], ['Delete', 'Delete']]],
    ['Files', [['Ctrl+N', 'New'], ['Ctrl+O', 'Open'], ['Ctrl+S', 'Save'], ['Ctrl+Shift+S', 'Save as'], ['Ctrl+W', 'Close tab'], ['Ctrl+Tab', 'Next tab'], ['Ctrl+F', 'Search library']]]].map(([t, r]) => section(t as string, (r as string[][]).map(([k, l]) => row(l, h('kbd', k))))) },
};

let timer = 0;
/** Service status settles a moment after a port changes. */
const later = () => { clearTimeout(timer); timer = window.setTimeout(render, 300); };
const side = h('div.s-sidebar');
const scroll = h('div.s-scroll');
async function render(): Promise<void> {
  side.textContent = '';
  for (const [k, p] of Object.entries(PANES)) {
    const b = h('button.s-tab' + (k === pane ? '.active' : ''), icon(p.icon), p.label);
    b.addEventListener('click', () => { pane = k; void render(); });
    side.append(b);
  }
  const top = scroll.scrollTop;
  const els = await PANES[pane].build();
  scroll.replaceChildren(h('div.s-pane', ...els));
  scroll.scrollTop = top;
}
void (async () => {
  s = await call<Settings>('getSettings');
  document.getElementById('app')!.append(h('div.titlebar', h('span.title', 'Settings')), h('div.s-window', side, h('div.s-content', scroll)));
  await render();
})();
