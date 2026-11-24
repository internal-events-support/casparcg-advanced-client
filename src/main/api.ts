// Remote control: local HTTP API, OSC control (same paths as the original client) and the countdown feed for monitor overlays.
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import type { Action, LayerState, Loc } from '../shared/types';
import type { TakeOpts } from './engine';
import { decode } from './osc';

export interface ApiHooks {
  /** "1-10" on the first server, or "Server name:1-10". */
  loc: (ref: string) => Loc | null;
  transport: (t: Loc, verb: string) => Promise<string>;
  take: (from: Loc, to: Loc, o: TakeOpts) => Promise<string>;
  remoteItem: (rid: string, a: Action) => Promise<string>;
  rundown: (verb: string) => void;
  playlist: (ref: string, verb: string, n?: number) => Promise<string>;
  legacy: (path: string[]) => Promise<string | null>;
  status: () => unknown;
  countdown: (channel: number) => { layer: LayerState; next: string };
  log: (kind: 'info' | 'err', text: string) => void;
}
export interface LegacyConfig {
  pgm_channel: number;
  pvw_channel: number;
  layer: number;
  fade_frames: number;
  clips: string[];
  playlists: Record<string, { loop: boolean; clips: string[] }>;
  lt: { file: string; title: string }[];
  rq: { file: string; title: string }[];
  gfx_channel: number;
}

