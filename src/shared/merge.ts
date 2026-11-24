// Two screens can edit one rundown. This puts what one of them changed on top of what the other has.
import type { Doc, Item } from './types';

type Node = { item: Item; parent: string };
interface Tree { nodes: Map<string, Node>; kids: Map<string, string[]>; odd: boolean }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function tree(items: Item[]): Tree {
  const t: Tree = { nodes: new Map(), kids: new Map([['', []]]), odd: false };
  const go = (list: Item[], parent: string) => {
    for (const i of list) {
      if (t.nodes.has(i.id)) t.odd = true;
      t.nodes.set(i.id, { item: i, parent });
      t.kids.get(parent)!.push(i.id);
      if (i.items) { t.kids.set(i.id, []); go(i.items, i.id); }
    }
  };
  go(items, '');
  return t;
}
/** Put ids into a list after whatever comes before them in another list. */
function place(list: string[], extra: Set<string>, ref: string[]): void {
  ref.forEach((id, n) => {
    if (!extra.has(id) || list.includes(id)) return;
    let at = -1;
    for (let k = n - 1; k >= 0 && at < 0; k--) at = list.indexOf(ref[k]);
    list.splice(at + 1, 0, id);
  });
}

/** `theirs`, plus everything that differs between `base` and `mine`. */
export function mergeItems(base: Item[], mine: Item[], theirs: Item[]): Item[] {
  if (same(base, mine)) return theirs;
  if (same(base, theirs)) return mine;
  const B = tree(base);
  const M = tree(mine);
  const T = tree(theirs);
  if (B.odd || M.odd || T.odd) return mine; // entries that cannot be told apart
  const out = new Map<string, Node>();
  for (const [id, n] of T.nodes) if (M.nodes.has(id) || !B.nodes.has(id)) out.set(id, { item: { ...n.item, props: { ...n.item.props } }, parent: n.parent });
  for (const [id, n] of M.nodes) {
    const b = B.nodes.get(id);
    const o = out.get(id);
    if (!b) {
      if (!o) out.set(id, { item: { ...n.item, props: { ...n.item.props } }, parent: n.parent });
      continue;
    }
    if (!o) continue; // they deleted it
    const x = o.item as unknown as Record<string, unknown>;
    const was = b.item as unknown as Record<string, unknown>;
    const now = n.item as unknown as Record<string, unknown>;
    for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (k === 'items' || k === 'id' || k === 'props' || same(was[k], now[k])) continue;
      if (k in now) x[k] = now[k]; else delete x[k];
    }
    for (const k of new Set([...Object.keys(b.item.props), ...Object.keys(n.item.props)])) {
      if (same(b.item.props[k], n.item.props[k])) continue;
      if (k in n.item.props) o.item.props[k] = n.item.props[k]; else delete o.item.props[k];
    }
    if (n.parent !== b.parent) o.parent = n.parent;
  }
  const box = (id: string) => id === '' || (!!out.get(id) && !!out.get(id)!.item.items);
  for (const n of out.values()) if (!box(n.parent)) n.parent = '';

  const kids = new Map<string, string[]>();
  for (const p of ['', ...[...out].filter(([, n]) => n.item.items).map(([id]) => id)]) {
    const here = new Set([...out].filter(([, n]) => n.parent === p).map(([id]) => id));
    const b = B.kids.get(p) ?? [];
    const m = M.kids.get(p) ?? [];
    const t = T.kids.get(p) ?? [];
    const both = (a: string[], c: string[]) => a.filter((id) => c.includes(id));
    const moved = !same(both(b, m), both(m, b));
    const [first, second] = moved ? [m, t] : [t, m];
    // What I moved in or added follows my neighbours; the rest keeps its place.
    const list = first.filter((id) => here.has(id));
    place(list, here, second);
    for (const id of here) if (!list.includes(id)) list.push(id);
    kids.set(p, list);
  }
  const build = (p: string): Item[] => kids.get(p)!.map((id) => { const { item } = out.get(id)!; return item.items ? { ...item, items: build(id) } : item; });
  return build('');
}

export function mergeDoc(base: Doc, mine: Doc, theirs: Doc): Doc {
  const pick = <K extends keyof Doc>(k: K): Doc[K] => (same(base[k], mine[k]) ? theirs[k] : mine[k]);
  const items = mergeItems(base.items, mine.items, theirs.items);
  const out: Doc = { ...theirs, path: pick('path'), name: pick('name'), allowRemote: pick('allowRemote'), dirty: pick('dirty'), items };
  // Unless it is exactly what one of us saved, it still has to be.
  if (!same(items, theirs.items)) out.dirty = !same(items, mine.items) || mine.dirty;
  return out;
}

/** Keep groups open or folded as they are on this screen. */
export function keepFolds(from: Item[], to: Item[]): void {
  const was = new Map(from.map((i) => [i.id, i.expanded]));
  for (const i of to) if (i.items && was.has(i.id)) { const e = was.get(i.id); if (e === undefined) delete i.expanded; else i.expanded = e; }
}
