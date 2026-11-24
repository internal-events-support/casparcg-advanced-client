// Left column: media, templates, tools, stored data and presets. Drag anything into the rundown or a playlist.
import { newItem, TOOLS } from '../shared/tools';
import type { Item, Library, MediaEntry } from '../shared/types';
import { button, confirmSheet, h, icon, iconButton, menu, popup, promptSheet, segmented, textField } from './kit';
import { previewClip } from './preview';
import { call, clock, homeDevice, insert, itemFromMedia, on, playlists, selectedTop, store, thumb, toast, wrap } from './store';

type Tab = 'media' | 'templates' | 'tools' | 'data' | 'presets';
let tab: Tab = 'media';
let filter = '';
let kind = 'ALL';
let device = '';
const open = new Set<string>();
const picked = new Set<string>();
let anchor = '';

export const DRAG = 'application/x-vt';
export function dragItems(e: DragEvent): Item[] {
  const s = e.dataTransfer?.getData(DRAG);
  if (!s) return [];
  try { return (JSON.parse(s) as { items?: Item[] }).items ?? []; } catch { return []; }
}
function draggable(el: HTMLElement, make: () => Item[]): void {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer!.setData(DRAG, JSON.stringify({ items: make() }));
    e.dataTransfer!.effectAllowed = 'copy';
  });
}

const lazy = new IntersectionObserver((es) => {
  for (const e of es) {
    if (!e.isIntersecting) continue;
    const img = e.target as HTMLImageElement;
    lazy.unobserve(img);
    void thumb(img.dataset.name!, img.dataset.device).then((u) => { if (u) img.src = u; else img.classList.add('none'); });
  }
});
export function thumbImg(name: string, dev = device): HTMLImageElement {
  const img = h('img.thumb', { alt: '', dataset: { name, device: dev || homeDevice() } }) as HTMLImageElement;
  lazy.observe(img);
  return img;
}

const KIND_ICON: Record<string, string> = { MOVIE: 'film', STILL: 'image', AUDIO: 'waveform' };

