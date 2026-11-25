// Channels tab: names and playback overlays of the channels, what is on every layer, transport for each, and takes.
import { newItem } from '../shared/tools';
import { DEFAULT_OVERLAY, type LayerState, type Loc, type Overlay } from '../shared/types';
import { button, checkbox, confirmSheet, h, icon, iconButton, popover, popup, segmented, toggle } from './kit';
import { call, channelName, channelOptions, channelText, insert, on, spot, store } from './store';

interface Row { loc: Loc; el: HTMLElement; badge: HTMLElement; name: HTMLElement; list: HTMLElement; next: HTMLElement; bar: HTMLElement; play: HTMLButtonElement; steps: HTMLButtonElement[]; was: string }
const short = (n: string) => n.replace(/\\/g, '/').split('/').pop()!;

/** Choose where a layer goes and how. */
export function takeSheet(anchor: HTMLElement, from: Loc): void {
  const dev = store.state?.devices.find((d) => d.name === from.device);
  const n = dev?.channels.length ?? 1;
  const opts = channelOptions(from.device);
  const f = { ...from };
  const to = { device: from.device, channel: from.channel === 1 ? Math.min(2, n) : 1, layer: from.layer };
  let mode = 'Cut';
  let roll = false;
  let hold = true;
  let frames = 25;
  const num = (v: number, fn: (x: number) => void, max: number) => {
    const i = h('input.field.num', { type: 'text', inputmode: 'numeric' }) as HTMLInputElement;
    i.value = String(v);
    i.addEventListener('change', () => { const x = Math.min(max, Math.max(0, Math.round(Number(i.value)) || 0)); i.value = String(x); fn(x); });
    i.addEventListener('keydown', (e) => e.stopPropagation());
    return i;
  };
  const fr = num(frames, (x) => (frames = Math.max(1, x)), 500);
  const frRow = h('div.tk-row', h('label', 'Fade frames'), fr);
  frRow.hidden = true;
  const seg = segmented([{ value: 'Cut', label: 'Cut' }, { value: 'Fade', label: 'Fade' }], mode, (v) => { mode = v; seg.set(v); frRow.hidden = v !== 'Fade'; }, 'sm blue');
  const line = (label: string, l: Loc) => h('div.tk-row', h('label', label), popup(opts, String(l.channel), (v) => (l.channel = Number(v)), { cls: 'sm' }).el, h('span.caption', 'layer'), num(l.layer, (x) => (l.layer = x), 9998));
  const close = popover(anchor, h('div.tk',
    line('From', f), line('To', to), h('div.tk-row', h('label', 'Type'), seg.el), frRow,
    h('div.tk-row', checkbox(roll, (v) => (roll = v), 'Play when taken').el), h('div.tk-row', checkbox(hold, (v) => (hold = v), 'Pause what comes off').el),
    h('p.caption', 'The two layers swap places, so a playlist carries on where it was taken.'),
    h('div.tk-acts', button('Add to rundown', () => {
      insert([newItem('CGTAKE', { label: `${mode} ${spot(f.channel, f.layer, from.device)} to ${spot(to.channel, to.layer, from.device)}${roll ? ', play' : ''}`, device: from.device, props: { cgtfromchannel: f.channel, cgtfromlayer: f.layer, cgttochannel: to.channel, cgttolayer: to.layer, cgtmode: mode, cgtframes: frames, cgtroll: roll, cgthold: hold } })]);
      close();
    }), button('Take', () => { close(); void call('take', f, to, { fade: mode === 'Fade', roll, hold, frames }); }, 'primary'))), { width: 290 });
}

const overlayOf = (device: string, ch: number): Overlay => ({ ...DEFAULT_OVERLAY, ...store.settings.devices.find((d) => d.name === device)?.channels?.[ch]?.overlay });
const isShowing = (device: string, ch: number): boolean => !!store.state?.layers[`${device}|${ch}-${overlayOf(device, ch).layer}`]?.overlay;

