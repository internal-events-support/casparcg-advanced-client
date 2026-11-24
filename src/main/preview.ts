// Local clip preview. Opens the media file itself, so it needs no channel (and no server).
// Clips this app cannot play directly (ProRes, DNxHD, MKV …) get a small preview copy made with ffmpeg, kept in a cache.
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

export interface PreviewInfo { url: string; kind: 'video' | 'image' | 'audio'; fps: number; duration: number; width: number; height: number; codec: string; alpha: boolean; proxy: boolean }
interface Probe { codec: string; pix: string; width: number; height: number; fps: number; duration: number; audio: string; hasVideo: boolean }

const VIDEO = ['.mp4', '.mov', '.mkv', '.mxf', '.avi', '.webm', '.m4v', '.mpg', '.mpeg', '.ts', '.wmv', '.flv', '.gif', '.m2ts', '.mts', '.vob', '.dv'];
const IMAGE = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tga', '.tif', '.tiff'];
const AUDIO = ['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma'];
const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg' };
const CACHE_MAX = 2e9;

export class Preview {
  private files = new Map<string, string>();
  private child: ChildProcess | null = null;
  private job = 0;

  constructor(private cache: string, private ffmpeg: () => string, private progress: (p: number) => void) {
    fs.mkdirSync(cache, { recursive: true });
    // Unfinished copies from a crash.
    for (const f of fs.readdirSync(cache)) if (f.endsWith('.part.mp4')) fs.rmSync(path.join(cache, f), { force: true });
  }

  cancel(): void {
    this.job++;
    this.child?.kill();
    this.child = null;
  }

