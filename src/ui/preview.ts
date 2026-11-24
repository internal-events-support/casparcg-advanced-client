// Clip preview: plays the file on this PC. Nothing here touches the server's channels.
import type { Item } from '../shared/types';
import { h, icon, iconButton } from './kit';
import { doc, edit, emit, fpsOf, homeDevice, on, playlistOf, selected, store, toast, vt } from './store';

interface Info { url: string; kind: 'video' | 'image' | 'audio'; fps: number; duration: number; width: number; height: number; codec: string; alpha: boolean; proxy: boolean }

let show: ((device: string, name: string, item?: Item) => void) | null = null;
let toggle_: (() => void) | null = null;
let pause_: (() => void) | null = null;
let mode_: ((asAired: boolean) => void) | null = null;
/** Open a clip in the preview (paused on its first frame). */
export const previewClip = (device: string, name: string, item?: Item) => show?.(device, name, item);
export const previewToggle = () => toggle_?.();
export const previewPause = () => pause_?.();
/** Show plays a clip as it will go out: its part only, repeating if it repeats. Edit has the whole clip, to trim it. */
export const previewMode = (asAired: boolean) => mode_?.(asAired);

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
  const loop = iconButton('loop', () => { looping = !looping; loop.classList.toggle('active', looping); paint(); }, 'Loop', 'plain');
  const mute = iconButton('speaker', () => { if (gone && video.muted) return toast(`${store.settings.previewOutput} is not connected`, 'bad'); video.muted = !video.muted; try { localStorage.setItem('vt.previewMuted', String(video.muted)); } catch { /* not kept */ } paintMute(); }, 'Preview sound', 'plain');
  const markIn = h('button.btn.sm', { title: 'Start the clip here' }, 'Set in') as HTMLButtonElement;
  const markOut = h('button.btn.sm', { title: 'End the clip here' }, 'Set out') as HTMLButtonElement;
  const clear = h('button.btn.sm', { title: 'Play the whole clip' }, 'Clear') as HTMLButtonElement;
  const marks = h('div.pv-marks', markIn, markOut, clear, h('span.spacer'), range);
  const step = (n: number) => { if (!cur || cur.kind === 'image') return; video.pause(); video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + n / (cur.fps || 25) + 0.0005)); };
  const stepBack = iconButton('stepBack', () => step(-1), 'Back one frame');
  const stepFwd = iconButton('stepFwd', () => step(1), 'Forward one frame');
  const keys = h('div.mon-keys', iconButton('prev', () => cue(), 'Go to the start'), stepBack, play, stepFwd, loop, mute);

  // Play on the sound output chosen in Settings. If it is unplugged, stay silent rather than come out somewhere else.
  async function sound(): Promise<void> {
    const want = store.settings.previewOutput;
    const set = (id: string) => (video as HTMLVideoElement & { setSinkId(id: string): Promise<void> }).setSinkId(id);
    try {
      if (!want) return void (await set(''));
      const d = (await navigator.mediaDevices.enumerateDevices()).find((x) => x.kind === 'audiooutput' && x.label === want);
      if (d) { await set(d.deviceId); gone = false; return; }
    } catch { /* handled below */ }
    if (!gone) toast(`Preview sound is off: ${want} is not connected`, 'bad');
    gone = true;
    video.muted = true;
  }
  let gone = false;
  let was: string | null = null;
  const check = () => { if (store.settings.previewOutput !== was) { was = store.settings.previewOutput; void sound(); } };
  on('settings', check);
  navigator.mediaDevices.addEventListener('devicechange', () => void sound());
  check();

  const controls = h('div.pv-ctl', h('div.pv-line', tc, scrub, dur), keys);
  const root = h('section.preview', { hidden: true }, h('div.in-head', h('span.in-title', 'Preview'), name, h('span.spacer'), info), h('div.pv-body', well, controls, marks));

  let cur: Info | null = null;
  let key = '';
  let item: Item | undefined;
  let timer = 0;
  let ticket = 0;
  let looping = false;
  let aired = false;

  try { video.muted = localStorage.getItem('vt.previewMuted') !== 'false'; } catch { video.muted = true; }
  const paintMute = () => { mute.replaceChildren(icon(video.muted ? 'mute' : 'speaker')); mute.title = video.muted ? 'Preview sound is off' : 'Preview sound is on'; };
  video.addEventListener('volumechange', paintMute);
  paintMute();

  const frame = () => 1 / (cur?.fps || 25);
  const total = () => video.duration || cur?.duration || 0;
  const loops = () => (aired ? !!item?.props.loop && !playlistOf(item) : looping);
  const itemIn = () => (item ? Math.min((Number(item.props.seek) || 0) / fpsOf(item), Math.max(0, (cur?.duration ?? Infinity) - frame())) : 0);
  const itemOut = () => {
    const end = cur?.duration ?? 0;
    if (!item) return end;
    const len = Number(item.props.length) > 0 ? Number(item.props.length) / fpsOf(item) : Infinity;
    // Stopped by itself after a while. A playlist pays no attention to that, and Edit is for trimming.
    const cut = aired && item.duration > 0 && !loops() && !playlistOf(item) ? item.duration / 1000 : Infinity;
    return Math.min(end, itemIn() + Math.min(len, cut));
  };
  /** Part of the clip the scrub bar and times cover. */
  const lo = () => (aired ? itemIn() : 0);
  const hi = () => (aired ? itemOut() : total());
  /** Onto the first frame that plays. The little extra is so rounding never lands on the frame before. */
  const cue = () => { if (cur && cur.kind !== 'image') video.currentTime = itemIn() ? itemIn() + 0.001 : 0; };
  const ends = () => itemOut() > 0 && itemOut() < (cur?.duration ?? 0) - 0.02;
  /** Reached the out point: go round again, or hold on the last frame like the server does. */
  function finish(): void {
    if (loops()) { cue(); if (video.ended || video.paused) void video.play().catch(() => undefined); return; }
    video.pause();
    if (aired) video.currentTime = Math.max(itemIn(), itemOut() - frame() / 2);
  }
  const stamp = (s: number) => {
    const f = Math.round(cur?.fps || 25);
    const n = Math.max(0, Math.floor(s * (cur?.fps || 25) + 0.01));
    const p = (x: number) => String(x).padStart(2, '0');
    const t = Math.floor(n / f);
    return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}:${p(n % f)}`;
  };

  function toggle(): void {
    if (root.hidden || !cur || cur.kind === 'image') return;
    if (video.paused) {
      if (video.currentTime >= itemOut() - Math.max(0.05, frame() * 0.75) || (aired && video.currentTime < itemIn() - 0.02)) cue();
      void video.play().catch(() => undefined);
    } else video.pause();
  }
  toggle_ = toggle;
  pause_ = () => video.pause();
  mode_ = (v) => {
    if (v === aired) return;
    video.pause();
    aired = v;
    root.classList.toggle('aired', aired);
    loop.hidden = stepBack.hidden = stepFwd.hidden = aired;
    if (aired) { follow(true); cue(); }
    paint();
    paintMarks();
  };

  function paint(): void {
    const has = !!cur && cur.kind !== 'image';
    const native = loops() && itemIn() === 0 && !ends(); // gapless, but only able to repeat the whole file
    if (video.loop !== native) video.loop = native;
    const t = Math.max(0, video.currentTime - lo());
    tc.textContent = has ? stamp(t) : '--:--:--:--';
    dur.textContent = has ? stamp(aired ? hi() - lo() : cur!.duration) : '';
    const d = hi() - lo();
    if (document.activeElement !== scrub || !scrub.matches(':active')) scrub.value = String(d > 0 ? Math.round(Math.min(1, t / d) * 1000) : 0);
    scrub.style.setProperty('--p', `${Number(scrub.value) / 10}%`);
    scrub.disabled = !has;
    const want = video.paused ? 'play' : 'pause';
    if (play.dataset.i !== want) { play.dataset.i = want; play.replaceChildren(icon(want)); }
    play.disabled = !has;
    // Stop at the out point, like the server will.
    if (has && !video.paused && !video.seeking && ends() && video.currentTime >= itemOut()) finish();
  }
  function paintMarks(): void {
    const ok = !!item && item.type === 'MOVIE' && cur?.kind === 'video';
    marks.hidden = !ok || aired;
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
  scrub.addEventListener('input', () => { const d = hi() - lo(); if (d > 0) video.currentTime = Math.min(lo() + (Number(scrub.value) / 1000) * d, aired ? hi() - frame() / 2 : Infinity); paint(); });
  for (const ev of ['timeupdate', 'play', 'pause', 'seeked', 'loadedmetadata', 'ended']) video.addEventListener(ev, paint);
  setInterval(() => { if (!video.paused) paint(); }, 40);
  video.addEventListener('ended', () => { if (loops()) finish(); });
  // Frame by frame, so no frame past the out point is shown.
  const each = (_: number, m: { mediaTime: number }) => {
    if (aired && cur && !video.paused && !video.seeking && ends() && m.mediaTime + frame() * 1.25 >= itemOut()) finish();
    video.requestVideoFrameCallback(each);
  };
  video.requestVideoFrameCallback(each);
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
    const other = item?.id !== it?.id;
    item = it;
    const k = `${device}|${clip.toLowerCase()}`;
    if (k === key) {
      root.hidden = false;
      // The same clip in another entry can have another start, and so can this one after an edit.
      if (other) { video.pause(); cue(); } else if (aired && video.paused && (video.currentTime < itemIn() - 0.02 || video.currentTime > itemOut())) cue();
      paint();
      paintMarks();
      return;
    }
    key = k;
    root.hidden = false;
    controls.hidden = false;
    const mine = ++ticket;
    reset();
    name.textContent = clip.replace(/\\/g, '/').split('/').pop()!;
    say('');
    clearTimeout(timer);
    // Arrowing quickly through a rundown should not open every clip on the way.
    timer = window.setTimeout(async () => {
      const r = await vt.call('previewOpen', device, clip);
      if (mine !== ticket) return;
      if (!r.ok) { if (r.error) say(r.error); prog.hidden = true; controls.hidden = true; key = ''; return; }
      cur = r.value as Info;
      controls.hidden = cur.kind === 'image'; // nothing to play or scrub
      prog.hidden = true;
      say('');
      info.textContent = [cur.width ? `${cur.width}×${cur.height}` : '', cur.fps ? `${Math.round(cur.fps * 100) / 100} fps` : '', cur.codec.toUpperCase(), cur.alpha ? 'alpha' : ''].filter(Boolean).join('  ');
      if (cur.kind === 'image') { img.src = cur.url; img.hidden = false; } else {
        video.src = cur.url;
        video.hidden = cur.kind === 'audio';
        if (cur.kind === 'audio') say('Audio');
        video.addEventListener('loadedmetadata', () => { if (mine === ticket && itemIn() > 0) cue(); }, { once: true });
      }
      paint();
      paintMarks();
    }, 180);
  };

  /** Put the whole preview away and stop what it was doing. */
  function hide(): void {
    root.hidden = true;
    ticket++;
    clearTimeout(timer);
    key = '';
    item = undefined;
    reset();
    void vt.call('previewCancel');
  }
  let last = '';
  const follow = (force = false) => {
    const s = selected();
    const ids = s.map((x) => x.id).join();
    const i = s.length === 1 && ['MOVIE', 'STILL', 'AUDIO', 'IMAGESCROLLER'].includes(s[0].type) ? s[0] : undefined;
    if (i) show!((playlistOf(i) ?? i).device || homeDevice(), i.name, i);
    // Only when the selection really changed: an edit elsewhere should not close a clip opened from the library.
    else if ((ids !== last || force) && !root.hidden) hide();
    last = ids;
  };
  on('select', () => follow());
  on('doc', () => { if (item && !doc()?.items.length) item = undefined; paintMarks(); });
  reset();
  follow();
  return root;
}
