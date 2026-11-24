// Channels tab: what is on every layer of every channel, transport for each, and taking one layer to another channel.
import { newItem } from '../shared/tools';
import type { LayerState, Loc } from '../shared/types';
import { button, checkbox, confirmSheet, h, icon, iconButton, popover, popup, segmented } from './kit';
import { call, clock, insert, on, store } from './store';

interface Row { loc: Loc; el: HTMLElement; badge: HTMLElement; name: HTMLElement; list: HTMLElement; time: HTMLElement; next: HTMLElement; bar: HTMLElement; play: HTMLButtonElement; steps: HTMLButtonElement[]; scrub: HTMLInputElement; was: string }
const short = (n: string) => n.replace(/\\/g, '/').split('/').pop()!;

/** Choose where a layer goes and how. */
export function takeSheet(anchor: HTMLElement, from: Loc): void {
  const dev = store.state?.devices.find((d) => d.name === from.device);
  const n = dev?.channels.length ?? 1;
  const opts = [...Array(n)].map((_, k) => ({ value: String(k + 1), label: `Channel ${k + 1}` }));
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
      insert([newItem('CGTAKE', { label: `${mode} ${f.channel}-${f.layer} to ${to.channel}-${to.layer}${roll ? ', play' : ''}`, device: from.device, props: { cgtfromchannel: f.channel, cgtfromlayer: f.layer, cgttochannel: to.channel, cgttolayer: to.layer, cgtmode: mode, cgtframes: frames, cgtroll: roll, cgthold: hold } })]);
      close();
    }), button('Take', () => { close(); void call('take', f, to, { fade: mode === 'Fade', roll, hold, frames }); }, 'primary'))), { width: 290 });
}

