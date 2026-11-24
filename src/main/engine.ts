// Playlists, transport for any layer, and takes between any two channels.
// A "deck" is a playlist loaded on a layer. Decks move with their layer when a take swaps two layers.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { emptyLayer, stem, type Deck, type Item, type LayerState, type Loc, type Settings } from '../shared/types';
import { q } from './commands';
import type { Device } from './device';

export class Refused extends Error {}
export interface TakeOpts { fade: boolean; roll: boolean; hold: boolean; frames: number }
interface Live extends Deck { clips: { id: string; name: string; label: string; trim?: string }[]; mix: number; seen: boolean; since: number; stopped: boolean; loadedAt?: number }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Engine extends EventEmitter {
  decks = new Map<string, Live>();
  busy = false;
  private chain: Promise<unknown> = Promise.resolve();
  /** What was last on each layer without a playlist, so Play after Stop can bring it back. */
  private last = new Map<string, string>();
  private saveTimer: NodeJS.Timeout | null = null;
  /** Where the last seek on a layer went, so quick repeated taps add up instead of reading a stale position. */
  private sought = new Map<string, { clip: string; to: number; t: number }>();

  constructor(private device: (name: string) => Device | undefined, private settings: () => Settings, private file: string) {
    super();
    this.restore();
    setInterval(() => void this.follow(), 60);
  }

  key = (device: string, ch: number, layer: number) => `${device}|${ch}-${layer}`;

  /** Serialise anything that changes decks or takes. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  layer(device: string, ch: number, layer: number): LayerState {
    return this.device(device)?.layers().get(`${ch}-${layer}`) ?? emptyLayer();
  }
  private must(name: string): Device {
    const d = this.device(name);
    if (!d?.connected) throw new Refused(`${name || 'The server'} is not connected`);
    return d;
  }
  /** The server used when nothing else is said: the first one in Settings. */
  home(): string {
    return this.settings().devices[0]?.name ?? '';
  }
  deckAt(t: Loc): Live | null {
    return this.decks.get(this.key(t.device, t.channel, t.layer)) ?? null;
  }
  ended(l: LayerState): boolean {
    return l.producer !== 'empty' && l.end > 0 && !l.loop && l.end - l.pos <= 0.05;
  }

  // ---- playlists -----------------------------------------------------------------------------------
  private nextIndex(d: Live): number | null {
    const n = d.index + 1;
    return n < d.clips.length ? n : d.loop && d.clips.length ? 0 : null;
  }

  /** What plays by itself after this clip. */
  private autoNext(d: Live): number | null {
    return d.manual ? null : this.nextIndex(d);
  }
  /** A playlist that waits for Next is holding at the end of a clip, with another to come. */
  waiting(d: Live | null | undefined, l: LayerState): boolean {
    return !!d?.manual && !d.stopped && this.ended(l) && this.nextIndex(d) !== null;
  }

  private async queueNext(d: Live): Promise<void> {
    const n = this.autoNext(d);
    // A one-clip loop has nothing different to queue; the server loops it by itself.
    d.queued = n !== null && n !== d.index ? n : null;
    if (d.queued === null) return;
    const mix = d.mix > 0 ? ` MIX ${d.mix}` : '';
    await this.must(d.device).cmd(`LOADBG ${d.channel}-${d.layer} ${q(d.clips[d.queued].name)}${d.clips[d.queued].trim ?? ''}${mix} AUTO`);
  }

  private async put(d: Live, index: number, play: boolean, mix = 0): Promise<void> {
    d.index = index;
    d.clip = d.clips[index].name;
    d.seen = false;
    d.stopped = false;
    d.since = Date.now();
    d.queued = null;
    const single = d.loop && !d.manual && d.clips.length === 1 ? ' LOOP' : '';
    await this.must(d.device).cmd(`${play ? 'PLAY' : 'LOAD'} ${d.channel}-${d.layer} ${q(d.clip)}${d.clips[index].trim ?? ''}${mix > 0 ? ` MIX ${mix}` : ''}${single}`);
    this.decks.set(this.key(d.device, d.channel, d.layer), d);
    d.since = Date.now();
    await this.queueNext(d);
    this.changed();
  }

