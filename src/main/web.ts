// Web interface: serves the whole client to a browser. Needs the access code from Settings.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

/** One screen: the app's own window, or a browser. */
export interface Client {
  id: string;
  web: boolean;
  /** On this PC. A browser on another device may not touch what could run programs here. */
  local: boolean;
  send: (name: string, ...args: unknown[]) => void;
}
export interface WebHooks {
  call: (who: Client, name: string, args: unknown[]) => Promise<unknown>;
  state: () => unknown;
  media: (token: string, range: string | undefined) => Response;
  /** A browser went away. */
  left: (who: Client) => void;
  log: (kind: 'info' | 'err', text: string) => void;
}
export interface WebCfg { enabled: boolean; port: number; lan: boolean; code: string }

const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self'; connect-src 'self'; manifest-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.json': 'application/manifest+json' };
const FILES: Record<string, string> = {
  '/': 'static/web/index.html', '/settings': 'static/web/settings.html', '/web.css': 'static/web/web.css', '/web.js': 'dist/web/web.js', '/ui/app.js': 'dist/ui/app.js', '/ui/settings.js': 'dist/ui/settings.js',
  '/css/tokens.css': 'static/css/tokens.css', '/css/shell.css': 'static/css/shell.css', '/css/settings.css': 'static/css/settings.css', '/css/app.css': 'static/css/app.css', '/css/window.css': 'static/css/window.css',
  '/icon.png': 'static/icon.png', '/manifest.json': 'static/web/manifest.json',
};
const MAX_BODY = 20e6;

/** This PC's addresses that another device could use. */
export function addresses(): string[] {
  return Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')).map((a) => a!.address);
}

export class Web {
  private srv: http.Server;
  private token: string;
  private clients = new Map<string, { who: Client; res: http.ServerResponse }>();
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
    this.timer = setInterval(() => this.tick(), 100);
  }
  close(): void {
    clearInterval(this.timer);
    for (const c of this.clients.values()) c.res.end();
    this.srv.close();
    this.srv.closeAllConnections?.();
  }
  /** Tell every browser, except the one it came from. */
  send(name: string, args: unknown[], except = ''): void {
    if (!this.clients.size) return;
    const text = `event: vt\ndata: ${JSON.stringify([name, ...args])}\n\n`;
    for (const [id, c] of this.clients) if (id !== except) c.res.write(text);
  }
  private tick(): void {
    if (!this.clients.size) { this.last = ''; return; }
    const s = JSON.stringify(this.h.state());
    if (s === this.last) return;
    this.last = s;
    // A slow connection skips some rather than falling ever further behind.
    for (const c of this.clients.values()) if (c.res.writableLength < 400000) c.res.write(`event: vt\ndata: ["state",${s}]\n\n`);
  }

  private async body(req: http.IncomingMessage, max: number): Promise<Record<string, unknown>> {
    const parts: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      n += (c as Buffer).length;
      if (n > max) throw new Error('Too long');
      parts.push(c as Buffer);
    }
    const j = JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
    if (!j || typeof j !== 'object') throw new Error('Not an object');
    return j as Record<string, unknown>;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const head = (type: string, cache = 'no-store'): http.OutgoingHttpHeaders => ({ 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, 'Cache-Control': cache });
    const say = (code: number, text: string, type = 'text/plain; charset=utf-8', extra: http.OutgoingHttpHeaders = {}) => {
      res.writeHead(code, { ...head(type), ...extra });
      res.end(text);
    };
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (req.method === 'GET' && Object.hasOwn(FILES, p)) {
      const f = path.join(this.root, FILES[p]);
      if (!fs.existsSync(f)) return say(404, 'Not found');
      res.writeHead(200, head(TYPES[path.extname(f)], 'no-cache'));
      res.end(fs.readFileSync(f));
      return;
    }
    if (req.method === 'POST') {
      // Only this page may post here: another site can neither send JSON with this header nor match the origin.
      const origin = req.headers.origin;
      if (req.headers['x-vt'] !== '1' || !(req.headers['content-type'] ?? '').startsWith('application/json') || (origin && origin !== `http://${req.headers.host}`)) return say(403, 'Refused');
    }
    const from = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (req.method === 'POST' && p === '/login') {
      const now = Date.now();
      this.wrongAll = this.wrongAll.filter((t) => now - t < 600000);
      const w = this.wrong.get(from);
      if ((w && w.n >= 5 && now - w.t < 60000) || this.wrongAll.length >= 40) return say(429, 'Too many tries. Wait a minute.');
      const b = await this.body(req, 2000);
      const a = crypto.createHash('sha256').update(String(b.code ?? '')).digest();
      const want = crypto.createHash('sha256').update(this.cfg.code).digest();
      if (!this.cfg.code || !crypto.timingSafeEqual(a, want)) {
        this.wrong.set(from, { n: w && now - w.t < 60000 ? w.n + 1 : 1, t: now });
        this.wrongAll.push(now);
        this.h.log('err', `Web: wrong access code from ${from}`);
        return say(401, 'Wrong code');
      }
      this.wrong.delete(from);
      this.h.log('info', `Web: ${from} signed in`);
      return say(200, 'ok', undefined, { 'Set-Cookie': `vt=${this.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
    }
    const token = /(?:^|;\s*)vt=([0-9a-f]{48})/.exec(req.headers.cookie ?? '')?.[1];
    if (!token || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.token))) return say(401, 'Sign in first');

    const local = from === '127.0.0.1' || from === '::1';
    if (req.method === 'GET' && p === '/me') return say(200, JSON.stringify({ local }), 'application/json');
    if (req.method === 'GET' && p === '/events') {
      const id = url.searchParams.get('c') ?? '';
      if (!/^[a-z0-9]{8,32}$/.test(id)) return say(400, 'Bad request');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
      const who: Client = { id, web: true, local, send: (name, ...args) => { res.write(`event: vt\ndata: ${JSON.stringify([name, ...args])}\n\n`); } };
      this.clients.get(id)?.res.end();
      this.clients.set(id, { who, res });
      const beat = setInterval(() => res.write(': \n\n'), 10000);
      res.on('close', () => { clearInterval(beat); if (this.clients.get(id)?.res === res) { this.clients.delete(id); this.h.left(who); } });
      who.send('hello');
      who.send('state', this.h.state());
      return;
    }
    if (req.method === 'POST' && p === '/call') {
      const b = await this.body(req, MAX_BODY);
      const id = String(b.client ?? '');
      if (!/^[a-z0-9]{8,32}$/.test(id) || typeof b.name !== 'string' || !Array.isArray(b.args)) return say(400, 'Bad request');
      const who: Client = { id, web: true, local, send: this.clients.get(id)?.who.send ?? (() => undefined) };
      return say(200, JSON.stringify(await this.h.call(who, b.name, b.args as unknown[])), 'application/json');
    }
    if (req.method === 'GET' && p.startsWith('/media/')) {
      const r = this.h.media(p.slice(7), req.headers.range);
      const hd: http.OutgoingHttpHeaders = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
      r.headers.forEach((v, k) => { hd[k] = v; });
      res.writeHead(r.status, hd);
      if (!r.body) { res.end(); return; }
      const s = Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]);
      s.on('error', () => res.destroy());
      res.on('close', () => s.destroy());
      s.pipe(res);
      return;
    }
    return say(404, 'Not found');
  }
}
