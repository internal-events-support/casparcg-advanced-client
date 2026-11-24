// Right column in Show: what the selected entry is and what it will do. Nothing here can be changed.
import { isContainer, isPlaylist, tool, type Prop } from '../shared/tools';
import type { Item } from '../shared/types';
import { h, icon } from './kit';
import { missing } from './relinkui';
import { channelText, clock, fpsOf, itemSeconds, media, on, playlistOf, select, selected, store } from './store';

/** mm:ss, with hundredths when it is not a whole second. */
const exact = (s: number) => { const c = Math.round(s * 100); return clock(Math.floor(c / 100)) + (c % 100 ? `.${String(c % 100).padStart(2, '0')}` : ''); };
const ms = (n: number) => (n >= 60000 ? clock(n / 1000) : `${Math.round(n / 10) / 100} s`);
const nice = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
const MOVES = ['transition', 'transitionDuration', 'tween', 'direction', 'defer'];
// Said in their own words below, or no use on the night.
const SAID = new Set([...MOVES, 'seek', 'length', 'loop', 'freezeonload', 'autoplay', 'useauto', 'triggeronnext', 'notes', 'cgauto', 'cgloop', 'cgtransition', 'cgtransitionframes', 'autostep', 'usemipmap', 'flashlayer', 'cgtfromchannel', 'cgtfromlayer', 'cgttochannel', 'cgttolayer', 'cgtmode', 'cgtframes']);