  static clipsOf(pl: Item): Live['clips'] {
    return (pl.items ?? []).filter((i) => i.type === 'MOVIE').map((i) => ({ id: i.id, name: i.name, label: i.label || i.name, trim: `${Number(i.props.seek) > 0 ? ` SEEK ${Number(i.props.seek)}` : ''}${Number(i.props.length) > 0 ? ` LENGTH ${Number(i.props.length)}` : ''}` }));
  }

  /** Load a playlist (paused) or play it, at `index`, on `target` or on its own channel and layer. */
  async startPlaylist(pl: Item, index = 0, play = false, target?: Loc): Promise<void> {
    const clips = Engine.clipsOf(pl);
    if (!clips.length) throw new Refused(`${pl.label} has no videos in it`);
    const t = target ?? { device: pl.device || this.home(), channel: pl.channel, layer: pl.layer };
    // A stopped copy somewhere else is finished with.
    for (const [k, d] of this.decks) if (d.playlistId === pl.id && d.stopped) this.decks.delete(k);
    await this.put({
      ...t, loadedAt: Date.now(), playlistId: pl.id, label: pl.label, index: 0, count: clips.length, clips, queued: null, clip: '', seen: false, since: 0, stopped: false,
      loop: pl.props.cgloop === 'Loop forever', manual: pl.props.cgauto === false, mix: pl.props.cgtransition === 'MIX' ? Number(pl.props.cgtransitionframes) || 0 : 0,
    }, Math.max(0, Math.min(clips.length - 1, index)), play);
  }

  /** The playlist was edited: keep its place and re-queue if what comes next changed. */
  async playlistEdited(pl: Item): Promise<void> {
    for (const d of this.decks.values()) {
      if (d.playlistId !== pl.id) continue;
      // The server may have just moved on to the queued clip; work from what is really on screen.
      const on = this.layer(d.device, d.channel, d.layer).name;
      if (on && d.queued !== null && d.clips[d.queued] && stem(on) === stem(d.clips[d.queued].name) && stem(on) !== stem(d.clip)) {
        Object.assign(d, { index: d.queued, clip: d.clips[d.queued].name, queued: null });
      }
      const clips = Engine.clipsOf(pl);
      const loop = pl.props.cgloop === 'Loop forever';
      const mix = pl.props.cgtransition === 'MIX' ? Number(pl.props.cgtransitionframes) || 0 : 0;
      const curId = d.clips[d.index]?.id;
      const manual = pl.props.cgauto === false;
      const as = (c?: Live['clips'][number]) => (c ? `${c.name}${c.trim ?? ''}` : null);
      const nextName = d.queued === null ? null : as(d.clips[d.queued]);
      const was = `${nextName}|${d.mix}`;
      let at = clips.findIndex((c) => c.id === curId);
      if (at < 0) at = Math.min(d.index, clips.length) - 1; // the playing clip was removed: carry on with what followed it
      Object.assign(d, { clips, count: clips.length, loop, manual, mix, label: pl.label, index: at });
      const n = this.autoNext(d);
      const now = `${n === null || n === d.index ? null : as(clips[n])}|${mix}`;
      if (was !== now && this.device(d.device)?.connected && !d.stopped) {
        if (n === null || n === d.index) {
          d.queued = null;
          // Nothing follows any more: a plain LOADBG (no AUTO) replaces the queued clip and never starts by itself.
          await this.device(d.device)!.cmd(`LOADBG ${d.channel}-${d.layer} #00000000`).catch(() => undefined);
        } else await this.queueNext(d).catch(() => undefined);
      } else d.queued = n === d.index ? null : n;
      this.changed();
    }
  }