  /** Find a media name ("FOLDER/CLIP", no extension, any case) below a folder. */
  private find(folder: string, name: string): string {
    if (!folder) throw new Error('Set the media folder for this server in Settings to preview its clips');
    if (!fs.existsSync(folder)) throw new Error(`The media folder cannot be reached: ${folder}`);
    const parts = name.replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length || parts.some((p) => p === '..' || p === '.') || /^[a-z]:/i.test(name)) throw new Error('That is not a clip in the media folder');
    let dir = folder;
    for (const p of parts.slice(0, -1)) {
      const hit = fs.readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.toLowerCase() === p.toLowerCase());
      if (!hit) throw new Error(`${name} is not in the media folder`);
      dir = path.join(dir, hit.name);
    }
    const want = parts.at(-1)!.toLowerCase();
    const all = [...VIDEO, ...IMAGE, ...AUDIO];
    const files = fs.readdirSync(dir).filter((f) => all.includes(path.extname(f).toLowerCase()) && (f.toLowerCase() === want || path.basename(f, path.extname(f)).toLowerCase() === want));
    files.sort((a, b) => all.indexOf(path.extname(a).toLowerCase()) - all.indexOf(path.extname(b).toLowerCase()));
    if (!files.length) throw new Error(`${name} is not in the media folder`);
    return path.join(dir, files[0]);
  }

  private run(exe: string, args: string[], onErr?: (s: string) => void, track = false): Promise<string> {
    return new Promise((ok, bad) => {
      const c = spawn(exe, args, { windowsHide: true });
      if (track) {
        this.child = c;
        // A server on this PC comes first: never let making a preview copy disturb what is on air.
        try { if (c.pid) os.setPriority(c.pid, os.constants.priority.PRIORITY_LOW); } catch { /* it may have finished already */ }
      }
      let out = '';
      let err = '';
      c.stdout.on('data', (d: Buffer) => (out += d));
      c.stderr.on('data', (d: Buffer) => { err = (err + d).slice(-4000); onErr?.(String(d)); });
      c.on('error', () => bad(new Error('ffmpeg was not found. Set it in Settings to preview this clip')));
      c.on('close', (code) => {
        if (this.child === c) this.child = null;
        if (code === 0) ok(out);
        else bad(new Error(err.trim().split('\n').pop() || 'The clip could not be read'));
      });
    });
  }

  private async probe(file: string): Promise<Probe> {
    const ff = this.ffmpeg();
    const exe = ff.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    const j = JSON.parse(await this.run(exe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file])) as { streams: Record<string, string | number>[]; format: Record<string, string> };
    const v = j.streams.find((s) => s.codec_type === 'video' && s.codec_name !== 'mjpeg') ?? j.streams.find((s) => s.codec_type === 'video');
    const a = j.streams.find((s) => s.codec_type === 'audio');
    const [n, d] = String(v?.avg_frame_rate ?? '0/1').split('/').map(Number);
    return { codec: String(v?.codec_name ?? a?.codec_name ?? ''), pix: String(v?.pix_fmt ?? ''), width: Number(v?.width) || 0, height: Number(v?.height) || 0, fps: d ? n / d : 0, duration: Number(j.format.duration) || 0, audio: String(a?.codec_name ?? ''), hasVideo: !!v };
  }

  async open(folder: string, name: string): Promise<PreviewInfo> {
    this.cancel();
    const job = this.job;
    const file = this.find(folder, name);
    const ext = path.extname(file).toLowerCase();
    const p = await this.probe(file);
    if (job !== this.job) throw new Error('');
    const alpha = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya)/.test(p.pix);
    const base = { fps: p.fps, duration: p.duration, width: p.width, height: p.height, codec: p.codec, alpha };
    if (IMAGE.includes(ext)) {
      if (MIME[ext]) return { ...base, url: this.share(file), kind: 'image', duration: 0, proxy: false };
      return { ...base, url: this.share(await this.proxy(file, p, 'image', alpha, job)), kind: 'image', duration: 0, proxy: true };
    }
    if (!p.hasVideo || AUDIO.includes(ext)) {
      if (MIME[ext]) return { ...base, url: this.share(file), kind: 'audio', proxy: false };
      return { ...base, url: this.share(await this.proxy(file, p, 'audio', false, job)), kind: 'audio', proxy: true };
    }
    const direct = ['.mp4', '.m4v', '.webm'].includes(ext) && ['h264', 'vp8', 'vp9', 'av1'].includes(p.codec) && ['yuv420p', 'yuvj420p'].includes(p.pix) && ['', 'aac', 'mp3', 'opus', 'vorbis'].includes(p.audio);
    return { ...base, url: this.share(direct ? file : await this.proxy(file, p, 'video', alpha, job)), kind: 'video', proxy: !direct };
  }

  private async proxy(file: string, p: Probe, kind: 'video' | 'image' | 'audio', alpha: boolean, job: number): Promise<string> {
    const st = fs.statSync(file);
    const id = crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}|2`).digest('hex').slice(0, 24);
    const out = path.join(this.cache, id + (kind === 'image' ? '.png' : '.mp4'));
    if (fs.existsSync(out)) {
      fs.utimesSync(out, new Date(), new Date());
      return out;
    }
    const part = path.join(this.cache, `${id}.part${kind === 'image' ? '.png' : '.mp4'}`);
    const rate = p.fps > 0 && p.fps <= 60 ? p.fps : 25;
    // Transparent clips are shown over a dark grey so light and dark graphics both read.
    const video = alpha
      ? ['-filter_complex', `[0:v]scale=640:-2[v];color=0x3a3a3a:s=${640}x${Math.max(2, Math.round((640 * (p.height || 360)) / (p.width || 640) / 2) * 2)}:r=${rate}[b];[b][v]overlay=shortest=1,format=yuv420p[o]`, '-map', '[o]', '-map', '0:a:0?']
      : ['-vf', 'scale=640:-2,format=yuv420p', '-map', '0:v:0', '-map', '0:a:0?'];
    const args = kind === 'image' ? ['-frames:v', '1'] : kind === 'audio' ? ['-vn', '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart'] : [...video, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-g', String(Math.max(1, Math.round(rate / 4))), '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart'];
    this.progress(0);
    try {
      await this.run(this.ffmpeg(), ['-v', 'error', '-nostdin', '-y', '-progress', 'pipe:2', '-i', file, ...args, part], (s) => {
        const m = /out_time_us=(\d+)/.exec(s);
        if (m && p.duration && job === this.job) this.progress(Math.min(0.99, Number(m[1]) / 1e6 / p.duration));
      }, true);
      if (job !== this.job) throw new Error('');
      fs.renameSync(part, out);
    } catch (e) {
      fs.rmSync(part, { force: true });
      throw job === this.job ? e : new Error('');
    } finally {
      if (job === this.job) this.progress(-1);
    }
    this.trim();
    return out;
  }

  /** Drop the least recently used copies when the cache gets big. */
  private trim(): void {
    const fs_ = fs.readdirSync(this.cache).map((f) => { const s = fs.statSync(path.join(this.cache, f)); return { f, size: s.size, t: s.mtimeMs }; }).sort((a, b) => b.t - a.t);
    let sum = 0;
    for (const x of fs_) {
      sum += x.size;
      if (sum > CACHE_MAX) fs.rmSync(path.join(this.cache, x.f), { force: true });
    }
  }

  private share(file: string): string {
    const token = crypto.randomBytes(12).toString('hex');
    this.files.set(token, file);
    if (this.files.size > 50) this.files.delete(this.files.keys().next().value!);
    return `vtmedia://clip/${token}`;
  }

  /** vtmedia:// handler with byte ranges (needed for scrubbing). Only files handed out by open() can be read. */
  serve(req: Request): Response {
    const file = this.files.get(new URL(req.url).pathname.slice(1));
    if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    const size = fs.statSync(file).size;
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '');
    let a = 0;
    let b = size - 1;
    if (m) {
      a = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      b = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (a > b) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const stream = fs.createReadStream(file, { start: a, end: b });
    stream.on('error', () => stream.destroy());
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: m ? 206 : 200,
      headers: { 'Content-Type': type, 'Content-Length': String(b - a + 1), 'Accept-Ranges': 'bytes', ...(m ? { 'Content-Range': `bytes ${a}-${b}/${size}` } : {}) },
    });
  }
}
