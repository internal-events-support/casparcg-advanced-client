// Finding clips that were renamed or moved, without rebuilding the rundown entries that use them.
import { findItem, tool, walk } from '../shared/tools';
import { guesses, isMissing, relink, type Guess, type Seen } from '../shared/relink';
import type { Item } from '../shared/types';
import { button, checkbox, h, icon, popup, textField, type OptList } from './kit';
import { call, doc, emit, homeDevice, mutate, store, toast } from './store';

export const missing = (i: Item): boolean => isMissing(i, store.library[i.device || homeDevice()]);
/** Items in the open rundown whose clip is not on the server. */
export function missingItems(): Item[] {
  const out: Item[] = [];
  walk(doc()?.items ?? [], (i) => { if (missing(i)) out.push(i); });
  return out;
}

interface Line { device: string; type: string; name: string; ids: string[]; to: string; use: boolean; found: Guess[] }

/** Offer new clips for these items. Entries that use the same clip are changed together. */
export async function relinkSheet(items: Item[], replace = false): Promise<void> {
  if (document.querySelector('.sheet-layer')) return;
  const lines: Line[] = [];
  const seen: Record<string, Seen> = {};
  for (const i of items) {
    const device = i.device || homeDevice();
    const lib = store.library[device];
    if (!lib || !tool(i.type).named) continue;
    const same = lines.find((l) => l.device === device && l.type === i.type && l.name.toLowerCase() === i.name.toLowerCase());
    if (same) { same.ids.push(i.id); continue; }
    seen[device] ??= (await call<Seen>('seen', device)) ?? {};
    const found = replace ? [] : guesses(i, lib, seen[device]);
    // Only tick the ones that are very likely right.
    const sure = found.length > 0 && found[0].score >= 90 && (found.length === 1 || found[1].score < found[0].score);
    lines.push({ device, type: i.type, name: i.name, ids: [i.id], to: found[0]?.name ?? '', use: sure, found });
  }
  if (!lines.length) return toast('The server’s clip list is not known yet', 'bad');

  const go = button('', () => apply(), 'primary');
  const count = () => {
    const n = lines.filter((l) => l.use && l.to).reduce((a, l) => a + l.ids.length, 0);
    go.textContent = n ? `${replace ? 'Replace' : 'Relink'} ${n} ${n === 1 ? 'entry' : 'entries'}` : replace ? 'Replace' : 'Relink';
    go.disabled = !n;
  };
  const rows = lines.map((l) => {
    const lib = store.library[l.device];
    const all = (tool(l.type).named === 'TEMPLATE' ? lib.templates : lib.media.filter((m) => m.type === tool(l.type).named).map((m) => m.name)).slice().sort((a, b) => a.localeCompare(b));
    const why = h('span.rl-why');
    const tick = checkbox(l.use, (v) => { l.use = v; count(); });
    let filter = '';
    const opts = (): OptList => {
      const hit = all.filter((n) => n.toLowerCase().includes(filter));
      return [{ value: '', label: 'Choose a clip…' }, ...(l.found.length && !filter ? [{ group: 'Likely', options: l.found.map((g) => ({ value: g.name, label: `${g.name}  (${g.why.toLowerCase()})` })) }] : []), { group: filter ? `${hit.length} found` : 'All clips', options: hit.filter((n) => filter || !l.found.some((g) => g.name === n)).map((n) => ({ value: n, label: n })) }];
    };
    const sel = popup(opts(), l.to, (v) => pick(v), { cls: 'sm' });
    const say = () => { const g = l.found.find((x) => x.name === l.to); why.textContent = g ? g.why : l.to ? 'Chosen by you' : replace ? '' : 'Nothing similar found'; why.className = `rl-why${g && g.score >= 90 ? ' good' : ''}`; };
    function pick(v: string): void {
      l.to = v;
      l.use = !!v;
      tick.set(l.use);
      say();
      count();
    }
    const search = textField('', (v) => {
      filter = v.trim().toLowerCase();
      const hit = all.filter((n) => n.toLowerCase().includes(filter));
      sel.set(opts(), l.to);
      // One match left: that is the one.
      if (filter && hit.length === 1) { pick(hit[0]); sel.set(opts(), l.to); }
    }, { placeholder: 'Search', live: true, cls: 'sm' });
    search.el.addEventListener('keydown', (e) => e.stopPropagation());
    say();
    return h('div.rl-row', replace ? null : tick.el, h('div.rl-old', h('div.lib-name', l.name), h('div.lib-sub', `${tool(l.type).label}${l.ids.length > 1 ? `, used ${l.ids.length} times` : ''}`)), icon('chevronRight'), h('div.rl-new', h('div.rl-pick', search.el, sel.el), why));
  });
  const done = () => layer.remove();
  function apply(): void {
    const use = lines.filter((l) => l.use && l.to);
    let n = 0;
    mutate((root) => { for (const l of use) for (const id of l.ids) { const f = findItem(root, id); if (f) { relink(f.item, l.to); n++; } } });
    emit('select');
    done();
    toast(`${n} ${n === 1 ? 'entry' : 'entries'} now ${n === 1 ? 'uses' : 'use'} ${use.length === 1 ? use[0].to.split('/').pop() : 'the new clips'}`);
  }
  const layer = h('div.sheet-layer', h('div.sheet.relink', h('h3', replace ? 'Replace clip' : `${lines.length} missing ${lines.length === 1 ? 'clip' : 'clips'}`),
    h('p', replace ? 'Everything else about the entry stays as it is.' : 'Pick what each clip is called now. Channel, layer, trims, remote ID and everything else stay as they are.'),
    h('div.rl-list', ...rows), h('div.actions', button('Cancel', done), go)));
  layer.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(); });
  document.body.append(layer);
  count();
}
