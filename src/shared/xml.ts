// Reads and writes the original client's rundown XML. A playlist is written as an AutoPlay group with a few
// extra tags, so the original client can still open the file (it sees an ordinary group).
import { isContainer, newItem, tool } from './tools';
import type { Item, KV } from './types';

interface Node { tag: string; text: string; kids: Node[] }

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m));
const encode = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

export function parseXml(src: string): Node {
  const root: Node = { tag: '', text: '', kids: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!(?:[^>]*)>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(src))) {
    if (m.index !== last) throw new Error(`Not valid XML near "${src.slice(last, last + 30)}"`);
    last = re.lastIndex;
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[3]) {
      if (m[2]) {
        if (stack.length < 2 || top.tag !== m[3]) throw new Error(`Unexpected </${m[3]}>`);
        stack.pop();
      } else {
        const n: Node = { tag: m[3], text: '', kids: [] };
        top.kids.push(n);
        if (!m[5]) stack.push(n);
      }
    } else if (m[6]) top.text += decode(m[6]);
  }
  if (stack.length !== 1 || last !== src.length) throw new Error('The file ends too early');
  return root;
}

const BASE = ['type', 'devicename', 'label', 'name', 'channel', 'videolayer', 'delay', 'duration', 'allowgpi', 'allowremotetriggering', 'remotetriggerid', 'storyid', 'color', 'expanded', 'items', 'cgplaylist', 'cgtake', 'cgshellitem'];
const DATA_TAGS = ['templatedata', 'httpdata'];

function readData(n: Node): KV[] {
  // The original writes <componentdata><id>/<key> + <value>; accept either spelling.
  return n.kids.map((k) => {
    const v = (t: string) => k.kids.find((x) => x.tag === t)?.text ?? '';
    return { key: v('id') || v('key'), value: v('value') };
  });
}

function readItem(n: Node): Item {
  const get = (t: string) => n.kids.find((k) => k.tag === t)?.text;
  const num = (t: string, d: number) => { const v = Number(get(t)); return get(t) !== undefined && get(t) !== '' && Number.isFinite(v) ? v : d; };
  const bool = (t: string) => get(t) === 'true';
  let type = get('type') ?? 'SEPARATOR';
  if (type === 'GROUP' && bool('cgplaylist')) type = 'PLAYLIST';
  if (type === 'CUSTOMCOMMAND' && bool('cgtake')) type = 'CGTAKE';
  if (type === 'CUSTOMCOMMAND' && bool('cgshellitem')) type = 'SHELL';
  const t = tool(type);
  const item = newItem(type, {
    label: get('label') ?? '', name: get('name') ?? '', device: get('devicename') ?? '', channel: num('channel', 1), layer: num('videolayer', t.layer ?? 10),
    delay: num('delay', 0), duration: num('duration', 0), allowGpi: bool('allowgpi'), allowRemote: bool('allowremotetriggering'), remoteId: get('remotetriggerid') ?? '', storyId: get('storyid') ?? '',
  });
  const color = get('color');
  if (color) item.color = color;
  const extra: Record<string, string> = {};
  for (const k of n.kids) {
    const p = t.props.find((x) => x.key === k.tag);
    if (p) item.props[p.key] = p.kind === 'bool' ? k.text === 'true' : p.kind === 'num' || p.kind === 'int' || p.kind === 'pct' ? (Number.isFinite(Number(k.text)) && k.text !== '' ? Number(k.text) : p.def) : k.text;
    else if (DATA_TAGS.includes(k.tag)) item.data = readData(k);
    else if (!BASE.includes(k.tag) && !k.kids.length && !['autostep', 'autoplay', 'transtitionDuration'].includes(k.tag) && !((type === 'CGTAKE' || type === 'SHELL') && (k.tag.endsWith('Command') || k.tag === 'triggeronnext'))) extra[k.tag] = k.text;
  }
  // Older files used a misspelt tag; the original still reads it.
  const old = get('transtitionDuration');
  if (old !== undefined && 'transitionDuration' in item.props && get('transitionDuration') === undefined) item.props.transitionDuration = Number(old) || 0;
  if (Object.keys(extra).length) item.extra = extra;
  if (isContainer(item)) {
    item.expanded = get('expanded') !== 'false';
    item.items = (n.kids.find((k) => k.tag === 'items')?.kids ?? []).filter((k) => k.tag === 'item').map(readItem);
  }
  return item;
}