export const CONTROL: Record<string, Action> = {
  stop: 'stop', play: 'play', playnow: 'playNow', load: 'load', pause: 'pause', next: 'next', previous: 'prev', prev: 'prev', back: 'back', forward: 'forward', update: 'update',
  invoke: 'invoke', preview: 'preview', clear: 'clear', clearvideolayer: 'clearLayer', clearchannel: 'clearChannel',
};
const VERBS = ['play', 'pause', 'toggle', 'stop', 'back', 'forward', 'next', 'prev', 'start'];
const TAKES = ['cut', 'cutplay', 'fade', 'fadeplay'];
/** "fadeplay", optionally with a length in frames. */
export const takeOpts = (verb: string, frames?: string): TakeOpts => ({ fade: verb.startsWith('fade'), roll: verb.endsWith('play'), hold: true, frames: Math.min(500, Math.max(1, Number(frames) || 25)) });
const portError = (port: number) => (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' ? `Port ${port} is already in use` : e.message);

export function startHttp(port: number, h: ApiHooks, done: (state: string) => void): http.Server {
  const srv = http.createServer((req, res) => {
    const say = (code: number, text: string, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(text);
    };
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const site = req.headers['sec-fetch-site'] as string | undefined;
    // These URLs do things, so refuse anything a web page in a browser could trigger.
    if (!['127.0.0.1', 'localhost'].includes(host) || req.headers.origin || !['none', 'same-origin', undefined].includes(site)) return say(403, 'Refused');
    let p: string[];
    try {
      p = decodeURIComponent((req.url ?? '/').split('?')[0]).toLowerCase().split('/').filter(Boolean);
    } catch {
      return say(404, 'Unknown command');
    }
    const run = async (): Promise<string | null> => {
      if (p[0] === 'status') return JSON.stringify(h.status());
      if (p[0] === 'layer' && p.length === 3 && VERBS.includes(p[2])) { const t = h.loc(p[1]); return t ? h.transport(t, p[2]) : null; }
      if (p[0] === 'take' && p.length >= 4 && TAKES.includes(p[3])) { const a = h.loc(p[1]); const b = h.loc(p[2]); return a && b ? h.take(a, b, takeOpts(p[3], p[4])) : null; }
      if (p[0] === 'item' && p.length === 3 && CONTROL[p[2]]) return h.remoteItem(p[1], CONTROL[p[2]]);
      if (p[0] === 'playlist' && p.length >= 3) return h.playlist(p[1], p[2], p[3] ? Number(p[3]) : undefined);
      return h.legacy(p);
    };
    run().then(
      (r) => (r === null ? say(404, 'Unknown command') : say(200, r, p[0] === 'status' ? 'application/json' : undefined)),
      (e: Error) => {
        h.log('err', e.message);
        say(200, `Not done: ${e.message}`); // 200, so a refused press does not mark the caller's connection as broken
      },
    );
  });
  srv.on('error', (e: NodeJS.ErrnoException) => done(portError(port)(e)));
  srv.listen(port, '127.0.0.1', () => done(''));
  return srv;
}

export function startOsc(port: number, h: ApiHooks, done: (state: string) => void): dgram.Socket {
  const s = dgram.createSocket('udp4');
  const fail = (e: Error) => h.log('err', e.message);
  s.on('error', (e: NodeJS.ErrnoException) => done(portError(port)(e)));
  s.on('message', (b) => {
    try {
      decode(b, (a, args) => {
        // Like the original: an argument of 0 or false (a button release) does nothing.
        if (!args.length || !Number(args[0])) return;
        const p = a.split('/').filter(Boolean);
        if (p[0] !== 'control') return;
        if (p.length === 2) h.rundown(p[1]);
        else if (p[1] === 'take' && TAKES.includes(p[4])) { const x = h.loc(p[2]); const y = h.loc(p[3]); if (x && y) void h.take(x, y, takeOpts(p[4])).catch(fail); }
        else if (p[1] === 'layer' && VERBS.includes(p[3])) { const x = h.loc(p[2]); if (x) void h.transport(x, p[3]).catch(fail); }
        else if (CONTROL[p[2]]) void h.remoteItem(p[1], CONTROL[p[2]]).catch(fail);
      });
    } catch {
      /* ignore malformed packets */
    }
  });
  s.bind(port, '127.0.0.1', () => done(''));
  return s;
}

const clock = (n: number) => {
  const s = Math.max(0, Math.floor(n));
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
};

/** Same feed as the earlier countdown helper, so the existing monitor overlays work unchanged. */
export function startCountdown(cfg: { port: number; caution: number; warn: number; flash: number }, h: ApiHooks, done: (state: string) => void): http.Server {
  const view = (ch: number) => {
    const { layer: l, next } = h.countdown(ch);
    const out = { status: 'idle', level: 'normal', left: '', elapsed: '', total: '', pct: 0, name: l.name.replace(/\\/g, '/').split('/').pop() ?? '', next };
    if (l.producer === 'empty') return { ...out, name: '' };
    if (!l.end) return { ...out, status: 'nolength' };
    const left = Math.max(0, l.end - l.pos);
    const gone = Math.max(0, l.pos - l.start);
    const total = l.end - l.start;
    out.status = left <= 0.04 && !l.loop ? 'end' : l.paused ? (gone < 0.1 ? 'cued' : 'pause') : l.loop ? 'loop' : 'play';
    if (!l.loop) out.level = left <= cfg.warn ? 'warn' : left <= cfg.caution ? 'caution' : 'normal';
    if (out.status === 'play' && left <= cfg.flash) out.level = 'flash';
    const shown = Math.max(0, Math.ceil(left - 0.02));
    const all = Math.ceil(total - 0.02);
    return { ...out, left: clock(shown), total: clock(all), elapsed: clock(all - shown), pct: Math.round(Math.min(100, (gone / total) * 100) * 10) / 10 };
  };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const ch = Number(u.searchParams.get('ch'));
    if (u.pathname !== '/events' || !(ch > 0)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': 'null' });
    let last = '';
    let sent = 0;
    const t = setInterval(() => {
      const s = JSON.stringify(view(ch));
      if (s === last && Date.now() - sent <= 1000) return;
      res.write(`data: ${s}\n\n`);
      last = s;
      sent = Date.now();
    }, 50);
    req.on('close', () => clearInterval(t));
  });
  srv.on('error', (e: NodeJS.ErrnoException) => done(portError(cfg.port)(e)));
  srv.listen(cfg.port, '127.0.0.1', () => done(''));
  return srv;
}

export function readLegacy(file: string): LegacyConfig | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as LegacyConfig;
  } catch {
    return null;
  }
}