export function buildInfo(): HTMLElement {
  const title = h('span.in-title');
  const sub = h('span.caption');
  const body = h('div.in-body');
  const root = h('aside.inspector.info', h('div.in-head', title, h('span.spacer'), sub), body);
  let parts: { item: Item; el: HTMLElement }[] = [];

  type Row = HTMLElement | null | false;
  const row = (k: string, v: string | number | undefined, tall = false): Row => (v === undefined || v === '' ? null : h(`div.in-row.ro${tall ? '.tall' : ''}`, h('label', k), h('span.in-val', String(v))));
  const section = (name: string, rows: Row[]) => {
    const real = rows.filter((r): r is HTMLElement => !!r);
    if (real.length) body.append(h('section.in-sec', name ? h('h4', name) : null, h('div.group', ...real)));
  };

  const mix = (p: Item['props']) => {
    const n = Number(p.transitionDuration) || 0;
    const t = String(p.transition ?? '');
    if (n < 1 || t === 'CUT') return '';
    const side = ['PUSH', 'SLIDE', 'WIPE'].includes(t) ? ` ${String(p.direction ?? '').toLowerCase()}` : '';
    return `${t ? `${nice(t)}${side}, ` : ''}${n} frames${p.tween && p.tween !== 'Linear' ? `, ${String(p.tween)}` : ''}`;
  };
  const value = (p: Prop, v: string | number | boolean): string => {
    if (typeof v === 'boolean') return v ? 'Yes' : '';
    if (p.kind === 'color') { const x = String(v).replace('#', '').padStart(8, 'F'); const a = parseInt(x.slice(0, 2), 16); return a === 0 ? 'Transparent' : `#${x.slice(2)}${a < 255 ? `, ${Math.round((a / 255) * 100)}%` : ''}`; }
    return p.key === 'outputdelay' && !Number(v) ? '' : String(v);
  };

  /** The entries inside a group or playlist. */
  function contents(i: Item): void {
    const kids = i.items ?? [];
    const rows = kids.filter((k) => k.type !== 'SEPARATOR').map((k) => {
      const s = itemSeconds(k);
      const el = h('button.in-kid' + (missing(k) ? '.gone' : ''), { title: i.expanded === false ? '' : 'Select this entry' }, h('span.rd-ico', { style: `color:${tool(k.type).color}` }, icon(tool(k.type).icon)), h('span.in-kid-n', k.label || k.name || tool(k.type).label), h('span.in-kid-t', s ? clock(s) : '')) as HTMLButtonElement;
      // An entry in a folded group has no row to select.
      el.disabled = i.expanded === false;
      el.addEventListener('click', () => select(k.id));
      parts.push({ item: k, el });
      return el;
    });
    section(`${kids.length} ${isPlaylist(i) ? (kids.length === 1 ? 'clip' : 'clips') : kids.length === 1 ? 'entry' : 'entries'}`, rows);
  }

  function one(i: Item): void {
    const t = tool(i.type);
    const p = i.props;
    const pl = playlistOf(i);
    title.textContent = i.label || i.name || t.label;
    sub.textContent = t.label;
    if (missing(i)) body.append(h('div.in-note', icon('warn'), 'This clip is not on the server'));
    else if (t.note) body.append(h('div.in-note', icon('warn'), t.note));
    if (p.notes) section('Notes', [row('', String(p.notes), true)]);

    if (i.data?.length) section('Data', i.data.map((d) => row(d.key, d.value || ' ')));

    const clip = i.type === 'MOVIE' || i.type === 'AUDIO';
    const at = pl ?? i;
    const out = new Set(t.out);
    const trimmed = clip && (Number(p.seek) > 0 || Number(p.length) > 0);
    const secs = itemSeconds(i);
    const loops = clip && !pl && !!p.loop;
    const from = (Number(p.seek) || 0) / fpsOf(i);
    const whole = media(i.name, at.device || undefined)?.seconds ?? 0;
    const when = pl ? pl.items!.filter((x) => x.type === 'MOVIE').indexOf(i) : -1;
    const spot = (c: unknown, l: unknown) => `Channel ${channelText(Number(c), i.device)}, layer ${Number(l)}`;
    section('', [
      i.type === 'CGTAKE' && row('From', spot(p.cgtfromchannel, p.cgtfromlayer)),
      i.type === 'CGTAKE' && row('To', spot(p.cgttochannel, p.cgttolayer)),
      i.type === 'CGTAKE' && row('Type', p.cgtmode === 'Fade' ? `Fade, ${Number(p.cgtframes)} frames` : 'Cut'),
      clip && row('Length', secs ? exact(secs) : ''),
      trimmed && !!secs && row('Part used', `${exact(from)} to ${exact(from + secs)} of ${exact(whole)}`),
      loops && row('Repeats', 'Until stopped'),
      pl ? row('Playlist', `${pl.label}, clip ${when + 1} of ${pl.items!.filter((x) => x.type === 'MOVIE').length}`) : null,
      (out.has('channel') || pl) ? row('Output', `Channel ${channelText(at.channel, at.device)}${out.has('layer') ? `, layer ${at.layer}` : ''}`) : null,
      out.has('device') && store.settings.devices.length > 1 ? row('Server', at.device) : null,
      t.named && i.name !== i.label ? row('File', i.name) : null,
      !pl && row(t.cat === 'Mixer' ? 'Animation' : 'Transition', mix(p)),
      !pl && i.type === 'MOVIE' && !!p.autoplay && row('Starts', 'After the clip that is playing'),
      !pl && i.delay > 0 && row('Waits first', ms(i.delay)),
      !pl && i.duration > 0 && row('Stops after', ms(i.duration)),
      isPlaylist(i) && row('Between clips', p.cgauto === false ? 'Holds until you press Next' : p.cgtransition === 'MIX' ? `Mix, ${Number(p.cgtransitionframes)} frames` : 'Cut'),
      isPlaylist(i) && row('At the end', p.cgloop === 'Loop forever' ? 'Starts again' : 'Stops on the last clip'),
      i.type === 'GROUP' && !!p.autoplay && row('Videos', 'Play one after another'),
      i.type === 'GROUP' && !!p.autostep && row('After playing', 'Selects the next entry'),
      !!p.triggeronnext && row('Also plays on', 'Next'),
    ]);

    // Everything else that is set, in the tool's own words.
    const rest = t.props.filter((x) => !SAID.has(x.key)).map((x) => { const v = x.key === 'fromchannel' ? channelText(Number(p[x.key] ?? x.def), i.device) : value(x, p[x.key] ?? x.def); return row(x.label, v, x.kind === 'area' || v.length > 22); });
    section('Settings', rest);
    if (isContainer(i)) contents(i);
    section('Remote', [i.allowRemote && row('Remote ID', i.remoteId), row('Story ID', i.storyId)]);
  }

  function render(): void {
    if (root.hidden) return;
    const s = selected();
    body.textContent = '';
    sub.textContent = '';
    parts = [];
    if (!s.length) {
      title.textContent = 'Details';
      body.append(h('div.lib-empty', 'Select an entry to see its details'));
    } else if (s.length === 1) one(s[0]);
    else {
      title.textContent = `${s.length} entries`;
      section('', s.map((i) => row(i.label || tool(i.type).label, itemSeconds(i) ? clock(itemSeconds(i)) : tool(i.type).label)));
    }
    paint();
  }
  /** Mark what is on air inside the group or playlist that is shown. */
  function paint(): void {
    for (const { item, el } of parts) {
      const st = store.state?.items[item.id]?.state ?? '';
      if (el.dataset.st !== st) el.dataset.st = st;
    }
  }

  let was = '';
  on('select', () => { const k = selected().map((i) => i.id).join(); if (k !== was) body.scrollTop = 0; was = k; render(); });
  for (const e of ['doc', 'library', 'settings', 'tab'] as const) on(e, render);
  on('state', paint);
  render();
  return root;
}
