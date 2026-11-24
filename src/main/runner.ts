// Executes rundown items: delays, durations, groups, playlists, HTTP/OSC tools and per-item state.
import { spawn, type ChildProcess } from 'node:child_process';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import { findItem, isPlaylist, walk } from '../shared/tools';
import { stem, type Action, type Doc, type Item, type Loc, type Settings } from '../shared/types';
import { commandsFor, previewCommands, type Run } from './commands';
import type { Device } from './device';
import { Refused, type Engine } from './engine';
import { encode } from './osc';

type RtState = 'loaded' | 'playing' | 'paused' | '';
interface Rt extends Run { playing: boolean; used: boolean; timers: NodeJS.Timeout[] }
/** Auto play queue of an ordinary group: plays its videos one after another, like the original client. */
interface GroupQueue { key: string; group: string; items: Item[]; waiting: Item | null }

export class Runner extends EventEmitter {
  docs = new Map<string, Doc>();
  private rt = new Map<string, Rt>();
  private queues: GroupQueue[] = [];
  private shells = new Map<string, ChildProcess>();
  private udp = dgram.createSocket('udp4');

  constructor(private device: (n: string) => Device | undefined, private devices: () => Device[], private engine: Engine, private settings: () => Settings) {
    super();
    this.udp.on('error', () => undefined);
    setInterval(() => this.advanceGroups(), 80);
  }

  private of(id: string): Rt {
    let r = this.rt.get(id);
    if (!r) this.rt.set(id, (r = { loaded: false, paused: false, playing: false, used: false, timers: [] }));
    return r;
  }

  find(id: string): { item: Item; parent: Item | null; doc: Doc } | null {
    for (const doc of this.docs.values()) {
      const f = findItem(doc.items, id);
      if (f) return { ...f, doc };
    }
    return null;
  }
  byRemoteId(rid: string): Item | null {
    let hit: Item | null = null;
    for (const d of this.docs.values()) {
      walk(d.items, (i) => {
        if (!hit && i.allowRemote && i.remoteId && i.remoteId === rid) hit = i;
      });
    }
    return hit;
  }
  playlists(): Item[] {
    return [...this.docs.values()].flatMap((d) => d.items.filter(isPlaylist));
  }
  setUsed(ids: string[], used: boolean): void {
    for (const id of ids) this.of(id).used = used;
  }

  private async send(i: Item, cmds: string[]): Promise<void> {
    if (!cmds.length) return;
    const main = this.device(i.device);
    if (!main) throw new Refused(i.device ? `There is no server called ${i.device}` : `${i.label}: choose a server first`);
    const shadows = this.devices().filter((d) => d.cfg.shadow && d !== main && d.connected);
    let err: Error | null = null;
    for (const c of cmds) {
      await main.cmd(c).catch((e: Error) => { err ??= e; });
      for (const d of shadows) await d.cmd(c).catch(() => undefined);
    }
    if (err) throw err as Error;
  }

  async execute(id: string, a: Action): Promise<string> {
    const f = this.find(id);
    if (!f) throw new Refused('That item is not in an open rundown');
    const { item, parent } = f;
    if (a === 'back' || a === 'forward') {
      const where = this.where(item, parent);
      return this.engine.run(() => this.engine.transport(where, a));
    }
    if (isPlaylist(item)) return this.playlist(item, a);
    if (parent && isPlaylist(parent)) return this.playlistClip(parent, item, a);
    if (item.type === 'GROUP') return this.group(item, a);
    if (parent?.type === 'GROUP' && parent.props.autoplay && item.type === 'MOVIE') {
      if (a === 'next') return this.group(parent, 'next');
      if (a === 'play') {
        // Play this clip and carry on with the ones below it.
        const kids = parent.items ?? [];
        return this.startQueue(parent.id, kids.slice(kids.indexOf(item)).filter((x) => x.type === 'MOVIE'));
      }
    }
    await this.one(item, a);
    return `${item.label}: ${a}`;
  }