  /** Every copy of a loaded playlist, most recently loaded first: commands go to that one. */
  private newest(): Live[] {
    return [...this.decks.values()].sort((a, b) => Number(a.stopped) - Number(b.stopped) || (b.loadedAt ?? 0) - (a.loadedAt ?? 0));
  }
  deckOf(id: string): Live | undefined {
    return this.newest().find((d) => d.playlistId === id);
  }

  async step(d: Live, by: number): Promise<string> {
    let n = d.index + by;
    if (d.loop) n = (n + d.clips.length) % d.clips.length;
    else if (n < 0 || n >= d.clips.length) throw new Refused(`Already at the ${by > 0 ? 'last' : 'first'} clip`);
    const l = this.layer(d.device, d.channel, d.layer);
    const playing = l.producer !== 'empty' && !l.paused;
    await this.put(d, n, playing, playing && d.manual ? d.mix : 0);
    return `${n + 1} of ${d.clips.length}: ${d.clips[n].label}`;
  }

  /** Watch the server move through playlists by itself, and notice when something else takes a layer. */
  private async follow(): Promise<void> {
    if (this.busy) return;
    for (const [key, d] of this.decks) {
      const dev = this.device(d.device);
      if (!dev?.connected) continue;
      const l = this.layer(d.device, d.channel, d.layer);
      if (!l.name) continue;
      const s = stem(l.name);
      if (s === stem(d.clip)) d.seen = true;
      else if (d.seen && d.queued !== null && d.clips[d.queued] && s === stem(d.clips[d.queued].name)) {
        const n = d.queued;
        Object.assign(d, { index: n, clip: d.clips[n].name, queued: null, seen: false, since: Date.now() });
        this.changed();
        void this.run(() => (this.decks.get(key) === d && d.queued === null ? this.queueNext(d) : Promise.resolve())).catch(() => undefined);
      } else if (!d.stopped && Date.now() - d.since > 1000) {
        // Lost our place: if it is one of this playlist's clips, carry on from there.
        const at = d.clips.findIndex((c) => stem(c.name) === s);
        if (at >= 0) {
          Object.assign(d, { index: at, clip: d.clips[at].name, queued: null, seen: true, since: Date.now() });
          this.changed();
          void this.run(() => (this.decks.get(key) === d ? this.queueNext(d) : Promise.resolve())).catch(() => undefined);
          continue;
        }
        if (Date.now() - d.since <= 2000) continue;
        this.decks.delete(key);
        this.changed();
        this.emit('log', 'info', `${d.label} was replaced on ${d.channel}-${d.layer} by something else`);
      }
    }
  }

  // ---- any layer ---------------------------------------------------------------------------------------
  async transport(t: Loc, verb: string): Promise<string> {
    const at = `${t.channel}-${t.layer}`;
    const key = this.key(t.device, t.channel, t.layer);
    const dev = this.must(t.device);
    const l = this.layer(t.device, t.channel, t.layer);
    const d = this.deckAt(t);
    const empty = l.producer === 'empty';
    if (!empty && l.name) this.last.set(key, l.name);
    switch (verb) {
      case 'play':
        if (empty) {
          if (d) await this.put(d, Math.max(0, d.index), true);
          else if (this.last.get(key)) await dev.cmd(`PLAY ${at} ${q(this.last.get(key))}`);
          else throw new Refused(`${at} is empty`);
        } else if (this.waiting(d, l)) return `${d!.label} ${await this.step(d!, 1)}`;
        else {
          if (this.ended(l)) await dev.cmd(`CALL ${at} SEEK 0`);
          await dev.cmd(`RESUME ${at}`); // not PLAY: that would jump to the queued clip
        }
        return `${at} play`;
      case 'pause':
        if (empty) throw new Refused(`${at} is empty`);
        await dev.cmd(`PAUSE ${at}`);
        return `${at} pause`;
      case 'toggle':
        return this.transport(t, empty || l.paused || this.ended(l) ? 'play' : 'pause');
      case 'stop':
        await dev.cmd(`CLEAR ${at}`);
        if (d) {
          d.stopped = true;
          d.queued = null;
        }
        this.changed();
        return `${at} stopped`;
      case 'back': case 'forward': return this.seek(t, (verb === 'back' ? -1 : 1) * this.settings().skipSeconds);
      case 'start': return this.seek(t, 0, true);
      case 'next': case 'prev':
        if (!d) throw new Refused(`${at} is not playing a playlist`);
        return `${d.label} ${await this.step(d, verb === 'next' ? 1 : -1)}`;
    }
    throw new Refused(`Unknown command ${verb}`);
  }