export function parseRundown(src: string): { items: Item[]; allowRemote: boolean } {
  const root = parseXml(src.replace(/^﻿/, '')).kids.find((k) => k.tag === 'items');
  if (!root) throw new Error('This is not a CasparCG rundown (no <items>)');
  return { allowRemote: root.kids.find((k) => k.tag === 'allowremotetriggering')?.text === 'true', items: root.kids.filter((k) => k.tag === 'item').map(readItem) };
}

export function writeRundown(items: Item[], allowRemote: boolean): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const tag = (d: number, t: string, v: unknown) => out.push(`${'    '.repeat(d)}<${t}>${encode(String(v))}</${t}>`);
  const put = (i: Item, d: number) => {
    const pad = '    '.repeat(d);
    const pl = i.type === 'PLAYLIST';
    out.push(`${pad}<item>`);
    tag(d + 1, 'type', pl ? 'GROUP' : i.type === 'CGTAKE' || i.type === 'SHELL' ? 'CUSTOMCOMMAND' : i.type);
    if (!isContainer(i) || pl) tag(d + 1, 'devicename', i.device);
    tag(d + 1, 'label', i.label);
    if (isContainer(i)) tag(d + 1, 'expanded', i.expanded !== false);
    else tag(d + 1, 'name', i.name);
    tag(d + 1, 'channel', i.channel); tag(d + 1, 'videolayer', i.layer); tag(d + 1, 'delay', i.delay); tag(d + 1, 'duration', i.duration);
    tag(d + 1, 'allowgpi', i.allowGpi); tag(d + 1, 'allowremotetriggering', i.allowRemote); tag(d + 1, 'remotetriggerid', i.remoteId); tag(d + 1, 'storyid', i.storyId);
    for (const p of tool(i.type).props) tag(d + 1, p.key, i.props[p.key] ?? p.def);
    if (pl) { tag(d + 1, 'autostep', false); tag(d + 1, 'autoplay', true); tag(d + 1, 'cgplaylist', true); }
    if (i.type === 'CGTAKE') { tag(d + 1, 'playCommand', `SWAP ${i.props.cgttochannel}-${i.props.cgttolayer} ${i.props.cgtfromchannel}-${i.props.cgtfromlayer}`); tag(d + 1, 'cgtake', true); }
    if (i.type === 'SHELL') tag(d + 1, 'cgshellitem', true);
    for (const [k, v] of Object.entries(i.extra ?? {})) tag(d + 1, k, v);
    if (i.color) tag(d + 1, 'color', i.color);
    const dataTag = tool(i.type).data;
    if (dataTag && i.data?.length) {
      out.push(`${pad}    <${dataTag}>`);
      for (const kv of i.data) {
        out.push(`${pad}        <componentdata>`);
        tag(d + 3, dataTag === 'httpdata' ? 'key' : 'id', kv.key); tag(d + 3, 'value', kv.value);
        out.push(`${pad}        </componentdata>`);
      }
      out.push(`${pad}    </${dataTag}>`);
    }
    if (isContainer(i)) {
      out.push(`${pad}    <items>`);
      for (const c of i.items ?? []) put(pl && c.type === 'MOVIE' ? { ...c, props: { ...c.props, autoplay: true } } : c, d + 2);
      out.push(`${pad}    </items>`);
    }
    out.push(`${pad}</item>`);
  };
  out.push('<items>');
  tag(1, 'allowremotetriggering', allowRemote);
  for (const i of items) put(i, 1);
  out.push('</items>', '');
  return out.join('\n');
}
