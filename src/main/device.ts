// One CasparCG server: AMCP connection with reconnect, plus its OSC status feed.
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { emptyLayer, type DeviceCfg, type LayerState, type MediaEntry } from '../shared/types';
import { decode } from './osc';

interface Raw { v: (string | number | boolean)[]; t: number }
interface Pending { tag: string; ok: (r: Reply) => void; bad: (e: Error) => void; timer: NodeJS.Timeout; lines: string[]; left: number | 'blank' | null; code: number }
export interface Reply { code: number; lines: string[] }
/** A layer is gone when its channel keeps reporting but the layer has not for this long. */
const STALE = 200;

export class Device extends EventEmitter {
  connected = false;
  error = '';
  version = '';
  channels: string[] = [];
  localAddress = '127.0.0.1';
  private sock: net.Socket | null = null;
  private buf = '';
  private n = 0;
  private pending: Pending[] = [];
  private udp: dgram.Socket;
  private oscPort = 0;
  private osc = new Map<string, Raw>();
  /** When each channel last reported anything. A pause in the whole feed must not look like an empty channel. */
  private beat = new Map<string, number>();
  private closed = false;
  private retry: NodeJS.Timeout | null = null;

  constructor(public cfg: DeviceCfg) {
    super();
    this.udp = dgram.createSocket('udp4');
    this.udp.on('error', (e) => this.emit('log', 'err', `OSC: ${e.message}`));
    this.udp.on('message', (b) => {
      const t = Date.now();
      try {
        decode(b, (a, v) => {
          const ch = /^\/channel\/(\d+)\//.exec(a)?.[1];
          if (ch) this.beat.set(ch, t);
          if (a.includes('/stage/layer/') || a.endsWith('/mixer/audio/volume') || a.endsWith('/framerate')) this.osc.set(a, { v, t });
        });
      } catch { /* a malformed packet is not worth dropping the feed for */ }
    });
    this.udp.bind(0, () => {
      this.oscPort = this.udp.address().port;
      try { this.udp.setRecvBufferSize(1 << 20); } catch { /* default is fine */ }
      this.connect();
    });
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.sock?.destroy();
    try { this.udp.close(); } catch { /* already closed */ }
  }

  // ---- AMCP ------------------------------------------------------------------------------------
  private connect(): void {
    if (this.closed) return;
    const s = net.connect({ host: this.cfg.host, port: this.cfg.port });
    this.sock = s;
    s.setNoDelay(true);
    s.setEncoding('utf8');
    s.setTimeout(5000, () => { if (!this.connected) s.destroy(new Error('no answer')); });
    s.on('connect', () => {
      this.connected = true;
      this.error = '';
      this.buf = '';
      this.localAddress = (s.localAddress ?? '127.0.0.1').replace(/^::ffff:/, '');
      s.setKeepAlive(true, 5000);
      void this.hello();
    });
    s.on('data', (d: string) => this.onData(d));
    s.on('error', (e: NodeJS.ErrnoException) => { this.error = e.code === 'ECONNREFUSED' ? 'CasparCG is not running' : e.message; });
    s.on('close', () => {
      const was = this.connected;
      this.connected = false;
      this.osc.clear();
      this.beat.clear();
      for (const p of this.pending.splice(0)) { clearTimeout(p.timer); p.bad(new Error('Disconnected')); }
      if (was) { this.emit('log', 'err', 'Disconnected'); this.emit('disconnected'); }
      if (!this.closed) this.retry = setTimeout(() => this.connect(), 1500);
    });
  }

  private async hello(): Promise<void> {
    try {
      await this.cmd(`OSC SUBSCRIBE ${this.oscPort}`, true);
      this.version = (await this.cmd('VERSION', true)).lines[0] ?? '';
      this.channels = (await this.cmd('INFO', true)).lines.map((l) => l.split(' ')[1] ?? '').filter(Boolean);
      this.emit('log', 'info', `Connected to CasparCG ${this.version}, ${this.channels.length} channels`);
      this.emit('connected');
    } catch (e) {
      this.emit('log', 'err', (e as Error).message);
    }
  }

  private onData(d: string): void {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf('\r\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      this.onLine(line);
    }
  }

