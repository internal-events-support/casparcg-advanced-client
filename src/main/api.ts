// Remote control: local HTTP API and OSC control (same paths as the original client).
import dgram from 'node:dgram';
import http from 'node:http';
import type { Action, Loc } from '../shared/types';
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
  overlay: (ref: string, verb: string) => Promise<string | null>;
  status: () => unknown;
  log: (kind: 'info' | 'err', text: string) => void;
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
      if (p[0] === 'overlay' && p.length === 3 && ['show', 'hide', 'toggle'].includes(p[2])) return h.overlay(p[1], p[2]);
      return null;
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
