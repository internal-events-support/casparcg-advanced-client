// Clip preview: plays the file on this PC. Nothing here touches the server's channels.
import { findItem } from '../shared/tools';
import type { Item } from '../shared/types';
import { h, icon, iconButton } from './kit';
import { doc, edit, fpsOf, homeDevice, on, playlistOf, selected, store, toast, vt } from './store';

interface Info { url: string; kind: 'video' | 'image' | 'audio'; fps: number; duration: number; width: number; height: number; codec: string; alpha: boolean; proxy: boolean }

let show: ((device: string, name: string, item?: Item) => void) | null = null;
let toggle_: (() => void) | null = null;
let pause_: (() => void) | null = null;
let mode_: ((asAired: boolean) => void) | null = null;
let key_: ((k: PreviewKey) => void) | null = null;
export type PreviewKey = 'in' | 'out' | 'goIn' | 'goOut' | 'back' | 'fwd' | 'back10' | 'fwd10';
/** Open a clip in the preview (paused on its first frame). */
export const previewClip = (device: string, name: string, item?: Item) => show?.(device, name, item);
export const previewToggle = () => toggle_?.();
export const previewPause = () => pause_?.();
/** Trimming and stepping from the keyboard. */
export const previewKey = (k: PreviewKey) => key_?.(k);
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
  const tc = h('span.pv-tc', '--:--:--');
  const dur = h('span.pv-dur', '');
  const scrub = h('input.mon-scrub', { type: 'range', min: '0', max: '1000', step: '0.001', value: '0', title: 'Scrub' }) as HTMLInputElement;
  const play = iconButton('play', () => toggle(), 'Play / pause (Space)', 'mon-play');
  const loop = iconButton('loop', () => { looping = !looping; loop.classList.toggle('active', looping); paint(); }, 'Loop', 'plain');
  const mute = iconButton('speaker', () => { if (gone && video.muted) return toast(`${store.settings.previewOutput} is not connected`, 'bad'); video.muted = !video.muted; try { localStorage.setItem('vt.previewMuted', String(video.muted)); } catch { /* not kept */ } paintMute(); }, 'Preview sound', 'plain');
  // The part that plays, on the scrub bar: drag either end.
  const gripIn = h('div.pv-grip.in', { title: 'Drag to set where the clip starts. Double-click to start from the beginning' });
  const gripOut = h('div.pv-grip.out', { title: 'Drag to set where the clip ends. Double-click to play to the end' });
  const tl = h('div.pv-tl', h('div.pv-keep'), scrub, gripIn, gripOut);
  const markBtn = (label: string, k: string, tip: string) => h('button.btn.sm.pv-mark', { title: `${tip} (${k})` }, label, h('kbd', k)) as HTMLButtonElement;
  const markIn = markBtn('Set in', 'I', 'Start the clip at the frame shown');
  const markOut = markBtn('Set out', 'O', 'End the clip after the frame shown');
  const tcField = (tip: string) => h('input.field.pv-at', { type: 'text', spellcheck: false, title: `${tip}. Minutes:seconds:frames, or seconds. Up and Down move one frame` }) as HTMLInputElement;
  const atIn = tcField('Starts at');
  const atOut = tcField('Ends at');
  const says = h('span.pv-says');
  const clear = h('button.pv-clear', { title: 'Remove the in and out points' }, 'Use whole clip') as HTMLButtonElement;
  const marks = h('div.pv-marks', h('div.pv-set', markIn, atIn, h('span.spacer'), atOut, markOut), h('div.pv-sum', says, h('span.spacer'), clear));
  const step = (n: number) => { if (!cur || cur.kind === 'image') return; video.pause(); go(Math.max(0, Math.min(total() - frame() / 2, (frameNo() + n + 0.5) * frame()))); };
  const stepBack = iconButton('stepBack', () => step(-1), 'Back one frame (Left)');
  const stepFwd = iconButton('stepFwd', () => step(1), 'Forward one frame (Right)');
  const toEnd = iconButton('next', () => goOut(), 'Go to the end (Shift+O)');
  const keys = h('div.mon-keys', iconButton('prev', () => { video.pause(); cue(); }, 'Go to the start (Shift+I)'), stepBack, play, stepFwd, toEnd, loop, mute);

  // Play on the sound output chosen in Settings. If it is unplugged, stay silent rather than come out somewhere else.
  async function sound(): Promise<void> {
    if (vt.web) return; // the chosen output is one on the show PC
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
  navigator.mediaDevices?.addEventListener('devicechange', () => void sound());
  check();

  const controls = h('div.pv-ctl', h('div.pv-line', tc, tl, dur), keys);
  const root = h('section.preview', { hidden: true }, h('div.in-head', h('span.in-title', 'Preview'), name, h('span.spacer'), info), h('div.pv-body', well, controls, marks));

  let cur: Info | null = null;
  let key = '';
  let item: Item | undefined;
  let timer = 0;
  let ticket = 0;
  let looping = false;
  let aired = false;
  /** Where an end is being dragged to. Only saved when it is let go. */
  let draft: { from: number; to: number } | null = null;
  /** Playback that began before the out point stops there; begun after it, it carries on so the rest can be seen. */
  let guard = true;

  try { video.muted = localStorage.getItem('vt.previewMuted') !== 'false'; } catch { video.muted = true; }
  const paintMute = () => { mute.replaceChildren(icon(video.muted ? 'mute' : 'speaker')); mute.title = video.muted ? 'Preview sound is off' : 'Preview sound is on'; };
  video.addEventListener('volumechange', paintMute);
  paintMute();

  const frame = () => 1 / (cur?.fps || 25);
  const total = () => video.duration || cur?.duration || 0;
  const loops = () => (aired ? !!item?.props.loop && !playlistOf(item) : looping);
  const itemIn = () => (draft ? draft.from : item ? Math.min((Number(item.props.seek) || 0) / fpsOf(item), Math.max(0, (cur?.duration ?? Infinity) - frame())) : 0);
  const itemOut = () => {
    const end = cur?.duration ?? 0;
    if (draft) return draft.to;
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
  const cue = () => { if (cur && cur.kind !== 'image') go(itemIn() ? itemIn() + 0.001 : 0); };
  /** The last moment shown: the final frame of the channel that the part fills. */
  const lastAt = () => (ends() && item ? Math.max(itemIn(), itemOut() - 1 / fpsOf(item) + 0.001) : Math.max(0, total() - frame() / 2));
  const goOut = () => { if (!cur || cur.kind === 'image') return; video.pause(); go(lastAt()); };
  const frameNo = () => Math.floor(video.currentTime * (cur?.fps || 25) + 0.01);
  // One seek at a time, so dragging shows frames as it goes instead of piling them up.
  let want: number | null = null;
  function go(t: number): void { if (video.seeking) want = t; else video.currentTime = t; }
  video.addEventListener('seeked', () => { if (want !== null) { video.currentTime = want; want = null; } });
  const ends = () => itemOut() > 0 && itemOut() < (cur?.duration ?? 0) - 0.02;
  /** Reached the out point: go round again, or hold on the last frame like the server does. */
  function finish(): void {
    if (loops()) { cue(); if (video.ended || video.paused) void video.play().catch(() => undefined); return; }
    video.pause();
    go(lastAt());
  }
  const stamp = (s: number) => {
    const f = Math.round(cur?.fps || 25);
    const n = Math.max(0, Math.floor(s * (cur?.fps || 25) + 0.01));
    const p = (x: number) => String(x).padStart(2, '0');
    const t = Math.floor(n / f);
    return `${(cur?.duration ?? 0) >= 3600 ? `${p(Math.floor(t / 3600))}:` : ''}${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}:${p(n % f)}`;
  };

  function toggle(): void {
    if (root.hidden || !cur || cur.kind === 'image') return;
    if (video.paused) {
      // From the last frame (or anywhere outside it in Show) start again; past the out point, play on from there.
      const t = video.currentTime;
      if (t >= total() - frame() * 0.75 || (t >= lastAt() - 0.01 && (aired || t < itemOut() + 0.01)) || (aired && t < itemIn() - 0.02)) cue();
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
    draft = null;
    loop.hidden = stepBack.hidden = stepFwd.hidden = toEnd.hidden = aired;
    if (aired) { follow(true); cue(); }
    paint();
    paintMarks();
  };

  function paint(): void {
    const has = !!cur && cur.kind !== 'image';
    const native = loops() && itemIn() === 0 && !ends(); // gapless, but only able to repeat the whole file
    if (video.loop !== native) video.loop = native;
    const t = Math.max(0, video.currentTime - lo());
    tc.textContent = has ? stamp(t) : '--:--:--';
    dur.textContent = has ? stamp(aired ? hi() - lo() : cur!.duration) : '';
    const d = hi() - lo();
    if (document.activeElement !== scrub || !scrub.matches(':active')) scrub.value = (d > 0 ? Math.min(1, t / d) * 1000 : 0).toFixed(3);
    scrub.style.setProperty('--p', `${Number(scrub.value) / 10}%`);
    scrub.disabled = !has;
    const want = video.paused ? 'play' : 'pause';
    if (play.dataset.i !== want) { play.dataset.i = want; play.replaceChildren(icon(want)); }
    play.disabled = !has;
    // Stop at the out point, like the server will.
    if (has && !video.paused && !video.seeking && guard && ends() && video.currentTime >= itemOut()) finish();
  }
  function paintMarks(): void {
    const ok = !!item && item.type === 'MOVIE' && cur?.kind === 'video' && cur.duration > 0 && !aired;
    marks.hidden = !ok;
    root.classList.toggle('trim', ok);
    if (!ok) return;
    const a = itemIn();
    const z = itemOut();
    tl.style.setProperty('--a', String(Math.min(1, a / cur!.duration)));
    tl.style.setProperty('--z', String(Math.min(1, z / cur!.duration)));
    const trimmed = a > 0 || ends();
    root.classList.toggle('trimmed', trimmed);
    if (document.activeElement !== atIn) atIn.value = stamp(a);
    if (document.activeElement !== atOut) atOut.value = stamp(z);
    const w = trimmed ? `Plays ${stamp(z - a)} of ${stamp(cur!.duration)}` : 'Plays the whole clip';
    if (says.textContent !== w) says.textContent = w;
    clear.hidden = !trimmed;
  }
  const canTrim = () => !marks.hidden && !root.hidden && !!item && !!cur;
  /** Save the part to play. Times are put on the channel's frames, late enough that the frame chosen is the one it shows. */
  function setMarks(from: number, to: number | null): void {
    if (!canTrim()) return;
    const f = fpsOf(item!);
    const on_ = (t: number) => Math.max(0, Math.ceil(t * f - 0.001));
    const seek = on_(Math.min(from, cur!.duration - frame()));
    const len = to === null || to >= cur!.duration - frame() / 2 ? 0 : Math.max(1, on_(to) - seek);
    if (seek !== (Number(item!.props.seek) || 0) || len !== (Number(item!.props.length) || 0)) edit([item!.id], 'marks', (i) => { i.props.seek = seek; i.props.length = len; });
    paint();
    paintMarks();
  }
  // An in point past the out point drops the out point, and the other way round.
  const setIn = (t: number) => { const z = ends() ? itemOut() : null; setMarks(t, z !== null && z <= t + 0.001 ? null : z); };
  const setOut = (t: number) => { const a = itemIn(); setMarks(a >= t - 0.001 ? 0 : a, t); };
  const inHere = () => setIn(frameNo() * frame());
  const outHere = () => setOut((frameNo() + 1) * frame());
  markIn.addEventListener('click', inHere);
  markOut.addEventListener('click', outHere);
  clear.addEventListener('click', () => setMarks(0, null));
  key_ = (k) => {
    if (root.hidden || !cur || cur.kind === 'image') return;
    if (k === 'goIn') { video.pause(); cue(); } else if (k === 'goOut') goOut();
    else if (k === 'in') inHere(); else if (k === 'out') outHere();
    else step((k.startsWith('back') ? -1 : 1) * (k.endsWith('10') ? 10 : 1));
  };

  /** "1:12:05" is minutes, seconds and frames; "1:12" minutes and seconds; "72.5" seconds. */
  function parse(v: string): number | null {
    const p = v.trim().replace(',', '.').split(/[:;]/);
    if (p.length > 4 || p.some((x) => !/^\d+(\.\d+)?$/.test(x.trim()))) return null;
    const n = p.map(Number);
    const fr = n.length >= 3 ? n.pop()! * frame() : 0;
    return n.reduce((a, x) => a * 60 + x, 0) + fr;
  }
  for (const [el, put, get] of [[atIn, setIn, itemIn], [atOut, setOut, itemOut]] as const) {
    const commit = () => {
      const t = parse(el.value);
      const same = el.value === stamp(get());
      if (t !== null && !same && canTrim()) { put(Math.round(t / frame()) * frame()); video.pause(); if (el === atIn) cue(); else goOut(); }
      el.value = stamp(get());
    };
    el.addEventListener('focus', () => el.select());
    el.addEventListener('blur', commit);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { commit(); el.select(); }
      if (e.key === 'Escape') { el.value = stamp(get()); el.blur(); }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const by = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1);
        const n = Math.round(get() / frame()) + by;
        const t = (el === atIn ? Math.max(0, Math.min(n, Math.round(itemOut() / frame()) - 1)) : Math.max(Math.round(itemIn() / frame()) + 1, n)) * frame();
        put(t);
        video.pause();
        if (el === atIn) cue(); else goOut();
        el.value = stamp(get());
        el.select();
      }
      if (!e.ctrlKey && !/^F\d+$/.test(e.key)) e.stopPropagation();
    });
  }
  for (const [el, isIn] of [[gripIn, true], [gripOut, false]] as const) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !canTrim()) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      video.pause();
      const box = scrub.getBoundingClientRect();
      const id = item!.id;
      const start = { from: itemIn(), to: itemOut() };
      const grab = e.clientX - (box.left + ((isIn ? start.from : start.to) / cur!.duration) * box.width);
      let moved = false;
      const move = (m: PointerEvent) => {
        if (!cur || item?.id !== id) return;
        if (!moved && Math.abs(m.clientX - e.clientX) < 2) return;
        moved = true;
        tl.classList.add('drag');
        const n = Math.round((((m.clientX - grab - box.left) / box.width) * cur.duration) / frame());
        const last = Math.round(cur.duration / frame());
        const a = Math.round(start.from / frame());
        const z = Math.round(start.to / frame());
        draft = isIn ? { from: Math.max(0, Math.min(n, z - 1)) * frame(), to: start.to } : { from: start.from, to: n >= last ? cur.duration : Math.max(a + 1, n) * frame() };
        go(isIn ? draft.from + (draft.from ? 0.001 : 0) : Math.max(draft.from, draft.to - frame() / 2));
        paintMarks();
      };
      const done = (save: boolean) => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', stop);
        document.removeEventListener('keydown', esc, true);
        tl.classList.remove('drag');
        const d = draft;
        draft = null;
        // Only the end that was dragged changes; the other keeps its exact frame.
        if (save && d && moved && item?.id === id) { if (isIn) setIn(d.from); else setOut(d.to); }
        paint();
        paintMarks();
      };
      const up = () => done(true);
      const stop = () => done(false);
      const esc = (k: KeyboardEvent) => { if (k.key === 'Escape') { k.stopPropagation(); k.preventDefault(); done(false); } };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', stop);
      document.addEventListener('keydown', esc, true);
    });
    el.addEventListener('dblclick', () => { if (canTrim()) { if (isIn) setMarks(0, ends() ? itemOut() : null); else setMarks(itemIn(), null); } });
  }
  scrub.addEventListener('input', () => { const d = hi() - lo(); if (d > 0) go(Math.min(lo() + (Number(scrub.value) / 1000) * d, aired ? lastAt() : Infinity)); });
  const watch = () => { guard = aired || video.currentTime < itemOut() - 0.001; };
  for (const ev of ['play', 'seeked']) video.addEventListener(ev, watch);
  for (const ev of ['timeupdate', 'play', 'pause', 'seeked', 'loadedmetadata', 'ended']) video.addEventListener(ev, paint);
  setInterval(() => { if (!video.paused) paint(); }, 40);
  video.addEventListener('ended', () => { if (loops()) finish(); });
  // Frame by frame, so no frame past the out point is shown.
  const each = (_: number, m: { mediaTime: number }) => {
    if (cur && item && guard && !video.paused && !video.seeking && ends() && m.mediaTime + frame() > itemOut() - 1 / fpsOf(item) + 0.002) finish();
    video.requestVideoFrameCallback(each);
  };
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(each);
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
    if (other) draft = null;
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
  on('doc', () => {
    // Undo and other screens replace the entries: hold on to the one shown.
    if (item) { const now = findItem(doc()?.items ?? [], item.id)?.item; if (now !== item) { const moved = now && now.name !== item.name; item = now; if (moved) return follow(); } }
    paint();
    paintMarks();
  });
  reset();
  follow();
  return root;
}