  /** Where an item's clip is: a playlist may have been taken to another channel since it was loaded. */
  private where(i: Item, parent: Item | null): Loc {
    const pl = isPlaylist(i) ? i : parent && isPlaylist(parent) ? parent : null;
    const d = pl ? this.deckOf(pl) : undefined;
    if (d) return { device: d.device, channel: d.channel, layer: d.layer };
    const x = pl ?? (i.type === 'GROUP' ? (i.items ?? []).find((k) => k.type === 'MOVIE') ?? i : i);
    return { device: x.device || this.engine.home(), channel: x.channel, layer: x.layer };
  }

  // ---- one item -------------------------------------------------------------------------------------
  private async one(i: Item, a: Action): Promise<void> {
    if (i.type === 'SEPARATOR') return;
    const r = this.of(i.id);
    for (const t of r.timers.splice(0)) clearTimeout(t);
    if (a === 'play' && i.props.triggeronnext) return;
    if (a === 'play' && i.delay > 0) {
      r.timers.push(setTimeout(() => void this.fire(i, 'play').catch((e) => this.emit('problem', e)), i.delay));
      return;
    }
    await this.fire(i, a);
  }

  private async fire(i: Item, a: Action): Promise<void> {
    const r = this.of(i.id);
    const starts = a === 'play' || a === 'playNow' || (a === 'next' && !!i.props.triggeronnext);
    if (a === 'preview') {
      const d = this.device(i.device);
      const cmds = previewCommands(i, d?.cfg.preview ?? 0);
      if (!cmds.length) throw new Refused(d?.cfg.preview ? `${i.label} has no preview` : 'Set a preview channel for this server in Settings');
      return this.send(i, cmds);
    }
    if (i.type === 'HTTPGET' || i.type === 'HTTPPOST') {
      if (starts || a === 'update') await this.http(i);
    } else if (i.type === 'OSCOUTPUT') {
      if (starts || a === 'update') this.oscOut(i);
    } else if (i.type === 'PLAYOUTCOMMAND') {
      if (starts) this.emit('playout', String(i.props.playoutcommand));
    } else if (i.type === 'CGTAKE') {
      if (starts) await this.take(i);
    } else if (i.type === 'SHELL') {
      if (starts) this.shell(i, 'cgshell');
      else if (a === 'stop') { this.endShell(i.id); if (i.props.cgshellstop) this.shell(i, 'cgshellstop'); }
    } else if (i.type === 'GPIOUTPUT') {
      if (starts) throw new Refused('GPI output is not supported in this app');
    } else await this.send(i, commandsFor(i, a, r));

    if (starts) {
      r.loaded = r.paused = false;
      r.playing = true;
      if (this.settings().markUsed) r.used = true;
      if (i.duration > 0) r.timers.push(setTimeout(() => void this.fire(i, 'stop').catch((e) => this.emit('problem', e)), i.duration));
    } else if (a === 'load') {
      r.loaded = true;
      r.paused = r.playing = false;
    } else if (a === 'pause') r.paused = !r.paused;
    else if (a === 'stop' || a === 'clear' || a === 'clearLayer' || a === 'clearChannel') this.forget(i.device, i.channel, a === 'clearChannel' ? null : i.layer);
  }

  /** A layer, or a whole channel, was emptied: forget what was on it. */
  forget(device: string, channel: number, layer: number | null): void {
    for (const d of this.docs.values()) {
      walk(d.items, (x) => {
        if ((x.device || this.engine.home()) !== device || x.channel !== channel || (layer !== null && x.layer !== layer)) return;
        const y = this.rt.get(x.id);
        if (y) y.loaded = y.paused = y.playing = false;
      });
    }
    this.queues = this.queues.filter((x) => (layer === null ? !x.key.startsWith(`${device}|${channel}-`) : x.key !== this.engine.key(device, channel, layer)));
    this.engine.forget(device, channel, layer);
  }