  async seek(t: Loc, by: number, absolute = false): Promise<string> {
    const at = `${t.channel}-${t.layer}`;
    const key = this.key(t.device, t.channel, t.layer);
    const l = this.layer(t.device, t.channel, t.layer);
    if (l.producer === 'empty' || !l.end) throw new Refused(`${at} has nothing to seek`);
    const dev = this.must(t.device);
    const fps = dev.fps(t.channel);
    const first = Math.round(l.start * fps);
    const last = Math.max(first, Math.round(l.end * fps) - 5);
    const s = this.sought.get(key);
    const fresh = s && s.clip === l.name && Date.now() - s.t < 600;
    const now = fresh ? s.to + (l.paused ? 0 : (Date.now() - s.t) / 1000) : l.pos;
    const f = Math.min(last, Math.max(first, Math.round((absolute ? l.start + by : now + by) * fps)));
    this.sought.set(key, { clip: l.name, to: f / fps, t: Date.now() });
    await dev.cmd(`CALL ${at} SEEK ${f}`);
    return `${at} ${(f / fps).toFixed(1)}s`;
  }

  /** Put what is on one layer onto another, by swapping the two. Works between any two channels of one server. */
  async take(from: Loc, to: Loc, o: TakeOpts): Promise<string> {
    if (from.device !== to.device) throw new Refused('Both channels have to be on the same server');
    const a = `${from.channel}-${from.layer}`;
    const b = `${to.channel}-${to.layer}`;
    if (a === b) throw new Refused('Choose two different layers');
    const dev = this.must(to.device);
    const n = dev.channels.length;
    if (from.channel > n || to.channel > n) throw new Refused(`${dev.cfg.name} has ${n} channels`);
    const [fa, fb] = [dev.channels[from.channel - 1], dev.channels[to.channel - 1]];
    if (fa !== fb) throw new Refused(`Channel ${from.channel} is ${fa} and channel ${to.channel} is ${fb}; clips can only move between channels of the same format`);
    const src = this.layer(from.device, from.channel, from.layer);
    if (src.producer === 'empty') throw new Refused(`${a} is empty, so there is nothing to take`);
    const overLayer = to.layer + 1;
    const over = `${to.channel}-${overLayer}`;
    // Same channel and the layer above: a fade has nowhere to work.
    if (o.fade && (over === a || this.layer(to.device, to.channel, overLayer).producer !== 'empty')) throw new Refused(`A fade to ${b} needs layer ${overLayer} on that channel to be free`);
    this.busy = true;
    try {
      if (o.roll && this.ended(src)) await dev.cmd(`CALL ${a} SEEK 0`);
      if (!o.fade) {
        await dev.series([...(o.hold ? [`PAUSE ${b}`] : []), `SWAP ${b} ${a}`, ...(o.roll ? [`RESUME ${b}`] : [])]);
      } else {
        const f = Math.max(1, o.frames);
        // Bring it in on the layer above, invisible, and fade it up over what is there.
        await dev.series([
          `MIXER ${over} OPACITY 0`, `MIXER ${over} VOLUME 0`, `SWAP ${over} ${a}`, ...(o.roll ? [`RESUME ${over}`] : []),
          `MIXER ${over} OPACITY 1 ${f}`, `MIXER ${over} VOLUME 1 ${f}`, `MIXER ${b} VOLUME 0 ${f}`,
        ]);
        await sleep(((f + 3) / dev.fps(to.channel)) * 1000);
        // The old clip leaves from underneath, then the new one drops onto its normal layer: the picture never changes.
        await dev.series([...(o.hold ? [`PAUSE ${b}`] : []), `SWAP ${b} ${a}`, `MIXER ${b} VOLUME 1`, `SWAP ${b} ${over}`, `MIXER ${over} OPACITY 1`, `MIXER ${over} VOLUME 1`]);
      }
      const ka = this.key(from.device, from.channel, from.layer);
      const kb = this.key(to.device, to.channel, to.layer);
      const da = this.decks.get(ka);
      const db = this.decks.get(kb);
      this.decks.delete(ka);
      this.decks.delete(kb);
      if (da) this.decks.set(kb, Object.assign(da, { ...to, seen: false, since: Date.now() }));
      if (db) this.decks.set(ka, Object.assign(db, { ...from, seen: false, since: Date.now() }));
      const la = this.last.get(ka) ?? src.name;
      const lb = this.last.get(kb);
      this.last.set(kb, la ?? '');
      this.last.set(ka, lb ?? '');
      this.changed();
      await sleep(120); // let the status feed catch up before playlists are followed again
    } finally {
      this.busy = false;
    }
    return `${o.fade ? 'Fade' : 'Cut'} ${a} to ${b}${o.roll ? ' and play' : ''}`;
  }