/** Sets up the playback overlay of a channel. */
function overlaySheet(anchor: HTMLElement, device: string, ch: number): void {
  const o = overlayOf(device, ch);
  const put = (p: Partial<Overlay>) => { Object.assign(o, p); void call('channel', device, ch, { overlay: p }); };
  const row = (label: string, el: HTMLElement) => h('div.tk-row', h('label', label), el);
  const num = (v: number, min: number, max: number, fn: (n: number) => void) => {
    const i = h('input.field.num', { type: 'text', inputmode: 'numeric' }) as HTMLInputElement;
    i.value = String(v);
    i.addEventListener('change', () => { const x = Math.round(Number(i.value)); const n = Number.isFinite(x) && i.value.trim() ? Math.min(max, Math.max(min, x)) : v; v = n; i.value = String(n); fn(n); });
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') i.blur(); if (e.key !== 'Escape') e.stopPropagation(); });
    return i;
  };
  const pick = <T extends string>(opts: { value: T; label: string }[], v: T, fn: (x: T) => void) => popup(opts, v, (x) => fn(x as T), { cls: 'sm' }).el;
  const title = h('input.field', { type: 'text', placeholder: 'Channel name', maxLength: 40 }) as HTMLInputElement;
  title.value = o.title;
  title.addEventListener('change', () => put({ title: title.value.trim() }));
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') title.blur(); if (e.key !== 'Escape') e.stopPropagation(); });
  popover(anchor, h('div.tk.ov',
    h('div.tk-row', h('b', `Playback overlay on channel ${channelText(ch, device)}`), h('span.spacer'), toggle(o.on, (v) => put({ on: v }), { cls: 'sm' }).el),
    h('p.caption', `Draws a bar over the picture of channel ${ch} with the name of the clip, whether it is playing, its position and the time left. CasparCG puts it on the channel as a graphic, so it is in everything that channel sends out: screens, SDI, NDI, streams and recordings. Use it on a channel that only the crew sees.`),
    h('b.ov-h', 'What it shows'),
    row('Clips from', pick([{ value: '0', label: 'This channel' }, ...channelOptions(device, [o.follow]).filter((x) => Number(x.value) !== ch)], String(o.follow), (v) => put({ follow: Number(v) }))),
    h('p.caption', 'The channel the clips are played on. Choose another one if this channel shows a copy of it.'),
    row('Large bar: layer', num(o.main, 0, 9999, (v) => put({ main: v }))),
    h('p.caption', 'The clip in the large bar. 0 = the lowest layer with a clip that has not ended.'),
    h('div.tk-row', checkbox(o.others, (v) => put({ others: v }), 'A small bar for each clip on other layers').el), h('div.tk-row', checkbox(o.next, (v) => put({ next: v }), 'Name of the next clip in the playlist').el),
    row('When no clip is on', pick([{ value: 'label', label: 'A small label' }, { value: 'hide', label: 'Nothing' }], o.idle, (v) => put({ idle: v }))),
    h('b.ov-h', 'How it looks'),
    row('Name on the bar', title),
    row('Position', pick([{ value: 'bottom', label: 'Bottom' }, { value: 'top', label: 'Top' }], o.position, (v) => put({ position: v }))),
    row('Size (%)', num(o.size, 30, 250, (v) => put({ size: v }))),
    row('Distance from the edge (%)', num(o.margin, 0, 45, (v) => put({ margin: v }))),
    row('CasparCG layer', num(o.layer, 0, 9999, (v) => put({ layer: v }))),
    h('p.caption', `The layer of channel ${ch} the overlay itself is on. Above the layers of your clips, or they cover it, and not one you use for anything else.`)), { width: 340 });
}

