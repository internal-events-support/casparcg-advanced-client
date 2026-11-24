// Right column: properties of the selected item(s). Built from the tool definitions.
import { isContainer, isPlaylist, tool, type Prop } from '../shared/tools';
import type { Item } from '../shared/types';
import { button, checkbox, h, icon, iconButton, popup, stepper, textField, toggle, type Child } from './kit';
import { COLORS } from './rundown';
import { missing, relinkSheet } from './relinkui';
import { clock, edit, execute, homeDevice, itemSeconds, media, on, selected, store } from './store';

const same = <T,>(items: Item[], get: (i: Item) => T): T | undefined => {
  const v = get(items[0]);
  return items.every((i) => get(i) === v) ? v : undefined;
};

export function buildInspector(): HTMLElement {
  const body = h('div.in-body');
  const title = h('span.in-title', 'Inspector');
  const sub = h('span.caption');

  const row = (label: Child, control: HTMLElement, hint = '') => h('div.in-row', { title: hint }, h('label', label), control);
  const section = (name: string, rows: (HTMLElement | null)[]) => h('section.in-sec', h('h4', name), h('div.group', ...rows.filter((r): r is HTMLElement => !!r)));

  function num(items: Item[], get: (i: Item) => number, set: (i: Item, v: number) => void, key: string, o: { min?: number; max?: number; step?: number } = {}): HTMLElement {
    const v = same(items, get);
    const ids = items.map((i) => i.id);
    const input = h('input.field.num', { type: 'text', inputmode: 'decimal', placeholder: v === undefined ? 'Mixed' : '' }) as HTMLInputElement;
    input.value = v === undefined ? '' : String(v);
    const commit = (n: number) => {
      if (!Number.isFinite(n)) { input.value = v === undefined ? '' : String(get(items[0])); return; }
      const c = Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, n));
      const r = Math.round(c * 1e4) / 1e4;
      input.value = String(r);
      edit(ids, key, (i) => set(i, r));
    };
    input.addEventListener('change', () => commit(Number(input.value.replace(',', '.'))));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      const s = o.step ?? 1;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); commit((Number(input.value) || 0) + (e.key === 'ArrowUp' ? s : -s) * (e.shiftKey ? 10 : 1)); }
      e.stopPropagation();
    });
    return input;
  }

  function propRow(items: Item[], p: Prop): HTMLElement {
    const ids = items.map((i) => i.id);
    const get = (i: Item) => i.props[p.key] ?? p.def;
    const set = (v: string | number | boolean) => edit(ids, p.key, (i) => { i.props[p.key] = v; });
    const v = same(items, get);
    if (p.kind === 'bool') return row(p.label, toggle(v === true, (x) => set(x), { cls: 'sm blue' }).el, p.hint);
    if (p.kind === 'select') {
      const opts = [...(p.options ?? [])];
      if (v !== undefined && !opts.includes(String(v))) opts.unshift(String(v));
      return row(p.label, popup([...(v === undefined ? [{ value: '', label: 'Mixed', disabled: true }] : []), ...opts.map((o) => ({ value: o, label: o }))], String(v ?? ''), (x) => set(x), { cls: 'sm' }).el, p.hint);
    }
    if (p.kind === 'num' || p.kind === 'int' || p.kind === 'pct') return row(p.label, num(items, (i) => Number(get(i)), (i, n) => { i.props[p.key] = p.kind === 'int' ? Math.round(n) : n; }, p.key, p), p.hint);
    if (p.kind === 'color') {
      const hex = String(v ?? '#FF000000').replace('#', '').padStart(8, 'F');
      const c = h('input', { type: 'color' }) as HTMLInputElement;
      c.value = `#${hex.slice(2)}`;
      const a = h('input.field.num', { title: 'Opacity %' }) as HTMLInputElement;
      a.value = String(Math.round((parseInt(hex.slice(0, 2), 16) / 255) * 100));
      const put = () => set(`#${Math.round((Math.min(100, Math.max(0, Number(a.value) || 0)) / 100) * 255).toString(16).padStart(2, '0')}${c.value.slice(1)}`.toUpperCase());
      c.addEventListener('change', put);
      a.addEventListener('change', put);
      return row(p.label, h('span.in-color', h('label.in-well', { style: `background:${c.value}` }, c), a, h('span.caption', '%')), p.hint);
    }
    if (p.kind === 'area') {
      const t = h('textarea.field.area', { rows: 3, spellcheck: false }) as HTMLTextAreaElement;
      t.value = String(v ?? '');
      t.addEventListener('change', () => set(t.value));
      t.addEventListener('keydown', (e) => e.stopPropagation());
      return h('div.in-row.tall', h('label', p.label), t);
    }
    const f = textField(String(v ?? ''), (x) => set(x), { placeholder: v === undefined ? 'Mixed' : '' });
    const el = row(p.label, f.el, p.hint);
    if (['url', 'output', 'path', 'message'].includes(p.key) || p.key.endsWith('Command')) el.classList.add('wide');
    return el;
  }

  function dataTable(i: Item): HTMLElement {
    const kv = i.data ?? [];
    const put = (fn: (d: { key: string; value: string }[]) => void) => edit([i.id], 'data', (x) => { x.data ??= []; fn(x.data); });
    const rows = kv.map((d, n) => h('div.in-kv', textField(d.key, (v) => put((a) => { a[n].key = v; }), { placeholder: 'Key' }).el, textField(d.value, (v) => put((a) => { a[n].value = v; }), { placeholder: 'Value' }).el,
      iconButton('x', () => { put((a) => a.splice(n, 1)); render(); }, 'Remove', 'plain')));
    return h('section.in-sec', h('h4', 'Data'), h('div.group', ...rows, h('div.in-row', button('Add field', () => { put((a) => a.push({ key: `f${a.length}`, value: '' })); render(); }, 'sm'))));
  }

  let sig = '';
  function render(): void {
    const items = selected();
    const top = body.scrollTop;
    body.textContent = '';
    sig = items.map((i) => i.id).join();
    if (!items.length) {
      title.textContent = 'Inspector';
      sub.textContent = '';
      body.append(h('div.lib-empty', 'Select an item to edit it'));
      return;
    }
    const ids = items.map((i) => i.id);
    const one = items.length === 1 ? items[0] : null;
    const t = tool(items[0].type);
    const alike = items.every((i) => i.type === items[0].type);
    title.textContent = one ? t.label : `${items.length} items`;
    sub.textContent = one && (one.type === 'MOVIE' || one.type === 'AUDIO') ? clock(itemSeconds(one)) : '';

    if (one && t.note) body.append(h('div.in-note', icon('warn'), t.note));
    if (one?.type === 'PLAYLIST') {
      const d = store.state?.decks.find((x) => x.playlistId === one.id);
      body.append(h('div.in-acts', button('Load', () => void execute('load', one.id), 'sm'), button('Play', () => void execute('play', one.id), 'sm primary'), button('Previous', () => void execute('prev', one.id), 'sm'), button('Next', () => void execute('next', one.id), 'sm')),
        d ? h('div.caption.in-deck', `On ${d.channel}-${d.layer}, clip ${d.index + 1} of ${d.count}`) : '');
    }

    const label = textField(same(items, (i) => i.label) ?? '', (v) => edit(ids, 'label', (i) => { i.label = v; }), { placeholder: one ? '' : 'Mixed', live: true });
    const colour = h('span.in-swatches', ...COLORS.map((c) => {
      const b = h('button' + ((same(items, (i) => i.color ?? '') === c) ? '.on' : ''), { title: c || 'Default', style: `background:${c || 'transparent'}` });
      b.addEventListener('click', () => { edit(ids, 'color', (i) => { if (c) i.color = c; else delete i.color; }); render(); });
      return b;
    }));
    const named = alike && t.named ? (() => {
      const f = textField(same(items, (i) => i.name) ?? '', (v) => { edit(ids, 'name', (i) => { i.name = v; }); render(); }, { placeholder: one ? '' : 'Mixed' });
      const miss = one && missing(one);
      const r = row('File', f.el);
      r.classList.add('wide');
      if (miss) r.append(h('span.in-miss', { title: 'Not on the server' }, icon('warn')));
      if (one) r.append(button(miss ? 'Find…' : 'Replace…', () => void relinkSheet([one], !miss), 'sm', miss ? 'Find what this clip is called now' : 'Use another clip and keep everything else'));
      return r;
    })() : null;
    body.append(section('Item', [row('Label', label.el), named, row('Colour', colour)]));

    // Output: only the fields every selected tool uses.
    const has = (k: 'device' | 'channel' | 'layer' | 'delay' | 'duration') => items.every((i) => tool(i.type).out.includes(k));
    const out: (HTMLElement | null)[] = [
      has('device') ? (() => { const v = same(items, (i) => i.device); const names = store.settings.devices.map((d) => d.name); if (v && !names.includes(v)) names.unshift(v); return row('Server', popup([...(v ? [] : [{ value: '', label: v === undefined ? 'Mixed' : 'Choose…' }]), ...names.map((n) => ({ value: n, label: n }))], v ?? '', (x) => edit(ids, 'device', (i) => { i.device = x; }), { cls: 'sm' }).el); })() : null,
      has('channel') ? row('Channel', num(items, (i) => i.channel, (i, v) => { i.channel = Math.round(v); }, 'channel', { min: 1, max: 99 })) : null,
      has('layer') ? row('Layer', num(items, (i) => i.layer, (i, v) => { i.layer = Math.round(v); }, 'layer', { min: 0, max: 9999 })) : null,
      has('delay') ? row('Delay (ms)', num(items, (i) => i.delay, (i, v) => { i.delay = Math.round(v); }, 'delay', { min: 0, max: 3600000, step: 100 })) : null,
      has('duration') ? row('Duration (ms)', num(items, (i) => i.duration, (i, v) => { i.duration = Math.round(v); }, 'duration', { min: 0, max: 86400000, step: 100 }), 'Stops by itself after this long. 0 = never.') : null,
    ];
    if (out.some(Boolean)) body.append(section('Output', out));

    if (alike && t.props.length) {
      const groups: [string, Prop[]][] = [];
      const isTrans = (p: Prop) => ['transition', 'transitionDuration', 'tween', 'direction', 'defer'].includes(p.key);
      const main = t.props.filter((p) => !isTrans(p));
      const tr = t.props.filter(isTrans);
      if (main.length) groups.push([isContainer(items[0]) ? (isPlaylist(items[0]) ? 'Playlist' : 'Group') : t.label, main]);
      if (tr.length) groups.push([t.cat === 'Mixer' ? 'Animation' : 'Transition', tr]);
      for (const [n, ps] of groups) {
        const shown = isPlaylist(items[0]) && same(items, (i) => i.props.cgtransition) !== 'MIX' ? ps.filter((p) => p.key !== 'cgtransitionframes') : ps;
        body.append(section(n, shown.map((p) => propRow(items, p))));
      }
    }
    if (one && t.data) body.append(dataTable(one));

    if (items.every((i) => i.type !== 'SEPARATOR')) {
      const rem = same(items, (i) => i.allowRemote);
      body.append(section('Remote', [
        row('Allow remote', toggle(rem === true, (v) => { edit(ids, 'allowRemote', (i) => { i.allowRemote = v; }); }, { cls: 'sm blue' }).el),
        one ? row('Remote ID', textField(one.remoteId, (v) => edit(ids, 'remoteId', (i) => { i.remoteId = v.trim(); }), { placeholder: 'e.g. lt-1' }).el, 'Trigger with OSC /control/<id>/play or http://127.0.0.1:' + store.settings.http.port + '/item/<id>/play') : null,
        row('Allow GPI', checkbox(same(items, (i) => i.allowGpi) === true, (v) => edit(ids, 'allowGpi', (i) => { i.allowGpi = v; })).el, 'Kept in the file; this app has no GPI input'),
        one ? row('Story ID', textField(one.storyId, (v) => edit(ids, 'storyId', (i) => { i.storyId = v; })).el) : null,
      ]));
    }
    body.scrollTop = top;
  }

  on('select', render);
  on('settings', render);
  const typing = () => body.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement!.tagName);
  on('library', () => { if (!typing()) render(); });
  on('doc', () => {
    // Keep the field being typed in; rebuild when the selection's identity changed or nothing is focused.
    if (selected().map((i) => i.id).join() !== sig || !typing()) render();
  });
  render();
  return h('aside.inspector', h('div.in-head', title, h('span.spacer'), sub), body);
}
export { stepper };