  private cur: Pending | null = null;
  private onLine(line: string): void {
    if (this.cur) {
      const p = this.cur;
      if (p.left === 'blank') {
        if (line === '') this.finish(p);
        else p.lines.push(line);
        return;
      }
      p.lines.push(line);
      this.finish(p);
      return;
    }
    const m = /^RES (\S+) (\d{3})(?: (.*))?$/.exec(line);
    if (m) {
      const p = this.pending.find((x) => x.tag === m[1]);
      if (!p) return;
      p.code = Number(m[2]);
      if (p.code === 200) { p.left = 'blank'; this.cur = p; }
      else if (p.code === 201 || p.code === 400) { p.left = 1; this.cur = p; }
      else { p.lines.push(m[3] ?? ''); this.finish(p); }
      return;
    }
  }

  private finish(p: Pending): void {
    this.cur = null;
    clearTimeout(p.timer);
    this.pending = this.pending.filter((x) => x !== p);
    p.ok({ code: p.code, lines: p.lines });
  }

  private write(s: string): void {
    if (!this.sock || !this.connected) throw new Error(`${this.cfg.name} is not connected`);
    this.sock.write(s);
  }

  /** Send one command and wait for its reply. Rejects on a 4xx/5xx answer. */
  async cmd(text: string, quiet = false): Promise<Reply> {
    const clean = text.replace(/[\r\n]+/g, ' ').trim();
    const tag = `v${++this.n}`;
    if (!quiet) this.emit('log', 'out', clean);
    const r = await new Promise<Reply>((ok, bad) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((x) => x !== p);
        if (this.cur === p) this.cur = null;
        bad(new Error(`No answer to ${clean.slice(0, 60)}`));
      }, 8000);
      const p: Pending = { tag, ok, bad, timer, lines: [], left: null, code: 0 };
      this.pending.push(p);
      try { this.write(`REQ ${tag} ${clean}\r\n`); } catch (e) { clearTimeout(timer); this.pending = this.pending.filter((x) => x !== p); bad(e as Error); }
    });
    if (!quiet || r.code >= 400) this.emit('log', r.code >= 400 ? 'err' : 'in', `${r.code} ${r.code === 200 ? `${r.lines.length} lines` : r.lines.join(' ').slice(0, 200)}`);
    if (r.code >= 400) throw new Error(r.code === 404 ? `Not found: ${clean.slice(0, 80)}` : `${clean.slice(0, 80)} → ${r.code}`);
    return r;
  }

  /**
   * Run several commands back to back, in order. They must all belong to one channel: the server runs each channel's
   * commands in sequence on that channel's own queue. BEGIN/COMMIT is avoided on purpose, because batches wait on a
   * queue shared by every client (library refreshes, thumbnails) and can be held up for seconds.
   */
  async series(cmds: string[]): Promise<void> {
    const r = await Promise.allSettled(cmds.map((c) => this.cmd(c)));
    const bad = r.find((x) => x.status === 'rejected');
    if (bad) throw (bad as PromiseRejectedResult).reason as Error;
  }

  // ---- status -----------------------------------------------------------------------------------
  fps(channel: number): number {
    const r = this.osc.get(`/channel/${channel}/framerate`)?.v as number[] | undefined;
    if (r && r.length > 1 && r[1]) return r[0] / r[1];
    const m = /[pi](\d{4})$/.exec(this.channels[channel - 1] ?? '');
    return m ? { 2398: 24000 / 1001, 2997: 30000 / 1001, 5994: 60000 / 1001 }[Number(m[1])] ?? Number(m[1]) / 100 : 50;
  }

  layers(): Map<string, LayerState> {
    const now = Date.now();
    const out = new Map<string, LayerState>();
    for (const [a, r] of this.osc) {
      const m = /^\/channel\/(\d+)\/stage\/layer\/(\d+)\/(foreground|background)\/(.+)$/.exec(a);
      if (!m) continue;
      const beat = this.beat.get(m[1]) ?? 0;
      if (beat - r.t > STALE || now - beat > 4000) {
        if (now - r.t > 8000) this.osc.delete(a);
        continue;
      }
      const key = `${m[1]}-${m[2]}`;
      let l = out.get(key);
      if (!l) out.set(key, (l = emptyLayer()));
      const [v0, v1] = r.v;
      if (m[3] === 'background') {
        if (m[4] === 'file/name') l.next = String(v0);
        continue;
      }
      switch (m[4]) {
        case 'producer': l.producer = String(v0); break;
        case 'file/name': l.name = String(v0); break;
        case 'file/path': if (/\/overlay\?server=/.test(String(v0))) l.overlay = true; break;
        case 'paused': l.paused = !!v0; break;
        case 'loop': l.loop = !!v0; break;
        case 'file/time': l.pos = Number(v0) || 0; if (!l.end) l.end = Number(v1) || 0; break;
        case 'file/clip': if (Number(v1) > 0) { l.start = Number(v0) || 0; l.end = l.start + Number(v1); } break;
      }
    }
    return out;
  }

  audio(): Map<number, number[]> {
    const out = new Map<number, number[]>();
    const now = Date.now();
    for (const [a, r] of this.osc) {
      const m = /^\/channel\/(\d+)\/mixer\/audio\/volume$/.exec(a);
      if (m && now - r.t < 500) out.set(Number(m[1]), r.v.slice(0, 8).map((x) => Math.min(1, Math.abs(Number(x)) / 2147483647)));
    }
    return out;
  }

  // ---- library ------------------------------------------------------------------------------------
  async media(): Promise<MediaEntry[]> {
    return parseCls((await this.cmd('CLS', true)).lines);
  }
  /**
   * The media and template lists straight from the media scanner, for noticing new, renamed and deleted files without
   * loading the server. Null when the scanner cannot be reached.
   */
  async scan(): Promise<{ media: MediaEntry[]; templates: string[] } | null> {
    const base = (this.cfg.scanner || `http://${this.cfg.host}:8000`).replace(/\/+$/, '');
    const get = async (p: string) => { const r = await fetch(base + p, { signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error(String(r.status)); return (await r.text()).split(/\r?\n/); };
    try {
      const [c, t] = await Promise.all([get('/cls'), get('/tls')]);
      if (!/^200 CLS/.test(c[0]) || !/^200 TLS/.test(t[0])) return null;
      return { media: parseCls(c), templates: parseTls(t.slice(1)) };
    } catch { return null; }
  }
  async templates(): Promise<string[]> {
    return parseTls((await this.cmd('TLS', true)).lines);
  }
  async data(): Promise<string[]> {
    return (await this.cmd('DATA LIST', true)).lines.map((l) => l.replace(/^"|"$/g, '')).filter(Boolean);
  }
  private thumbSlots = 4;
  private thumbQueue: (() => void)[] = [];
  /**
   * PNG thumbnail (base64) straight from the media scanner. Not through AMCP: the server answers THUMBNAIL RETRIEVE
   * on a queue shared by every client, which can be seconds long and would hold up other commands.
   */
  async thumbnail(name: string): Promise<string> {
    if (this.thumbSlots > 0) this.thumbSlots--;
    else await new Promise<void>((r) => this.thumbQueue.push(r));
    try {
      const base = (this.cfg.scanner || `http://${this.cfg.host}:8000`).replace(/\/+$/, '');
      const res = await fetch(`${base}/media/thumbnail/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return '';
      return Buffer.from(await res.arrayBuffer()).toString('base64');
    } catch {
      return '';
    } finally {
      const n = this.thumbQueue.shift();
      if (n) n();
      else this.thumbSlots++;
    }
  }
}

function parseCls(lines: string[]): MediaEntry[] {
  return lines.flatMap((l): MediaEntry[] => {
    const m = /^"(.+)"\s+(MOVIE|STILL|AUDIO)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\/(\d+)/.exec(l);
    if (!m) return [];
    const num = Number(m[6]);
    const den = Number(m[7]);
    // CLS reports the time base (seconds per frame), so fps is its inverse.
    const spf = den ? num / den : 0;
    return [{ name: m[1], type: m[2] as MediaEntry['type'], frames: Number(m[5]), fps: spf ? 1 / spf : 0, seconds: Number(m[5]) * spf, size: Number(m[3]), date: m[4] }];
  });
}
function parseTls(lines: string[]): string[] {
  return lines.map((l) => /^"([^"]+)"/.exec(l)?.[1] ?? l.split(/\s+/)[0]).filter(Boolean);
}