export function buildChannels(): HTMLElement {
  const body = h('div.ch-body');
  let rows: Row[] = [];
  let sig = '';
  const meters = new Map<string, HTMLElement[]>();
  const act = (l: Loc, v: string) => void call('transport', l, v);

  function row(loc: Loc): Row {
    const badge = h('span.rd-badge');
    const name = h('div.lib-name');
    const list = h('span.ch-list');
    const next = h('span.ch-next');
    const time = h('span.ch-time');
    const bar = h('i');
    const play = iconButton('play', () => act(loc, 'toggle'), 'Play / pause', 'plain');
    const steps = [iconButton('prev', () => act(loc, 'prev'), 'Previous clip in the playlist', 'plain'), iconButton('next', () => act(loc, 'next'), 'Next clip in the playlist', 'plain')];
    const s = store.settings.skipSeconds;
    const scrub = h('input.mon-scrub', { type: 'range', min: '0', max: '1000', value: '0', title: 'Seek' }) as HTMLInputElement;
    scrub.addEventListener('change', () => { const l = store.state?.layers[`${loc.device}|${loc.channel}-${loc.layer}`]; if (l?.end) void call('seek', loc, (Number(scrub.value) / 1000) * (l.end - l.start)); });
    const take = button('Take to…', () => takeSheet(take, loc), 'sm');
    const el = h('div.ch-row', h('span.ch-layer', String(loc.layer)), badge, h('div.ch-main', h('div.ch-l1', name, list), h('div.lib-sub', next)), h('div.ch-scrub', scrub), time,
      h('span.ch-keys', steps[0], iconButton('back', () => act(loc, 'back'), `Back ${s} seconds`, 'plain'), play, iconButton('fwd', () => act(loc, 'forward'), `Forward ${s} seconds`, 'plain'), steps[1], iconButton('stop', () => act(loc, 'stop'), 'Stop', 'plain')), take, h('div.rd-prog', bar));
    return { loc, el, badge, name, list, time, next, bar, play, steps, scrub, was: '' };
  }

  function build(): void {
    body.textContent = '';
    rows = [];
    meters.clear();
    const st = store.state;
    if (!st) return;
    for (const d of st.devices) {
      if (st.devices.length > 1 || !d.connected) body.append(h('div.ch-dev', h(`span.dot.${d.connected ? 'ok' : 'bad'}`), d.name, d.connected ? null : h('span.caption', d.error || 'Not connected')));
      d.channels.forEach((fmt, k) => {
        const ch = k + 1;
        const bars = [...Array(8)].map(() => h('i'));
        meters.set(`${d.name}|${ch}`, bars);
        const layers = Object.keys(st.layers).filter((x) => x.startsWith(`${d.name}|${ch}-`) && st.layers[x].producer !== 'empty').map((x) => Number(x.split('-').pop())).sort((a, b) => a - b);
        const clear = button('Clear channel', () => void confirmSheet(`Clear channel ${ch}?`, 'Everything on it goes off air.', 'Clear', true).then((y) => { if (y) void call('raw', d.name, `CLEAR ${ch}`); }), 'sm');
        const card = h('div.ch-card', h('div.ch-head', h('b', `Channel ${ch}`), h('span.caption', fmt), h('div.ch-meter', ...bars.map((b) => h('div.meter-v', b))), h('span.spacer'), clear));
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

  const label = (l: LayerState) => (l.name ? short(l.name) : { html: 'HTML page', route: 'Route', color: 'Colour', decklink: 'DeckLink input', image: 'Image', transition: 'Transition', ndi: 'NDI source' }[l.producer] ?? l.producer);
  function paint(): void {
    const st = store.state;
    if (!st) return;
    const s = JSON.stringify([st.devices.map((d) => [d.name, d.connected, d.channels, d.error]), Object.keys(st.layers).filter((k) => st.layers[k].producer !== 'empty').sort()]);
    if (s !== sig) { sig = s; build(); }
    for (const [k, bars] of meters) {
      const v = st.audio[k] ?? [];
      bars.forEach((b, n) => { const x = v[n] ?? 0; b.style.height = `${x > 0 ? Math.max(0, Math.min(100, (20 * Math.log10(x) + 60) / 0.6)) : 0}%`; });
    }
    for (const r of rows) {
      const l = st.layers[`${r.loc.device}|${r.loc.channel}-${r.loc.layer}`];
      if (!l) continue;
      const deck = st.decks.find((d) => d.device === r.loc.device && d.channel === r.loc.channel && d.layer === r.loc.layer);
      const state = !l.end ? 'live' : !l.loop && l.end - l.pos <= 0.05 ? 'end' : l.paused ? (l.pos - l.start < 0.1 ? 'loaded' : 'paused') : 'playing';
      const pct = l.end ? ((l.pos - l.start) / Math.max(0.01, l.end - l.start)) * 100 : 0;
      const t = l.end ? clock(l.end - l.pos, true) : '';
      const x = [state, label(l), deck && `${deck.label} ${deck.index + 1}/${deck.count}`, t, l.next, Math.round(pct * 2)].join('|');
      if (x === r.was) continue;
      r.was = x;
      r.badge.textContent = { playing: 'PLAY', paused: 'PAUSE', loaded: 'CUED', end: 'END', live: 'ON' }[state]!;
      r.badge.className = `rd-badge ${state}`;
      r.name.textContent = label(l);
      r.list.textContent = deck ? `${deck.label}  ${deck.index + 1}/${deck.count}` : '';
      r.next.textContent = l.next ? `Next: ${short(l.next)}` : '';
      r.time.textContent = t;
      const c = store.settings.countdown;
      const rem = l.end - l.pos;
      r.time.dataset.level = state !== 'playing' || l.loop ? '' : rem <= c.warn ? 'warn' : rem <= c.caution ? 'caution' : '';
      r.bar.style.width = `${pct}%`;
      if (!r.scrub.matches(':active')) r.scrub.value = String(Math.round(pct * 10));
      r.scrub.style.setProperty('--p', `${Number(r.scrub.value) / 10}%`);
      r.scrub.style.visibility = l.end ? '' : 'hidden';
      const want = state === 'playing' ? 'pause' : 'play';
      if (r.play.dataset.i !== want) { r.play.dataset.i = want; r.play.replaceChildren(icon(want)); }
      for (const b of r.steps) b.disabled = !deck;
    }
  }
  on('state', paint);
  const head = h('div.ch-bar', h('b', 'Channels'), h('span.spacer'));
  const any = button('Take between channels…', () => takeSheet(any, { device: store.settings.devices[0]?.name ?? '', channel: 2, layer: 10 }), 'sm');
  head.append(any);
  return h('section.channels', head, body);
}
