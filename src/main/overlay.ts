// Playback overlay: a page with the time left on a channel's clips, which CasparCG shows on a channel as graphics.
import fs from 'node:fs';
import http from 'node:http';
import type { LayerState, Overlay } from '../shared/types';

export interface OverlayView {
  cfg: { title: string; small: string } & Pick<Overlay, 'position' | 'size' | 'margin' | 'next' | 'idle'>;
  main: { n: number; l: LayerState };
  others: { n: number; l: LayerState }[];
}
export interface Thresholds { caution: number; warn: number; flash: number }

const clock = (n: number) => {
  const s = Math.max(0, Math.floor(n));
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
};
const short = (n: string) => n.replace(/\\/g, '/').split('/').pop() ?? '';

function one(l: LayerState, at: number, t: Thresholds) {
  const out = { layer: at, status: 'idle', level: 'normal', left: '', elapsed: '', total: '', pct: 0, name: short(l.name), next: l.next ? short(l.next) : '' };
  if (l.producer === 'empty') return { ...out, name: '' };
  if (!l.end) return { ...out, status: 'nolength' };
  const left = Math.max(0, l.end - l.pos);
  const gone = Math.max(0, l.pos - l.start);
  const total = l.end - l.start;
  out.status = left <= 0.04 && !l.loop ? 'end' : l.paused ? (gone < 0.1 ? 'cued' : 'pause') : l.loop ? 'loop' : 'play';
  if (!l.loop) out.level = left <= t.warn ? 'warn' : left <= t.caution ? 'caution' : 'normal';
  if (out.status === 'play' && left <= t.flash) out.level = 'flash';
  const shown = Math.max(0, Math.ceil(left - 0.02));
  const all = Math.ceil(total - 0.02);
  return { ...out, left: clock(shown), total: clock(all), elapsed: clock(all - shown), pct: Math.round(Math.min(100, (gone / total) * 100) * 10) / 10 };
}
/**
 * The clip to show large. The layer that is set, when it has a clip; otherwise the lowest one still running, and then
 * the lowest of those that have ended. `clips` are the layers with a length.
 */
export function pickMain(clips: { n: number; l: LayerState }[], layer: number, ended: (l: LayerState) => boolean): { n: number; l: LayerState } | undefined {
  const inOrder = [...clips].sort((x, y) => Number(ended(x.l)) - Number(ended(y.l)) || x.n - y.n);
  return inOrder.find((x) => x.n === layer) ?? inOrder[0];
}

/** Serves the page and what it shows. Only times and clip names, and nothing can be changed here. */
export function startOverlay(port: number, host: string, page: string, t: () => Thresholds, view: (server: string, channel: number) => OverlayView | null, done: (state: string) => void): http.Server {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const server = u.searchParams.get('server') ?? '';
    const ch = Number(u.searchParams.get('ch'));
    const no = () => { res.writeHead(404); res.end(); };
    if (req.method !== 'GET') return no();
    if (u.pathname === '/overlay') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(fs.readFileSync(page));
      return;
    }
    if (u.pathname !== '/events' || !view(server, ch)) return no();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    let last = '';
    let sent = 0;
    const timer = setInterval(() => {
      const v = view(server, ch);
      if (!v) { res.end(); return; }
      const s = JSON.stringify({ cfg: v.cfg, ...one(v.main.l, v.main.n, t()), others: v.others.map((x) => one(x.l, x.n, t())) });
      if (s === last && Date.now() - sent <= 1000) return;
      res.write(`data: ${s}\n\n`);
      last = s;
      sent = Date.now();
    }, 50);
    res.on('close', () => clearInterval(timer));
  });
  srv.on('error', (e: NodeJS.ErrnoException) => done(e.code === 'EADDRINUSE' ? `Port ${port} is already in use` : e.message));
  srv.listen(port, host, () => done(''));
  return srv;
}
