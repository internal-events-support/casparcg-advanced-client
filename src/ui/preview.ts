// Clip preview: plays the file on this PC. Nothing here touches the server's channels.
import type { Item } from '../shared/types';
import { h, icon, iconButton } from './kit';
import { doc, edit, emit, homeDevice, on, selected, store, toast, vt } from './store';

interface Info { url: string; kind: 'video' | 'image' | 'audio'; fps: number; duration: number; width: number; height: number; codec: string; alpha: boolean; proxy: boolean }

let show: ((device: string, name: string, item?: Item) => void) | null = null;
let toggle_: (() => void) | null = null;
/** Open a clip in the preview (paused on its first frame). */
export const previewClip = (device: string, name: string, item?: Item) => show?.(device, name, item);
export const previewToggle = () => toggle_?.();

export function buildPreview(): HTMLElement {
  const video = h('video.pv-video', { playsInline: true, preload: 'auto' }) as HTMLVideoElement;
  const img = h('img.pv-video', { alt: '' }) as HTMLImageElement;
  const msg = h('div.well-msg', 'Select a clip');
  const bar = h('i');
  const prog = h('div.pv-prog', bar);
  const well = h('div.well.pv-well', video, img, msg, prog);
  const name = h('span.pv-name', '');
  const info = h('span.caption', '');
  const tc = h('span.pv-tc', '--:--:--:--');
  const dur = h('span.pv-dur', '');
  const range = h('span.pv-range');
  const scrub = h('input.mon-scrub', { type: 'range', min: '0', max: '1000', value: '0', title: 'Scrub' }) as HTMLInputElement;
  const play = iconButton('play', () => toggle(), 'Play / pause (Space)', 'mon-play');
  const loop = iconButton('loop', () => { video.loop = !video.loop; loop.classList.toggle('active', video.loop); }, 'Loop', 'plain');
  const mute = iconButton('speaker', () => { video.muted = !video.muted; try { localStorage.setItem('vt.previewMuted', String(video.muted)); } catch { /* not kept */ } paintMute(); }, 'Preview sound', 'plain');
  const markIn = h('button.btn.sm', { title: 'Start the clip here' }, 'Set in') as HTMLButtonElement;
  const markOut = h('button.btn.sm', { title: 'End the clip here' }, 'Set out') as HTMLButtonElement;
  const clear = h('button.btn.sm', { title: 'Play the whole clip' }, 'Clear') as HTMLButtonElement;
  const marks = h('div.pv-marks', markIn, markOut, clear, h('span.spacer'), range);
  const step = (n: number) => { if (!cur || cur.kind === 'image') return; video.pause(); video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + n / (cur.fps || 25) + 0.0005)); };
  const keys = h('div.mon-keys', iconButton('prev', () => { video.currentTime = itemIn(); }, 'Go to in point'), iconButton('stepBack', () => step(-1), 'Back one frame'), play, iconButton('stepFwd', () => step(1), 'Forward one frame'), loop, mute);

  let cur: Info | null = null;
  let key = '';
  let item: Item | undefined;
  let timer = 0;
  let ticket = 0;

  try { video.muted = localStorage.getItem('vt.previewMuted') !== 'false'; } catch { video.muted = true; }
  const paintMute = () => { mute.replaceChildren(icon(video.muted ? 'mute' : 'speaker')); mute.title = video.muted ? 'Preview sound is off' : 'Preview sound is on'; };
  video.addEventListener('volumechange', paintMute);
  paintMute();

  const fpsOf = (i: Item) => store.state?.devices.find((d) => d.name === (i.device || homeDevice()))?.fps[i.channel - 1] ?? 50;
  const itemIn = () => (item ? (Number(item.props.seek) || 0) / fpsOf(item) : 0);
  const itemOut = () => (item && Number(item.props.length) > 0 ? itemIn() + Number(item.props.length) / fpsOf(item) : cur?.duration ?? 0);
  const stamp = (s: number) => {
    const f = Math.round(cur?.fps || 25);
    const n = Math.max(0, Math.floor(s * (cur?.fps || 25) + 0.01));
    const p = (x: number) => String(x).padStart(2, '0');
    const t = Math.floor(n / f);
    return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}:${p(n % f)}`;
  };

  function toggle(): void {
    if (!cur || cur.kind === 'image') return;
    if (video.paused) {
      if (video.currentTime >= itemOut() - 0.05) video.currentTime = itemIn();
      void video.play().catch(() => undefined);
    } else video.pause();
  }
  toggle_ = toggle;

  function paint(): void {
    const has = !!cur && cur.kind !== 'image';
    tc.textContent = has ? stamp(video.currentTime) : '--:--:--:--';
    dur.textContent = has ? stamp(cur!.duration) : '';
    const d = video.duration || cur?.duration || 0;
    if (document.activeElement !== scrub || !scrub.matches(':active')) scrub.value = String(d ? Math.round((video.currentTime / d) * 1000) : 0);
    scrub.style.setProperty('--p', `${Number(scrub.value) / 10}%`);
    scrub.disabled = !has;
    const want = video.paused ? 'play' : 'pause';
    if (play.dataset.i !== want) { play.dataset.i = want; play.replaceChildren(icon(want)); }
    play.disabled = !has;
    // Stop at the out point, like the server will.
    if (has && !video.paused && itemOut() > 0 && itemOut() < (cur!.duration - 0.05) && video.currentTime >= itemOut()) { if (video.loop) video.currentTime = itemIn(); else video.pause(); }
  }
  function paintMarks(): void {
    const ok = !!item && item.type === 'MOVIE' && cur?.kind === 'video';
    marks.hidden = !ok;
    if (!ok) return;
    const trimmed = Number(item!.props.seek) > 0 || Number(item!.props.length) > 0;
    range.textContent = trimmed ? `${stamp(itemIn())} to ${stamp(itemOut())}` : 'Whole clip';
    clear.disabled = !trimmed;
  }
  function setMarks(from: number, to: number | null): void {
    if (!item) return;
    const f = fpsOf(item);
    const seek = Math.max(0, Math.round(from * f));
    const len = to === null ? 0 : Math.round(to * f) - seek;
    if (to !== null && len < 1) return toast('The out point has to be after the in point', 'bad');
    edit([item.id], 'marks', (i) => { i.props.seek = seek; i.props.length = len; });
    emit('select');
  }
  markIn.addEventListener('click', () => setMarks(video.currentTime, Number(item?.props.length) > 0 ? itemOut() : null));
  markOut.addEventListener('click', () => setMarks(itemIn(), video.currentTime));
  clear.addEventListener('click', () => setMarks(0, null));
  scrub.addEventListener('input', () => { const d = video.duration || 0; if (d) video.currentTime = (Number(scrub.value) / 1000) * d; paint(); });
  for (const ev of ['timeupdate', 'play', 'pause', 'seeked', 'loadedmetadata', 'ended']) video.addEventListener(ev, paint);
  setInterval(() => { if (!video.paused) paint(); }, 40);
  video.addEventListener('error', () => { if (cur && video.getAttribute('src')) say('This clip could not be played'); });

  function say(t: string): void {
    msg.textContent = t;
    msg.hidden = !t;
  }
  function reset(): void {
    video.pause();
    video.removeAttribute('src');
    video.load();
    img.removeAttribute('src');
    video.hidden = img.hidden = true;
    cur = null;
    prog.hidden = true;
    info.textContent = '';
    paint();
    paintMarks();
  }

  vt.on('previewProgress', ((p: number) => {
    prog.hidden = p < 0;
    bar.style.width = `${Math.max(0, p) * 100}%`;
    if (p >= 0) say(`Preparing preview  ${Math.round(p * 100)}%`);
  }) as never);

  show = (device, clip, it) => {
    item = it;
    const k = `${device}|${clip.toLowerCase()}`;
    if (k === key) { paintMarks(); return; }
    key = k;
    const mine = ++ticket;
    reset();
    name.textContent = clip.replace(/\\/g, '/').split('/').pop()!;
    say('');
    clearTimeout(timer);
    // Arrowing quickly through a rundown should not open every clip on the way.
    timer = window.setTimeout(async () => {
      const r = await vt.call('previewOpen', device, clip);
      if (mine !== ticket) return;
      if (!r.ok) { if (r.error) say(r.error); prog.hidden = true; key = ''; return; }
      cur = r.value as Info;
      prog.hidden = true;
      say('');
      info.textContent = [cur.width ? `${cur.width}×${cur.height}` : '', cur.fps ? `${Math.round(cur.fps * 100) / 100} fps` : '', cur.codec.toUpperCase(), cur.alpha ? 'alpha' : ''].filter(Boolean).join('  ');
      if (cur.kind === 'image') { img.src = cur.url; img.hidden = false; } else {
        video.src = cur.url;
        video.hidden = cur.kind === 'audio';
        if (cur.kind === 'audio') say('Audio');
        video.addEventListener('loadedmetadata', () => { if (mine === ticket && itemIn() > 0) video.currentTime = itemIn(); }, { once: true });
      }
      paint();
      paintMarks();
    }, 180);
  };

  const follow = () => {
    const s = selected();
    if (s.length !== 1) return;
    const i = s[0].type === 'PLAYLIST' || s[0].type === 'GROUP' ? undefined : s[0];
    if (i && ['MOVIE', 'STILL', 'AUDIO', 'IMAGESCROLLER'].includes(i.type)) show!(i.device || homeDevice(), i.name, i);
  };
  on('select', follow);
  on('doc', () => { if (item && !doc()?.items.length) item = undefined; paintMarks(); });
  reset();
  return h('section.preview', h('div.in-head', h('span.in-title', 'Preview'), name, h('span.spacer'), info), h('div.pv-body', well, h('div.pv-line', tc, scrub, dur), keys, marks));
}