  // ---- surviving a restart ---------------------------------------------------------------------------
  list(): Deck[] {
    return this.newest().map(({ device, channel, layer, playlistId, label, index, count, loop, manual, queued, clip, resumed }) => ({ device, channel, layer, playlistId, label, index, count, loop, manual, queued, clip, resumed }));
  }
  /** True when a playlist that is still moving needs this app to carry on. */
  needed(): Live[] {
    return [...this.decks.values()].filter((d) => {
      const l = this.layer(d.device, d.channel, d.layer);
      return !d.stopped && l.producer !== 'empty' && !l.paused && this.autoNext(d) !== null;
    });
  }
  private changed(): void {
    this.emit('changed');
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 150);
  }
  saveNow(): void {
    try { fs.writeFileSync(this.file, JSON.stringify([...this.decks.values()])); } catch { /* not fatal */ }
  }
  private restore(): void {
    let saved: Live[] = [];
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Live[]; } catch { return; }
    for (const d of saved) if (d?.clips?.length) this.decks.set(this.key(d.device, d.channel, d.layer), { ...d, seen: false, since: Date.now() + 3000, resumed: true });
  }
  /** After connecting: pick playlists up from what the server is really playing. */
  async resume(device: string): Promise<void> {
    await sleep(700);
    await this.run(async () => {
      for (const [key, d] of this.decks) {
        if (d.device !== device || d.stopped) continue;
        const l = this.layer(d.device, d.channel, d.layer);
        const s = l.name ? stem(l.name) : '';
        let at = s === stem(d.clip) ? d.index : -1;
        if (at < 0 && d.queued !== null && d.clips[d.queued] && s === stem(d.clips[d.queued].name)) at = d.queued;
        if (at < 0 || l.producer === 'empty') {
          this.decks.delete(key);
          this.changed();
          continue;
        }
        Object.assign(d, { index: at, clip: d.clips[at].name, seen: true, since: Date.now() });
        const n = this.autoNext(d);
        if (l.next && n !== null && stem(l.next) === stem(d.clips[n].name)) d.queued = n;
        else await this.queueNext(d).catch(() => undefined);
        this.emit('log', 'info', `Picked ${d.label} back up at clip ${at + 1} of ${d.clips.length}`);
        this.changed();
      }
    });
  }
}