  // ---- programs on this PC ------------------------------------------------------------------------------
  private shell(i: Item, key: 'cgshell' | 'cgshellstop'): void {
    const cmd = String(i.props[key] ?? '').trim();
    if (!this.settings().allowShell) throw new Refused('Shell commands are off. Turn them on in Settings, Rundown');
    if (!cmd) throw new Refused(`${i.label}: there is no command to run`);
    const dir = String(i.props.cgshelldir ?? '').trim() || os.homedir();
    if (!fs.existsSync(dir)) throw new Refused(`${i.label}: the folder ${dir} does not exist`);
    if (key === 'cgshell') this.endShell(i.id);
    // Several lines run one after another, stopping at the first that fails.
    const line = cmd.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join(' && ');
    const c = spawn(line, { shell: true, cwd: dir, windowsHide: true });
    let tail = '';
    const take = (d: Buffer) => { tail = (tail + String(d)).slice(-2000); };
    c.stdout?.on('data', take);
    c.stderr?.on('data', take);
    this.emit('log', 'info', `${i.label}: running ${line}`);
    if (key === 'cgshell') this.shells.set(i.id, c);
    c.on('error', (e) => this.emit('problem', new Error(`${i.label}: ${e.message}`)));
    c.on('close', (code) => {
      const ours = this.shells.get(i.id) === c;
      if (ours) { this.shells.delete(i.id); this.of(i.id).playing = false; }
      const last = tail.trim().split(/\r?\n/).pop()?.trim() ?? '';
      if (code === 0) this.emit('log', 'info', `${i.label}: finished${last ? `: ${last.slice(0, 200)}` : ''}`);
      // Ended by Stop: not a failure.
      else if (ours || key === 'cgshellstop') this.emit('problem', new Error(`${i.label} failed${code === null ? '' : ` (${code})`}${last ? `: ${last.slice(0, 200)}` : ''}`));
    });
  }
  private endShell(id: string): void {
    const c = this.shells.get(id);
    if (!c?.pid) return;
    this.shells.delete(id);
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true });
    else c.kill();
  }

  private take(i: Item): Promise<string> {
    const p = i.props;
    const device = i.device || this.engine.home();
    const from = { device, channel: Number(p.cgtfromchannel), layer: Number(p.cgtfromlayer) };
    const to = { device, channel: Number(p.cgttochannel), layer: Number(p.cgttolayer) };
    return this.engine.run(() => this.engine.take(from, to, { fade: p.cgtmode === 'Fade', roll: !!p.cgtroll, hold: !!p.cgthold, frames: Number(p.cgtframes) || 25 }));
  }

  private async http(i: Item): Promise<void> {
    let url: URL;
    try {
      url = new URL(String(i.props.url));
    } catch {
      throw new Refused(`${i.label}: that is not a valid URL`);
    }
    if (!/^https?:$/.test(url.protocol)) throw new Refused(`${i.label}: only http and https URLs work`);
    const body = new URLSearchParams((i.data ?? []).map((d) => [d.key, d.value]));
    if (i.type === 'HTTPGET') for (const [k, v] of body) url.searchParams.append(k, v);
    const res = await fetch(url, { method: i.type === 'HTTPGET' ? 'GET' : 'POST', body: i.type === 'HTTPPOST' ? body : undefined, signal: AbortSignal.timeout(8000) }).catch(() => {
      throw new Refused(`${i.label}: ${url.host} did not answer`);
    });
    this.emit('log', res.ok ? 'info' : 'err', `${i.label}: HTTP ${res.status}`);
    if (!res.ok) throw new Refused(`${i.label}: HTTP ${res.status}`);
  }

  private oscOut(i: Item): void {
    const out = this.settings().oscOutputs.find((o) => o.name === i.props.output);
    if (!out) throw new Refused(`${i.label}: there is no OSC target called "${i.props.output}" in Settings`);
    if (!String(i.props.path).startsWith('/')) throw new Refused(`${i.label}: the OSC path must start with /`);
    this.udp.send(encode(String(i.props.path), String(i.props.message), String(i.props.osctype), !!i.props.usebundle), out.port, out.host);
  }

  // ---- groups -----------------------------------------------------------------------------------------
  private async group(g: Item, a: Action): Promise<string> {
    const kids = g.items ?? [];
    const movies = kids.filter((x) => x.type === 'MOVIE');
    const r = this.of(g.id);
    if (g.props.autoplay && movies.length) {
      if (a === 'play' || a === 'load') {
        for (const k of kids) if (k.type !== 'MOVIE') await this.one(k, a);
        if (a === 'play' && this.settings().markUsed) r.used = true;
        if (a === 'play') return this.startQueue(g.id, movies);
        await this.one(movies[0], 'load');
        return `${g.label}: loaded`;
      }
      if (a === 'next') {
        const qu = this.queues.find((x) => x.group === g.id);
        if (!qu?.waiting) throw new Refused(`${g.label} has no next clip`);
        const n = qu.waiting;
        qu.waiting = qu.items.shift() ?? null;
        await this.one(n, 'playNow');
        if (qu.waiting) await this.queue(qu.waiting);
        return `${g.label}: ${n.label}`;
      }
      if (a === 'pause') {
        const m = movies[0];
        const cur = this.engine.layer(m.device, m.channel, m.layer);
        if (cur.producer === 'empty') throw new Refused(`${g.label} is not playing`);
        await this.device(m.device)!.cmd(`${cur.paused ? 'RESUME' : 'PAUSE'} ${m.channel}-${m.layer}`);
        return `${g.label}: ${cur.paused ? 'resume' : 'pause'}`;
      }
    }
    let err: Error | null = null;
    for (const k of kids) await this.one(k, a).catch((e: Error) => { err ??= e; });
    if (a === 'play' || a === 'playNow') {
      if (this.settings().markUsed) r.used = true;
      if (g.duration > 0) r.timers.push(setTimeout(() => void this.group(g, 'stop').catch(() => undefined), g.duration));
    }
    if (err) throw err as Error;
    return `${g.label}: ${a}`;
  }

  private queue(i: Item): Promise<void> {
    return this.send(i, commandsFor({ ...i, props: { ...i.props, autoplay: true } }, 'play', { loaded: false, paused: false }));
  }

  private async startQueue(group: string, movies: Item[]): Promise<string> {
    const [first, ...rest] = movies;
    const key = this.engine.key(first.device, first.channel, first.layer);
    this.queues = this.queues.filter((x) => x.key !== key);
    await this.one(first, this.of(first.id).loaded ? 'play' : 'playNow');
    const qu: GroupQueue = { key, group, items: rest, waiting: null };
    qu.waiting = qu.items.shift() ?? null;
    if (qu.waiting) {
      await this.queue(qu.waiting);
      this.queues.push(qu);
    }
    return rest.length ? `${first.label}, then ${rest.length} more` : first.label;
  }

  /** When the queued clip of an auto play group has started, queue the one after it. */
  private advanceGroups(): void {
    for (const qu of this.queues) {
      const w = qu.waiting;
      if (!w) continue;
      const l = this.engine.layer(w.device, w.channel, w.layer);
      if (!l.name || stem(l.name) !== stem(w.name)) continue;
      const r = this.of(w.id);
      r.playing = true;
      r.loaded = r.paused = false;
      if (this.settings().markUsed) r.used = true;
      qu.waiting = qu.items.shift() ?? null;
      if (qu.waiting) void this.queue(qu.waiting).catch((e) => this.emit('problem', e));
    }
    this.queues = this.queues.filter((x) => x.waiting);
  }

  // ---- playlists ----------------------------------------------------------------------------------------
  private deckOf(pl: Item) {
    return this.engine.deckOf(pl.id);
  }

  private playlist(pl: Item, a: Action): Promise<string> {
    const e = this.engine;
    return e.run(async () => {
      const d = this.deckOf(pl);
      const home = { device: pl.device || e.home(), channel: pl.channel, layer: pl.layer };
      const where = d ? { device: d.device, channel: d.channel, layer: d.layer } : home;
      const at = `${where.channel}-${where.layer}`;
      const dev = this.device(where.device);
      if (!dev?.connected) throw new Refused(`${where.device} is not connected`);
      const l = e.layer(where.device, where.channel, where.layer);
      switch (a) {
        case 'load':
          await e.startPlaylist(pl, 0, false);
          return `${pl.label}: loaded`;
        case 'play': case 'playNow':
          if (this.settings().markUsed) this.of(pl.id).used = true;
          if (d && a === 'play' && !d.stopped && l.producer !== 'empty' && l.paused) {
            await dev.cmd(`RESUME ${at}`);
            return `${pl.label}: play`;
          }
          if (d && a === 'play' && e.waiting(d, l)) return `${pl.label}: ${await e.step(d, 1)}`;
          await e.startPlaylist(pl, 0, true, where);
          return `${pl.label}: play`;
        case 'next': case 'prev':
          if (!d) throw new Refused(`${pl.label} is not loaded`);
          return `${pl.label}: ${await e.step(d, a === 'next' ? 1 : -1)}`;
        case 'pause':
          if (!d || l.producer === 'empty') throw new Refused(`${pl.label} is not loaded`);
          await dev.cmd(`${l.paused ? 'RESUME' : 'PAUSE'} ${at}`);
          return `${pl.label}: ${l.paused ? 'resume' : 'pause'}`;
        case 'stop': case 'clear': case 'clearLayer':
          await dev.cmd(`CLEAR ${at}`);
          this.forget(where.device, where.channel, where.layer);
          return `${pl.label}: stopped`;
        case 'clearChannel':
          await dev.cmd(`CLEAR ${where.channel}`);
          this.forget(where.device, where.channel, null);
          return `${pl.label}: channel cleared`;
        default:
          throw new Refused('Playlists do not use that command');
      }
    });
  }

  /** Acting on a clip inside a playlist starts the playlist from that clip. */
  private async playlistClip(pl: Item, i: Item, a: Action): Promise<string> {
    const index = (pl.items ?? []).filter((x) => x.type === 'MOVIE').findIndex((x) => x.id === i.id);
    if ((a !== 'load' && a !== 'play' && a !== 'playNow') || index < 0) return this.playlist(pl, a);
    return this.engine.run(async () => {
      const d = this.deckOf(pl);
      await this.engine.startPlaylist(pl, index, a !== 'load', d && a !== 'load' ? { device: d.device, channel: d.channel, layer: d.layer } : undefined);
      return `${pl.label}: ${a === 'load' ? 'loaded' : 'playing'} from ${i.label}`;
    });
  }

  // ---- state for the UI -----------------------------------------------------------------------------------
  states(): Record<string, { state: RtState; used: boolean }> {
    const STICKY = ['STILL', 'TEMPLATE', 'HTML', 'SOLIDCOLOR', 'IMAGESCROLLER', 'ROUTECHANNEL', 'ROUTEVIDEOLAYER', 'DECKLINKINPUT'];
    const out: Record<string, { state: RtState; used: boolean }> = {};
    for (const d of this.docs.values()) {
      walk(d.items, (i, parent) => {
        const r = this.rt.get(i.id);
        let state: RtState = '';
        const pl = isPlaylist(i) ? i : parent && isPlaylist(parent) ? parent : null;
        if (pl) {
          const deck = this.deckOf(pl);
          if (deck && !deck.stopped && (i === pl || deck.clips[deck.index]?.id === i.id)) state = this.clipState(deck.device, deck.channel, deck.layer);
        } else if (i.type === 'MOVIE' || i.type === 'AUDIO') {
          const l = this.engine.layer(i.device, i.channel, i.layer);
          if (r && (r.playing || r.loaded || r.paused) && l.name && stem(l.name) === stem(i.name)) state = this.clipState(i.device, i.channel, i.layer);
        } else if (i.type === 'SHELL') {
          if (this.shells.has(i.id)) state = 'playing';
        } else if (r) {
          const onAir = STICKY.includes(i.type) && this.engine.layer(i.device, i.channel, i.layer).producer !== 'empty';
          state = r.loaded ? 'loaded' : r.playing && onAir ? (r.paused ? 'paused' : 'playing') : '';
        }
        if (state || r?.used) out[i.id] = { state, used: !!r?.used };
      });
    }
    return out;
  }
  private clipState(device: string, ch: number, layer: number): RtState {
    const l = this.engine.layer(device, ch, layer);
    if (l.producer === 'empty') return '';
    return l.paused ? (l.pos - l.start < 0.1 ? 'loaded' : 'paused') : 'playing';
  }
}