export function buildChannels(): HTMLElement {
  const body = h('div.ch-body');
  let rows: Row[] = [];
  let sig = '';
  const meters = new Map<string, { bars: HTMLElement[]; el: HTMLElement; none: HTMLElement }>();
  let overlays: { device: string; ch: number; dot: HTMLElement; el: HTMLElement; again?: HTMLElement; was: string }[] = [];
  const act = (l: Loc, v: string) => void call('transport', l, v);

  function row(loc: Loc): Row {
    const badge = h('span.rd-badge');
    const name = h('div.lib-name');
    const list = h('span.ch-list');
    const next = h('span.ch-next');
    const bar = h('i');
    const play = iconButton('play', () => act(loc, 'toggle'), 'Play / pause', 'plain');
    const steps = [iconButton('prev', () => act(loc, 'prev'), 'Previous clip in the playlist', 'plain'), iconButton('next', () => act(loc, 'next'), 'Next clip in the playlist', 'plain')];
    const s = store.settings.skipSeconds;
    const take = button('Take to…', () => takeSheet(take, loc), 'sm');
    const el = h('div.ch-row', h('span.ch-layer', String(loc.layer)), badge, h('div.ch-main', h('div.ch-l1', name, list), h('div.lib-sub', next)),
      h('span.ch-keys', steps[0], iconButton('back', () => act(loc, 'back'), `Back ${s} seconds`, 'plain'), play, iconButton('fwd', () => act(loc, 'forward'), `Forward ${s} seconds`, 'plain'), steps[1], iconButton('stop', () => act(loc, 'stop'), 'Stop', 'plain')), take, h('div.rd-prog', bar));
    return { loc, el, badge, name, list, next, bar, play, steps, was: '' };
  }

  function build(): void {
    body.textContent = '';
    rows = [];
    overlays = [];
    meters.clear();
    const st = store.state;
    if (!st) return;
    for (const d of st.devices) {
      if (st.devices.length > 1 || !d.connected) body.append(h('div.ch-dev', h(`span.dot.${d.connected ? 'ok' : 'bad'}`), d.name, d.connected ? null : h('span.caption', d.error || 'Not connected')));
      d.channels.forEach((fmt, k) => {
        const ch = k + 1;
        const bars = [...Array(8)].map(() => h('i'));
        const meter = h('div.ch-meter', ...bars.map((b) => h('div.meter-v', b)));
        const none = h('span.caption', { title: 'The server only mixes the sound of channels that have an output', hidden: true }, 'No output');
        meters.set(`${d.name}|${ch}`, { bars, el: meter, none });
        const layers = Object.keys(st.layers).filter((x) => x.startsWith(`${d.name}|${ch}-`) && st.layers[x].producer !== 'empty').map((x) => Number(x.split('-').pop())).sort((a, b) => a - b);
        const clear = button('Clear channel', () => void confirmSheet(`Clear channel ${channelText(ch, d.name)}?`, 'Everything on it goes off air.', 'Clear', true).then((y) => { if (y) void call('clearChannel', d.name, ch); }), 'sm');
        const name = h('input.ch-name', { type: 'text', placeholder: 'Name', title: 'Name of this channel', maxLength: 40, spellcheck: false }) as HTMLInputElement;
        name.value = channelName(ch, d.name);
        name.addEventListener('change', () => void call('channel', d.name, ch, { name: name.value }));
        name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); if (e.key === 'Escape') { name.value = channelName(ch, d.name); name.blur(); } e.stopPropagation(); });
        name.addEventListener('blur', () => setTimeout(paint));
        const dot = h('span.dot');
        const over = button(h('span.kbtn', dot, 'Overlay'), () => overlaySheet(over, d.name, ch), 'sm');
        overlays.push({ device: d.name, ch, dot, el: over, was: '' });
        const again = button('Show again', () => void call('channel', d.name, ch, { overlay: { on: true } }), 'sm');
        overlays.at(-1)!.again = again;
        const card = h('div.ch-card', h('div.ch-head', h('b', `Channel ${ch}`), name, h('span.caption', fmt), meter, none, h('span.spacer'), again, over, clear));
        for (const l of layers) {
          const r = row({ device: d.name, channel: ch, layer: l });
          rows.push(r);
          card.append(r.el);
        }
        if (!layers.length) card.append(h('div.ch-empty', 'Empty'));
        body.append(card);
      });
    }
  }

  const label = (l: LayerState) => (l.overlay ? 'Playback overlay' : l.name ? short(l.name) : { html: 'HTML page', route: 'Route', color: 'Colour', decklink: 'DeckLink input', image: 'Image', transition: 'Transition', ndi: 'NDI source' }[l.producer] ?? l.producer);
  function paint(): void {
    const st = store.state;
    if (!st) return;
    const s = JSON.stringify([st.devices.map((d) => [d.name, d.connected, d.channels, d.error]), Object.keys(st.layers).filter((k) => st.layers[k].producer !== 'empty').sort(), store.settings.devices.map((d) => Object.entries(d.channels ?? {}).map(([k, c]) => [k, c.name]))]);
    // Not under a name that is being typed.
    if (s !== sig && !document.activeElement?.classList.contains('ch-name')) { sig = s; build(); }
    for (const x of overlays) {
      const o = overlayOf(x.device, x.ch);
      const there = isShowing(x.device, x.ch);
      const w = !o.on ? 'off' : there ? 'on' : 'gone';
      if (w === x.was) continue;
      x.was = w;
      x.dot.className = `dot${w === 'on' ? ' ok' : w === 'gone' ? ' warn' : ''}`;
      x.dot.hidden = w === 'off';
      x.el.title = { off: 'Draw the clip and the time left over the picture of this channel', on: 'The playback overlay is over the picture of this channel', gone: 'The playback overlay was cleared' }[w];
      if (x.again) x.again.hidden = w !== 'gone';
    }
    for (const [k, { bars, el, none }] of meters) {
      const v = st.audio[k] ?? [];
      const off = !!st.audio[k] && !v.length;
      if (none.hidden === off) { none.hidden = !off; el.hidden = off; }
      bars.forEach((b, n) => { const x = v[n] ?? 0; b.style.height = `${x > 0 ? Math.max(0, Math.min(100, (20 * Math.log10(x) + 60) / 0.6)) : 0}%`; });
    }
    for (const r of rows) {
      const l = st.layers[`${r.loc.device}|${r.loc.channel}-${r.loc.layer}`];
      if (!l) continue;
      const deck = st.decks.find((d) => d.device === r.loc.device && d.channel === r.loc.channel && d.layer === r.loc.layer);
      const state = !l.end ? 'live' : !l.loop && l.end - l.pos <= 0.05 ? 'end' : l.paused ? (l.pos - l.start < 0.1 ? 'loaded' : 'paused') : 'playing';
      const pct = l.end ? ((l.pos - l.start) / Math.max(0.01, l.end - l.start)) * 100 : 0;
      const x = [state, label(l), deck && `${deck.label} ${deck.index + 1}/${deck.count}`, l.next, Math.round(pct * 2)].join('|');
      if (x === r.was) continue;
      r.was = x;
      r.badge.textContent = { playing: 'PLAY', paused: 'PAUSE', loaded: 'CUED', end: 'END', live: 'ON' }[state]!;
      r.badge.className = `rd-badge ${state}`;
      r.name.textContent = label(l);
      r.list.textContent = deck ? `${deck.label}  ${deck.index + 1}/${deck.count}` : '';
      r.next.textContent = l.next ? `Next: ${short(l.next)}` : '';
      r.bar.style.width = `${pct}%`;
      const want = state === 'playing' ? 'pause' : 'play';
      if (r.play.dataset.i !== want) { r.play.dataset.i = want; r.play.replaceChildren(icon(want)); }
      for (const b of r.steps) b.disabled = !deck;
    }
  }
  on('state', paint);
  on('settings', paint);
  const head = h('div.ch-bar', h('b', 'Channels'), h('span.spacer'));
  const any = button('Take between channels…', () => takeSheet(any, { device: store.settings.devices[0]?.name ?? '', channel: 1, layer: 10 }), 'sm');
  head.append(any);
  return h('section.channels', head, body);
}