export function buildLibrary(): HTMLElement {
  const tabs = segmented([
    { value: 'media', label: '', icon: 'film', title: 'Media' }, { value: 'templates', label: '', icon: 'template', title: 'Templates' },
    { value: 'tools', label: '', icon: 'sliders', title: 'Tools' }, { value: 'data', label: '', icon: 'database', title: 'Stored data' }, { value: 'presets', label: '', icon: 'star', title: 'Presets' },
  ], tab, (v) => { tab = v as Tab; tabs.set(v); render(); }, 'sm');
  const search = textField('', (v) => { filter = v.toLowerCase(); render(); }, { placeholder: 'Search', cls: 'search', live: true });
  search.el.id = 'lib-search';
  const kinds = popup([{ value: 'ALL', label: 'All' }, { value: 'MOVIE', label: 'Videos' }, { value: 'STILL', label: 'Images' }, { value: 'AUDIO', label: 'Audio' }], kind, (v) => { kind = v; render(); }, { cls: 'sm' });
  const dev = popup([], '', (v) => { device = v; render(); }, { cls: 'sm' });
  const reload = iconButton('refresh', () => void call('refresh', device).then(() => toast('Library refreshed')), 'Refresh library', 'plain');
  const title = h('span.lib-title');
  const list = h('div.lib-list');
  const foot = h('div.lib-foot');

  const lib = (): Library => store.library[device] ?? { media: [], templates: [], data: [], presets: [] };
  const hit = (s: string) => !filter || filter.split(/\s+/).every((w) => s.toLowerCase().includes(w));
  const empty = (msg: string) => list.append(h('div.lib-empty', msg));

  function mediaRow(m: MediaEntry, all: MediaEntry[]): HTMLElement {
    const base = m.name.split('/').pop()!;
    const row = h('div.lib-row', { title: `${m.name}${m.seconds ? `\n${clock(m.seconds)}  ${m.fps.toFixed(2)} fps` : ''}`, dataset: { name: m.name } },
      h('div.lib-thumb', m.type === 'AUDIO' ? icon('waveform') : thumbImg(m.name, device)),
      h('div.lib-text', h('div.lib-name', base), h('div.lib-sub', icon(KIND_ICON[m.type]), m.type === 'STILL' ? 'Image' : clock(m.seconds))));
    row.classList.toggle('sel', picked.has(m.name));
    const names = () => all.map((x) => x.name);
    const chosen = () => (picked.has(m.name) ? all.filter((x) => picked.has(x.name)) : [m]);
    row.addEventListener('click', (e) => {
      if (e.ctrlKey) { if (picked.has(m.name)) picked.delete(m.name); else picked.add(m.name); anchor = m.name; }
      else if (e.shiftKey && anchor) {
        const a = names().indexOf(anchor);
        const b = names().indexOf(m.name);
        picked.clear();
        names().slice(Math.min(a, b), Math.max(a, b) + 1).forEach((n) => picked.add(n));
      } else { picked.clear(); picked.add(m.name); anchor = m.name; }
      if (picked.size === 1) previewClip(device, m.name);
      list.querySelectorAll<HTMLElement>('.lib-row').forEach((r) => r.classList.toggle('sel', picked.has(r.dataset.name ?? '')));
    });
    row.addEventListener('dblclick', () => insert([itemFromMedia(m)]));
    draggable(row, () => chosen().map(itemFromMedia));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const c = chosen();
      const vids = c.filter((x) => x.type === 'MOVIE');
      menu({ x: e.clientX, y: e.clientY }, [
        { label: c.length > 1 ? `Add ${c.length} to rundown` : 'Add to rundown', icon: 'plus', onClick: () => insert(c.map(itemFromMedia)) },
        { label: 'Preview', icon: 'preview', disabled: c.length > 1, onClick: () => previewClip(device, m.name) },
        null,
        { label: 'New playlist from selection', icon: 'playlist', disabled: !vids.length, onClick: () => newPlaylist(vids) },
        ...playlists().filter((p) => p.doc.id === store.active).slice(0, 8).map((p) => ({ label: `Add to ${p.item.label}`, icon: 'playlist', disabled: !vids.length, onClick: () => insert(vids.map(itemFromMedia), { parent: p.item.id, index: p.item.items!.length }) })),
      ]);
    });
    return row;
  }

  function renderMedia(): void {
    const all = lib().media.filter((m) => (kind === 'ALL' || m.type === kind) && hit(m.name));
    if (!all.length) return empty(filter ? 'Nothing matches' : store.state?.devices.some((d) => d.connected) ? 'No media found. Is the media scanner running?' : 'Not connected');
    const folders = new Map<string, MediaEntry[]>();
    for (const m of all) {
      const f = m.name.includes('/') ? m.name.slice(0, m.name.lastIndexOf('/')) : '';
      if (!folders.has(f)) folders.set(f, []);
      folders.get(f)!.push(m);
    }
    const flat: MediaEntry[] = [];
    for (const f of [...folders.keys()].sort()) {
      const inside = folders.get(f)!;
      const isOpen = !f || !!filter || open.has(f);
      if (f) {
        const head = h('button.lib-folder' + (isOpen ? '' : '.shut'), icon('chevronDown'), icon('folder'), h('span', f), h('em', String(inside.length)));
        head.addEventListener('click', () => { if (open.has(f)) open.delete(f); else open.add(f); render(); });
        list.append(head);
      }
      if (isOpen) flat.push(...inside);
      if (isOpen) for (const m of inside) list.append(mediaRow(m, flat));
    }
  }

  function simple(name: string, ico: string, sub: string, make: () => Item[] | null, extra: { items?: Parameters<typeof menu>[1]; dbl?: () => void; color?: string } = {}): void {
    const row = h('div.lib-row.slim', { title: name }, h('span.lib-ico', { style: extra.color ? `color:${extra.color}` : '' }, icon(ico)), h('div.lib-text', h('div.lib-name', name), sub ? h('div.lib-sub', sub) : null));
    row.addEventListener('dblclick', () => (extra.dbl ? extra.dbl() : insert(make() ?? [])));
    const probe = make();
    if (probe) draggable(row, () => make() ?? []);
    if (extra.items) row.addEventListener('contextmenu', (e) => { e.preventDefault(); menu({ x: e.clientX, y: e.clientY }, extra.items!); });
    list.append(row);
  }

  function render(): void {
    const devs = store.settings.devices.map((d) => d.name);
    if (!devs.includes(device)) device = devs[0] ?? '';
    dev.set(devs.map((d) => ({ value: d, label: d })), device);
    dev.el.hidden = devs.length < 2 || tab === 'tools' || tab === 'presets';
    kinds.el.hidden = tab !== 'media';
    reload.hidden = tab === 'tools' || tab === 'presets';
    title.textContent = { media: 'Media', templates: 'Templates', tools: 'Tools', data: 'Stored data', presets: 'Presets' }[tab];
    const top = list.scrollTop;
    list.textContent = '';
    foot.textContent = '';
    foot.hidden = true;
    if (tab === 'media') renderMedia();
    else if (tab === 'templates') {
      const t = lib().templates.filter(hit);
      if (!t.length) empty(filter ? 'Nothing matches' : 'No templates found');
      for (const n of t) simple(n, 'template', '', () => [newItem('TEMPLATE', { label: n.split('/').pop()!, name: n, device: device || homeDevice() })]);
    } else if (tab === 'tools') {
      for (const cat of ['Structure', 'Library', 'Mixer', 'Other'] as const) {
        const ts = TOOLS.filter((t) => t.cat === cat && hit(t.label)).sort((x, y) => (cat === 'Structure' ? 0 : x.label.localeCompare(y.label)));
        if (!ts.length) continue;
        list.append(h('div.lib-cat', cat));
        for (const t of ts) {
          simple(t.label, t.icon, '', () => [newItem(t.type, { device: t.out.includes('device') ? device || homeDevice() : '', ...(t.type === 'PLAYLIST' ? { label: `Playlist ${playlists().length + 1}` } : {}) })], { color: t.color });
        }
      }
    } else if (tab === 'data') {
      const ds = lib().data.filter(hit);
      if (!ds.length) empty('No stored data');
      for (const n of ds) {
        simple(n, 'database', '', () => [newItem('TEMPLATE', { label: n, device: device || homeDevice(), props: { usestoreddata: true }, data: [{ key: 'data', value: n }] })], {
          items: [
            { label: 'View', icon: 'eye', onClick: () => void call<string>('dataRead', device, n).then((v) => { if (v !== undefined) toast(v || '(empty)'); }) },
            { label: 'Delete…', icon: 'trash', destructive: true, onClick: () => void confirmSheet(`Delete “${n}”?`, 'It is removed from the server and cannot be brought back.', 'Delete', true).then((y) => { if (y) void call('dataRemove', device, n); }) },
          ],
        });
      }
      foot.hidden = false;
      foot.append(button('Store data…', () => void storeData(), 'sm'));
    } else {
      const ps = (Object.values(store.library)[0]?.presets ?? []).filter(hit);
      if (!ps.length) empty('Select items in the rundown, then save them as a preset');
      for (const n of ps) {
        const use = () => void call<Item[]>('presetLoad', n).then((i) => { if (i) insert(i); });
        simple(n, 'star', '', () => null, { dbl: use, items: [
          { label: 'Add to rundown', icon: 'plus', onClick: use },
          { label: 'Delete…', icon: 'trash', destructive: true, onClick: () => void confirmSheet(`Delete preset “${n}”?`, 'This cannot be undone.', 'Delete', true).then((y) => { if (y) void call<string[]>('presetRemove', n).then((r) => setPresets(r)); }) },
        ] });
      }
      foot.hidden = false;
      foot.append(button('Save selection as preset…', () => void savePreset(), 'sm'));
    }
    list.scrollTop = top;
  }
  const setPresets = (r?: string[]) => { if (!r) return; for (const l of Object.values(store.library)) l.presets = r; render(); };
  async function savePreset(): Promise<void> {
    const s = selectedTop();
    if (!s.length) return toast('Select something in the rundown first', 'bad');
    const n = await promptSheet('Preset name', s[0].label, 'Save');
    if (n?.trim()) setPresets(await call<string[]>('presetSave', n.trim(), s));
  }
  async function storeData(): Promise<void> {
    const n = await promptSheet('Name', '', 'Next');
    if (!n?.trim()) return;
    const v = await promptSheet(`Value for ${n.trim()}`, '', 'Store');
    if (v !== null) await call('dataStore', device, n.trim(), v);
  }

  on('library', render);
  on('settings', render);
  let was = '';
  on('state', () => {
    const now = (store.state?.devices ?? []).map((d) => d.connected).join();
    if (now !== was) { was = now; render(); }
  });
  on('doc', () => { if (tab === 'media') return; });
  render();
  return h('aside.library', h('div.lib-head', h('div.lib-tabs', tabs.el), h('div.lib-line', title, h('span.spacer'), dev.el, kinds.el, reload), search.el), list, foot);
}

export function newPlaylist(vids: MediaEntry[]): void {
  insert([newItem('PLAYLIST', { label: `Playlist ${playlists().length + 1}`, device: homeDevice(), items: vids.map(itemFromMedia) })]);
}
export { wrap };
