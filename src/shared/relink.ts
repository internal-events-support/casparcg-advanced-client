// Missing clips: which rundown items point at media the server does not have, and what they are probably called now.
import { tool } from './tools';
import type { Item, Library, MediaEntry } from './types';

/** A clip as it was when it was last seen on a server. */
export type Seen = Record<string, MediaEntry>;
export interface Guess { name: string; score: number; why: string }

const norm = (n: string) => n.replace(/\\/g, '/').toLowerCase();
const base = (n: string) => norm(n).split('/').pop()!;
const plain = (n: string) => base(n).replace(/\.[a-z0-9]{2,4}$/, '').replace(/[^a-z0-9]+/g, ' ').trim();

let cache: { lib: Library | null; media: Set<string>; templates: Set<string> } = { lib: null, media: new Set(), templates: new Set() };
/** True when the server's list is known and this item's clip or template is not in it. */
export function isMissing(i: Item, lib: Library | undefined): boolean {
  const kind = tool(i.type).named;
  if (!kind || !lib || !i.name) return false;
  if (cache.lib !== lib) cache = { lib, media: new Set(lib.media.map((m) => norm(m.name))), templates: new Set(lib.templates.map(norm)) };
  const list = kind === 'TEMPLATE' ? cache.templates : cache.media;
  return list.size > 0 && !list.has(norm(i.name));
}

/** 0 to 1: how alike two names are. */
export function alike(a: string, b: string): number {
  const x = plain(a);
  const y = plain(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  let prev = [...Array(y.length + 1).keys()];
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = row;
  }
  const edit = 1 - prev[y.length] / Math.max(x.length, y.length);
  const p = x.split(' ');
  const q = y.split(' ');
  const shared = p.filter((w) => q.includes(w)).length / Math.max(1, Math.min(p.length, q.length));
  // "intro" and "intro final v2": everything in the shorter name is there.
  return Math.max(edit, shared * 0.85 * (shared === 1 ? 1 : 0.8));
}

/** Likely new names for a missing clip, best first. */
export function guesses(i: Item, lib: Library, seen: Seen | undefined): Guess[] {
  const kind = tool(i.type).named;
  if (kind === 'TEMPLATE') {
    return lib.templates.map((n) => ({ name: n, score: Math.round(alike(i.name, n) * 80), why: base(n) === base(i.name) ? 'Same name, moved' : 'Similar name' })).filter((g) => g.score >= 40).sort((a, b) => b.score - a.score).slice(0, 8);
  }
  const was = seen?.[norm(i.name)];
  const out: Guess[] = [];
  for (const m of lib.media) {
    if (kind && m.type !== kind) continue;
    if (was && was.size > 0 && m.size === was.size && m.frames === was.frames) { out.push({ name: m.name, score: 100, why: 'Same file, renamed or moved' }); continue; }
    const same = base(m.name) === base(i.name);
    const len = !!was && was.frames > 1 && m.frames === was.frames;
    const score = same ? 90 : Math.round(alike(i.name, m.name) * 75) + (len ? 18 : 0);
    if (score >= 45) out.push({ name: m.name, score, why: same ? 'Same name, moved' : len ? 'Similar name, same length' : 'Similar name' });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 8);
}

/** Point an item at another clip and keep everything else. The label follows only if it was just the old file name. */
export function relink(i: Item, name: string): void {
  if (!i.label || base(i.label) === base(i.name)) i.label = name.replace(/\\/g, '/').split('/').pop()!;
  i.name = name;
}
