// Web interface: a control page for a phone, tablet or another computer. Needs the access code from Settings.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Action, Loc } from '../shared/types';
import type { TakeOpts } from './engine';

export interface WebHooks {
  docs: () => unknown;
  state: () => unknown;
  execute: (id: string, a: Action) => Promise<string>;
  transport: (t: Loc, verb: string) => Promise<string>;
  take: (from: Loc, to: Loc, o: TakeOpts) => Promise<string>;
  log: (kind: 'info' | 'err', text: string) => void;
}
export interface WebCfg { enabled: boolean; port: number; lan: boolean; code: string }

const ACTIONS: Action[] = ['stop', 'play', 'playNow', 'load', 'pause', 'next', 'prev', 'back', 'forward', 'update', 'invoke', 'clear', 'clearLayer'];
const VERBS = ['play', 'pause', 'toggle', 'stop', 'back', 'forward', 'next', 'prev', 'start'];
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** This PC's addresses that another device could use. */
export function addresses(): string[] {
  return Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')).map((a) => a!.address);
}

export class Web {
  private srv: http.Server;
  private token: string;
  private clients = new Set<http.ServerResponse>();
  private wrong = new Map<string, { n: number; t: number }>();
  private wrongAll: number[] = [];
  private timer: NodeJS.Timeout;
  private last = '';

  constructor(private cfg: WebCfg, key: string, private root: string, private h: WebHooks, done: (state: string) => void) {
    // Stays valid across restarts; a new access code signs everyone out.
    this.token = crypto.createHmac('sha256', key).update(cfg.code).digest('hex').slice(0, 48);
    this.srv = http.createServer((q, r) => void this.handle(q, r).catch((e: Error) => { if (!r.headersSent) r.writeHead(500); r.end(); h.log('err', `Web: ${e.message}`); }));
    this.srv.on('error', (e: NodeJS.ErrnoException) => done(e.code === 'EADDRINUSE' ? `Port ${cfg.port} is already in use` : e.message));
    this.srv.listen(cfg.port, cfg.lan ? '0.0.0.0' : '127.0.0.1', () => done(''));
    this.timer = setInterval(() => this.tick(), 200);
  }
  close(): void {
    clearInterval(this.timer);
    for (const c of this.clients) c.end();
    this.srv.close();
    this.srv.closeAllConnections?.();
  }
  /** The rundowns or the media list changed. */
  docs(): void {
    if (this.clients.size) this.send('docs', JSON.stringify(this.h.docs()));
  }
  private tick(): void {
    if (!this.clients.size) { this.last = ''; return; }
    const s = JSON.stringify(this.h.state());
    if (s === this.last) return;
    this.last = s;
    this.send('state', s);
  }
  private send(ev: string, data: string, to: Iterable<http.ServerResponse> = this.clients): void {
    for (const c of to) c.write(`event: ${ev}\ndata: ${data}\n\n`);
  }

  private async body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    let s = '';
    for await (const c of req) {
      s += c;
      if (s.length > 20000) throw new Error('Too long');
    }
    const j = JSON.parse(s) as unknown;
    if (!j || typeof j !== 'object') throw new Error('Not an object');
    return j as Record<string, unknown>;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const say = (code: number, text: string, type = 'text/plain; charset=utf-8', extra: http.OutgoingHttpHeaders = {}) => {
      res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store', ...extra });
      res.end(text);
    };
    const p = (req.url ?? '/').split('?')[0];
    const FILES: Record<string, [string, string]> = { '/': ['static/web/index.html', 'text/html; charset=utf-8'], '/web.css': ['static/web/web.css', 'text/css; charset=utf-8'], '/web.js': ['dist/web/web.js', 'text/javascript; charset=utf-8'], '/icon.png': ['static/icon.png', 'image/png'], '/manifest.json': ['static/web/manifest.json', 'application/manifest+json'] };
    if (req.method === 'GET' && FILES[p]) {
      const f = path.join(this.root, FILES[p][0]);
      if (!fs.existsSync(f)) return say(404, 'Not found');
      res.writeHead(200, { 'Content-Type': FILES[p][1], 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(f));
      return;
    }
    if (req.method === 'POST') {
      // Only this page may post here: another site can neither send JSON with this header nor match the origin.
      const origin = req.headers.origin;
      if (req.headers['x-vt'] !== '1' || !(req.headers['content-type'] ?? '').startsWith('application/json') || (origin && origin !== `http://${req.headers.host}`)) return say(403, 'Refused');
    }
    const who = req.socket.remoteAddress ?? '';
    if (req.method === 'POST' && p === '/login') {
      const now = Date.now();
      this.wrongAll = this.wrongAll.filter((t) => now - t < 600000);
      const w = this.wrong.get(who);
      if ((w && w.n >= 5 && now - w.t < 60000) || this.wrongAll.length >= 40) return say(429, 'Too many tries. Wait a minute.');
      const b = await this.body(req);
      const a = crypto.createHash('sha256').update(String(b.code ?? '')).digest();
      const want = crypto.createHash('sha256').update(this.cfg.code).digest();
      if (!this.cfg.code || !crypto.timingSafeEqual(a, want)) {
        this.wrong.set(who, { n: w && now - w.t < 60000 ? w.n + 1 : 1, t: now });
        this.wrongAll.push(now);
        this.h.log('err', `Web: wrong access code from ${who}`);
        return say(401, 'Wrong code');
      }
      this.wrong.delete(who);
      this.h.log('info', `Web: ${who} signed in`);
      return say(200, 'ok', undefined, { 'Set-Cookie': `vt=${this.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
    }
    const token = /(?:^|;\s*)vt=([0-9a-f]{48})/.exec(req.headers.cookie ?? '')?.[1];
    if (!token || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.token))) return say(401, 'Sign in first');

    if (req.method === 'GET' && p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
      this.clients.add(res);
      const beat = setInterval(() => res.write(': \n\n'), 10000);
      res.on('close', () => { this.clients.delete(res); clearInterval(beat); });
      this.send('docs', JSON.stringify(this.h.docs()), [res]);
      this.send('state', JSON.stringify(this.h.state()), [res]);
      return;
    }
    if (req.method === 'POST' && p === '/do') {
      const b = await this.body(req);
      try {
        let r = '';
        if (b.kind === 'item' && typeof b.id === 'string' && ACTIONS.includes(b.action as Action)) r = await this.h.execute(b.id, b.action as Action);
        else if (b.kind === 'transport' && loc(b.at) && VERBS.includes(String(b.verb))) r = await this.h.transport(loc(b.at)!, String(b.verb));
        else if (b.kind === 'take' && loc(b.from) && loc(b.to)) r = await this.h.take(loc(b.from)!, loc(b.to)!, { fade: !!b.fade, roll: !!b.roll, hold: true, frames: Math.min(500, Math.max(1, Number(b.frames) || 25)) });
        else return say(400, 'Unknown command');
        return say(200, JSON.stringify({ ok: true, text: r }), 'application/json');
      } catch (e) {
        return say(200, JSON.stringify({ ok: false, text: (e as Error).message }), 'application/json');
      }
    }
    return say(404, 'Not found');
  }
}

function loc(v: unknown): Loc | null {
  const x = v as Loc | null;
  return x && typeof x.device === 'string' && Number.isInteger(x.channel) && x.channel > 0 && x.channel < 1000 && Number.isInteger(x.layer) && x.layer >= 0 && x.layer < 100000 ? { device: x.device, channel: x.channel, layer: x.layer } : null;
}
