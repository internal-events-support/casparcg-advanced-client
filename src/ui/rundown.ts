// The rundown, in two forms: Edit (change the show) and Show (run it, nothing can be changed).
import { findItem, isContainer, isPlaylist, newItem, tool, walk } from '../shared/tools';
import { stem, type Action, type Doc, type Item } from '../shared/types';
import { button, confirmSheet, h, icon, iconButton, menu, promptSheet, type MenuItem } from './kit';
import { DRAG, dragItems } from './library';
import { missing, missingItems, relinkSheet } from './relinkui';
import { activate, applyTemplate, call, canHold, clock, copy, copyTemplate, doc, duplicate, hasTemplate, edit, emit, execute, homeDevice, insert, itemSeconds, moveItems, mutate, newDoc, on, openFiles, openPath, paste, removeSelected, save, select, selected, selectedTop, store, toast, undo, ungroup, visible, wrap, type Spot } from './store';

const MOVE = 'application/x-vt-move';
export const COLORS = ['', '#8c3a3a', '#a0522d', '#b8922f', '#6b8e23', '#2e8b57', '#2f7f8f', '#4673c3', '#6a4fa3', '#a0478f', '#555555'];

interface RowEls { el: HTMLElement; badge: HTMLElement; where: HTMLElement; total: HTMLElement; time: HTMLElement; bar: HTMLElement; id: string; item: Item; parent: Item | null; mini?: HTMLElement; was: string }

// ---- closing tabs --------------------------------------------------------------------------------------
export async function closeDoc(d: Doc): Promise<void> {
  if (d.dirty && d.items.length) {
    const y = await confirmSheet(`Close “${d.name}” without saving?`, 'Changes since the last save will be lost.', 'Close', true);
    if (!y) return;
  }
  const at = store.docs.indexOf(d);
  store.docs = store.docs.filter((x) => x !== d);
  if (!store.docs.length) newDoc();
  else if (store.active === d.id) activate(store.docs[Math.max(0, at - 1)].id);
  else emit('tabs');
}

// ---- tabs and toolbar ---------------------------------------------------------------------------------------
export function buildRundown(mode: 'edit' | 'show', toEdit: () => void = () => undefined): HTMLElement {
  const show = mode === 'show';
  let rows: RowEls[] = [];
  const tabs = h('div.rd-tabs');
  const list = h('div.rd-list', { tabIndex: 0 });
  const root = h(`section.rundown.${mode}`);
  const count = h('span.caption.rd-count');

  const renderTabs = () => {
    tabs.textContent = '';
    for (const d of store.docs) {
      if (show) {
        const t = h('button.rd-tab' + (d.id === store.active ? '.active' : ''), h('span', d.name));
        t.addEventListener('click', () => activate(d.id));
        tabs.append(t);
        continue;
      }
      const x = h('button.rd-x', { title: 'Close' }, icon('x'));
      const t = h('button.rd-tab' + (d.id === store.active ? '.active' : ''), { title: d.path || 'Not saved yet' }, h('span', d.name), d.dirty ? h('i.dirty', { title: 'Unsaved changes' }) : null, x);
      t.addEventListener('click', () => activate(d.id));
      t.addEventListener('dblclick', () => void promptSheet('Rundown name', d.name, 'Rename').then((n) => { if (n?.trim()) { d.name = n.trim(); emit('tabs'); } }));
      t.addEventListener('auxclick', (e) => { if (e.button === 1) void closeDoc(d); });
      t.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        menu({ x: e.clientX, y: e.clientY }, [
          { label: 'Save', onClick: () => void save(false, d) }, { label: 'Save as…', onClick: () => void save(true, d) }, null,
          { label: d.allowRemote ? 'Turn off remote triggering' : 'Allow remote triggering', onClick: () => { d.allowRemote = !d.allowRemote; d.dirty = true; emit('tabs'); } }, null,
          { label: 'Close', onClick: () => void closeDoc(d) },
        ]);
      });
      x.addEventListener('click', (e) => { e.stopPropagation(); void closeDoc(d); });
      tabs.append(t);
    }
    if (!show) tabs.append(iconButton('plus', () => newDoc(), 'New rundown (Ctrl+N)', 'plain'));
  };

  const fileBtn = button(h('span.dd', 'File', icon('chevronDown')), () => menu(fileBtn, [
    { label: 'New', onClick: () => newDoc() }, { label: 'Open…', onClick: () => void openFiles() },
    ...store.settings.recent.slice(0, 6).map((f): MenuItem => ({ label: f.split(/[\\/]/).pop()!, icon: 'doc', onClick: () => void openPath(f) })), null,
    { label: 'Save', onClick: () => void save() }, { label: 'Save as…', onClick: () => void save(true) },
  ]), 'sm flat');
  const addBtn = button(h('span.dd', icon('plus'), 'Add', icon('chevronDown')), () => menu(addBtn, [
    { label: 'Playlist', icon: 'playlist', onClick: () => insert([newItem('PLAYLIST', { device: homeDevice() })]) },
    { label: 'Group', icon: 'folder', onClick: () => insert([newItem('GROUP')]) },
    { label: 'Channel take', icon: 'cut', onClick: () => insert([newItem('CGTAKE', { device: homeDevice() })]) },
    { label: 'Shell command', icon: 'terminal', onClick: () => insert([newItem('SHELL')]) },
    { label: 'Separator', icon: 'line', onClick: () => insert([newItem('SEPARATOR')]) }, null,
    { label: 'Make playlist from selection', icon: 'playlist', onClick: () => wrap('PLAYLIST') },
    { label: 'Group selection (Ctrl+G)', icon: 'folder', onClick: () => wrap('GROUP') },
    { label: 'Ungroup', onClick: () => ungroup() },
  ]), 'sm flat');
  const miss = button('', () => { if (show) toEdit(); void relinkSheet(missingItems()); }, 'sm miss', 'Find what these clips are called now');
  const head = h('div.rd-head', tabs, h('span.spacer'), miss, count, ...(show ? [] : [h('span.rd-pair', iconButton('undo', () => undo(), 'Undo (Ctrl+Z)', 'plain'), iconButton('redo', () => undo(true), 'Redo (Ctrl+Y)', 'plain')), addBtn, fileBtn]));

  // The buttons act on the selected entry, so say which one that is and only offer what it can do.
  const nowIcon = h('span.rd-now-ico');
  const nowName = h('div.rd-now-name');
  const nowSub = h('div.rd-now-sub');
  const b = (label: string, a: Action, key: string, ic: string, cls = '') => {
    const text = h('span.tb-t', label);
    const el = button(h('span.tb-in', icon(ic), h('span.tb-l', text, key ? h('kbd', key) : null)), () => void execute(a), `tb ${cls}`, key ? `${label} (${key})` : label);
    return { el, text, a, label };
  };
  const skip = () => store.settings.skipSeconds;
  const B = {
    stop: b('Stop', 'stop', 'F1', 'stop'), play: b('Play', 'play', 'F2', 'play', 'go'), load: b('Load', 'load', 'F3', 'cue'), pause: b('Pause', 'pause', 'F4', 'pause'),
    prev: b('Prev', 'prev', '', 'prev'), back: b('−5 s', 'back', '', 'back'), fwd: b('+5 s', 'forward', '', 'fwd'), next: b('Next', 'next', 'F5', 'next'),
    update: b('Update', 'update', 'F6', 'refresh'), invoke: b('Invoke', 'invoke', 'F7', 'bolt'), clear: b('Clear', 'clear', 'F10', 'eraser'),
  };
  B.prev.el.title = 'Previous clip (Shift+F5)';
  const more = button(h('span.tb-in', icon('chevronDown')), () => menu(more, [
    { label: 'Clear layer (F11)', onClick: () => void execute('clearLayer') },
    { label: 'Clear channel (F12)', destructive: true, onClick: () => void (async () => { if (!store.settings.confirmClear || await confirmSheet('Clear the whole channel?', 'Everything on this channel goes off air.', 'Clear', true)) await execute('clearChannel'); })() },
  ]), 'tb slim', 'More ways to clear');
  const tpl = h('span.tb-set', B.update.el, B.invoke.el);
  const skips = h('span.tb-set', B.prev.el, B.back.el, B.fwd.el, B.next.el);
  // Edit has its own buttons: what you do to entries rather than what they do on the server.
  const eb = (label: string, ic: string, fn: () => void, tip: string, key = '') => button(h('span.tb-in', icon(ic), h('span.tb-l', h('span.tb-t', label), key ? h('kbd', key) : null)), fn, 'tb', tip);
  const E = {
    dup: eb('Duplicate', 'copy', () => duplicate(), 'Duplicate (Ctrl+D)'), del: eb('Delete', 'trash', () => removeSelected(), 'Delete (Del)'),
    list: eb('Playlist', 'playlist', () => wrap('PLAYLIST'), 'Put the selected videos in a playlist (Ctrl+P)'), group: eb('Group', 'folder', () => wrap('GROUP'), 'Group the selection (Ctrl+G)'), un: eb('Ungroup', 'layers', () => ungroup(), 'Take the entries out again (Ctrl+Shift+G)'),
    copyT: eb('Copy template', 'template2', () => copyTemplate(), 'Copy this entry’s settings (Ctrl+Shift+C)'), applyT: eb('Apply', 'apply', () => applyTemplate(), 'Apply the copied template (Ctrl+Shift+V)'),
  };
  const big = h('span.rd-big');
  const what = h('div.rd-now', nowIcon, h('div.rd-now-t', nowName, nowSub));
  const bar = show
    ? h('div.rd-bar', what, big, h('span.tb-set.main', B.stop.el, B.play.el, B.load.el, B.pause.el), skips, tpl, h('span.tb-set', B.clear.el, more))
    : h('div.rd-bar', what, h('span.tb-set', E.dup, E.del), h('span.tb-set', E.list, E.group, E.un), h('span.tb-set', E.copyT, E.applyT));
  function paintEdit(): void {
    const s = selected();
    const real = s.filter((x) => x.type !== 'SEPARATOR');
    const top = selectedTop();
    const set = (el: HTMLButtonElement, v: boolean) => { if (el.disabled === v) el.disabled = !v; };
    set(E.dup, s.length > 0); set(E.del, s.length > 0);
    set(E.list, top.some((x) => x.type === 'MOVIE')); set(E.group, top.some((x) => !isContainer(x) && x.type !== 'SEPARATOR'));
    const box = top.some(isContainer);
    if (E.un.hidden === box) E.un.hidden = !box;
    set(E.copyT, real.length === 1 && s.length === 1); set(E.applyT, !!hasTemplate() && real.length > 0);
  }

  const PLAYS = ['MOVIE', 'AUDIO'];
  const canLoad = (i: Item) => (tool(i.type).out.includes('layer') || i.type === 'GROUP') && i.type !== 'CGTAKE' && tool(i.type).cat !== 'Mixer';
  function paintBar(): void {
    if (root.hidden) return;
    if (!show) paintEdit();
    const d = doc();
    const id = [...store.sel].pop();
    const f = d && id ? findItem(d.items, id) : null;
    const i = f?.item;
    const t = i ? tool(i.type) : null;
    const pl = i ? (isPlaylist(i) ? i : f!.parent && isPlaylist(f!.parent) ? f!.parent : null) : null;
    const grp = i?.type === 'GROUP' ? i : null;
    const live = !!i && i.type !== 'SEPARATOR';
    const timed = live && (!!pl || PLAYS.includes(i!.type) || (!!grp && !!grp.props.autoplay));
    const layered = live && (t!.out.includes('layer') || !!grp);
    const set = (x: { el: HTMLButtonElement }, on_: boolean) => { if (x.el.disabled === on_) x.el.disabled = !on_; };
    set(B.play, live); set(B.stop, live);
    set(B.load, live && canLoad(i!));
    set(B.pause, timed || (layered && ['HTML', 'STILL', 'IMAGESCROLLER', 'DECKLINKINPUT'].includes(i!.type)));
    set(B.prev, !!pl); set(B.back, timed); set(B.fwd, timed);
    set(B.next, live && (!!pl || i!.type === 'TEMPLATE' || !!i!.props.triggeronnext || !!grp?.props.autoplay || !!f!.parent?.props.autoplay));
    const isTpl = i?.type === 'TEMPLATE';
    if (tpl.hidden === isTpl) tpl.hidden = !isTpl;
    set(B.clear, layered); more.disabled = !layered;
    const st = i ? store.state?.items[i.id]?.state ?? '' : '';
    const word = st === 'paused' ? 'Resume' : 'Pause';
    if (B.pause.text.textContent !== word) B.pause.text.textContent = word;
    B.play.el.classList.toggle('lit', st === 'playing');
    for (const [x, s] of [[B.back, '−'], [B.fwd, '+']] as const) { const w = `${s}${skip()} s`; if (x.text.textContent !== w) { x.text.textContent = w; x.el.title = s === '−' ? `Back ${skip()} seconds (Alt+Left)` : `Forward ${skip()} seconds (Alt+Right)`; } }
    const n = store.sel.size;
    const name = n > 1 ? (show ? `${i?.label ?? ''} and ${n - 1} more` : `${n} selected`) : i ? i.label || t!.label : 'Nothing selected';
    const where = !i ? (show ? 'Select an entry to play it' : 'Select an entry to change it') : n > 1 && !show ? 'Changes apply to all of them' : [t!.label, layered && !grp ? (() => { const dk = pl ? store.state?.decks.find((x) => x.playlistId === pl.id) : undefined; return dk ? `${dk.channel}-${dk.layer}` : pl ? `${pl.channel}-${pl.layer}` : `${i.channel}-${i.layer}`; })() : ''].filter(Boolean).join('  ·  ');
    if (nowName.textContent !== name) nowName.textContent = name;
    if (nowSub.textContent !== where) nowSub.textContent = where;
    if (show) {
      // Time left on what is selected: the whole list for a playlist or group, the clip otherwise.
      let txt = '';
      let level = '';
      const box = i && isContainer(i) ? timeLeft(i) : null;
      const dk = pl ? store.state?.decks.find((x) => x.playlistId === pl.id) : undefined;
      const l = i && st ? store.state?.layers[dk ? `${dk.device}|${dk.channel}-${dk.layer}` : `${i.device || homeDevice()}|${i.channel}-${i.layer}`] : undefined;
      if (box) txt = box.text.split(' ')[0];
      else if (l?.end) txt = clock(l.end - l.pos, true);
      // Colour by the time shown. Something that loops never runs out.
      const left = box ? (box.ends ? box.secs : Infinity) : l?.end && st === 'playing' && !l.loop ? l.end - l.pos : Infinity;
      level = left <= store.settings.countdown.warn ? 'warn' : left <= store.settings.countdown.caution ? 'caution' : '';
      if (big.textContent !== txt) big.textContent = txt;
      if (big.dataset.level !== level) big.dataset.level = level;
    }
    const ic = t?.icon ?? 'list';
    if (nowIcon.dataset.i !== ic) { nowIcon.dataset.i = ic; nowIcon.replaceChildren(icon(ic)); nowIcon.style.color = t?.color ?? ''; }
  }

  root.append(head, bar, list);

  // ---- rows ---------------------------------------------------------------------------------------------
  function sub(i: Item, parent: Item | null): string {
    const t = tool(i.type);
    if (show && !isContainer(i)) {
      // On the night: where it goes and how long it is.
      const s = itemSeconds(i);
      return [parent && isPlaylist(parent) ? '' : t.out.includes('layer') ? `${i.channel}-${i.layer}` : '', s ? clock(s) : '', i.type === 'CGTAKE' ? `${i.props.cgtfromchannel}-${i.props.cgtfromlayer} to ${i.props.cgttochannel}-${i.props.cgttolayer}, ${String(i.props.cgtmode).toLowerCase()}${i.props.cgtroll ? ' and play' : ''}` : ''].filter(Boolean).join('  ·  ');
    }
    if (i.type === 'PLAYLIST') return `${i.channel}-${i.layer}  ·  ${(i.items ?? []).length} clips  ·  ${clock((i.items ?? []).reduce((a, x) => a + itemSeconds(x), 0))}`;
    if (i.type === 'GROUP') { const s = groupLength(i); return `${(i.items ?? []).length} items${s ? `  ·  ${clock(s)}` : ''}`; }
    const p: string[] = [];
    if (parent && isPlaylist(parent)) { const s = itemSeconds(i); return s ? clock(s) : i.name; }
    if (t.out.includes('channel')) p.push(t.out.includes('layer') ? `${i.channel}-${i.layer}` : `Channel ${i.channel}`);
    if (t.named && i.name !== i.label) p.push(i.name);
    if (!t.named && ['HTTPGET', 'HTTPPOST', 'HTML'].includes(i.type)) p.push(String(i.props.url || 'No URL'));
    if (i.type === 'CGTAKE') p.push(`${i.props.cgtfromchannel}-${i.props.cgtfromlayer} to ${i.props.cgttochannel}-${i.props.cgttolayer}`, `${i.props.cgtmode}${i.props.cgtmode === 'Fade' ? ` ${i.props.cgtframes}` : ''}${i.props.cgtroll ? ', play' : ''}`);
    if (i.type === 'SHELL') p.push(String(i.props.cgshell || 'No command').split('\n')[0]);
    if (i.type === 'CUSTOMCOMMAND') p.push(String(i.props.playCommand || 'No command'));
    if (i.delay > 0) p.push(`Delay ${i.delay} ms`);
    if (i.duration > 0) p.push(`For ${i.duration} ms`);
    if (i.device && store.settings.devices.length > 1) p.push(i.device);
    if (i.allowRemote && i.remoteId) p.push(`ID ${i.remoteId}`);
    if (i.props.transition && i.props.transition !== 'CUT') p.push(`${i.props.transition} ${i.props.transitionDuration}`);
    return p.join('  ·  ');
  }

  /** Small status icons: what a playlist or group does by itself, and what happens after each clip in it. */
  function flags(i: Item, parent: Item | null): HTMLElement | null {
    const f = (ic: string, cls: string, title: string) => h(`span.rd-flag${cls}`, { title, dataset: { flag: ic } }, icon(ic));
    const auto = (p: Item) => p.props.cgauto !== false;
    const loop = (p: Item) => p.props.cgloop === 'Loop forever';
    if (isPlaylist(i)) {
      return h('span.rd-flags', auto(i) ? f('autoNext', '.on', 'Plays the next clip automatically') : f('holdNext', '.hold', 'Waits for Next after each clip'),
        loop(i) ? f('loop', '.on', 'Loops forever') : f('stopEnd', '', 'Stops on the last clip'));
    }
    if (i.type === 'GROUP') return h('span.rd-flags', f('autoNext', i.props.autoplay ? '.on' : '.off', `Auto play is ${i.props.autoplay ? 'on' : 'off'}`), f('autoStep', i.props.autostep ? '.on' : '.off', `Auto step is ${i.props.autostep ? 'on' : 'off'}`));
    if (parent && isPlaylist(parent) && i.type === 'MOVIE') {
      const last = (parent.items ?? []).filter((x) => x.type === 'MOVIE').at(-1) === i;
      if (last && !loop(parent)) return h('span.rd-flags', f('stopEnd', '.small', 'The playlist stops here'));
      if (!auto(parent)) return h('span.rd-flags', f('holdNext', '.small.hold', 'Waits here for Next'));
      return h('span.rd-flags', last ? f('loop', '.small.on', 'Goes back to the first clip') : f('autoNext', '.small', 'Goes on to the next clip'));
    }
    return i.type === 'MOVIE' && i.props.loop ? h('span.rd-flags', f('loop', '.on', 'Loops')) : null;
  }

  function row(i: Item, parent: Item | null, n: number): RowEls {
    const t = tool(i.type);
    const badge = h('span.rd-badge');
    const time = h('span.rd-time');
    const where = h('span.rd-where');
    const total = h('span.rd-total');
    const gone = missing(i);
    const lostTip = `${i.name} is not on the server${show ? '' : '. Click to find it'}`;
    const barEl = h('i');
    const box = isContainer(i);
    const chev = box ? h('button.rd-chev' + (i.expanded === false ? '.shut' : ''), icon('chevronDown')) : null;
    chev?.addEventListener('click', (e) => { e.stopPropagation(); toggleOpen(i); });
    let mini: HTMLElement | undefined;
    if (show && i.type !== 'SEPARATOR') {
      const b = (ic: string, a: Action, title: string) => { const x = iconButton(ic, (e) => { e.stopPropagation(); void execute(a, i.id); }, title, 'plain'); return x; };
      const pl = isPlaylist(i);
      mini = h('span.rd-mini', canLoad(i) ? b('cue', 'load', 'Load, paused (F3)') : null, pl ? b('prev', 'prev', 'Previous clip (Shift+F5)') : null, b('play', 'play', 'Play (F2)'), pl ? b('next', 'next', 'Next clip (F5)') : null, i.type === 'CGTAKE' ? null : b('stop', 'stop', 'Stop (F1)'));
    }
    const el = h('div.rd-row', { dataset: { id: i.id }, title: t.note ?? '' },
      h('span.rd-stripe', { style: `background:${i.color || (parent ? tool(parent.type).color : t.color)}` }), chev,
      h('span.rd-ico', { style: `color:${t.color}` }, icon(t.icon)),
      parent && isPlaylist(parent) ? h('span.rd-n', String(n + 1)) : null,
      h('div.rd-main', h('div.rd-label', i.label || t.label), h('div.rd-sub', sub(i, parent))), mini ?? null, where, gone ? h('button.rd-miss', { title: lostTip, dataset: { miss: '1' } }, icon('warn'), 'Missing') : null, flags(i, parent), badge, total, time, h('div.rd-prog', barEl));
    el.className += ` t-${i.type.toLowerCase()}${parent ? ' child' : ''}${box ? ' box' : ''}`;
    if (gone) el.classList.add('gone');
    el.querySelector('[data-miss]')?.addEventListener('click', (e) => { e.stopPropagation(); if (show) toEdit(); void relinkSheet([i]); });
    el.draggable = !show;
    el.addEventListener('mousedown', (e) => {
      if (e.button === 2 && store.sel.has(i.id)) return;
      if (e.button === 0 && store.sel.has(i.id) && !e.ctrlKey && !e.shiftKey && store.sel.size > 1) return; // may be the start of a drag
      select(i.id, e.ctrlKey ? 'toggle' : e.shiftKey ? 'range' : 'one');
    });
    el.addEventListener('click', (e) => { if (!e.ctrlKey && !e.shiftKey && store.sel.size > 1) select(i.id); });
    el.addEventListener('dblclick', () => { if (box) toggleOpen(i); else if (show) void execute('load', i.id); else (document.querySelector('.inspector .in-row input') as HTMLInputElement | null)?.select(); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); context(e, i); });
    if (!show) el.addEventListener('dragstart', (e) => {
      if (!store.sel.has(i.id)) select(i.id);
      e.dataTransfer!.setData(MOVE, JSON.stringify(selectedTop().map((x) => x.id)));
      e.dataTransfer!.effectAllowed = 'move';
    });
    return { el, badge, where, total, time, bar: barEl, id: i.id, item: i, parent, mini, was: '' };
  }

  function toggleOpen(i: Item): void {
    i.expanded = i.expanded === false;
    emit('doc');
  }

  function context(e: MouseEvent, i: Item): void {
    const ids = selected().map((x) => x.id);
    const one = ids.length === 1;
    const act = (label: string, a: Action, ic: string): MenuItem => ({ label, icon: ic, onClick: () => void execute(a, i.id) });
    if (show) {
      menu({ x: e.clientX, y: e.clientY }, [act('Play', 'play', 'play'), ...(canLoad(i) ? [act('Load', 'load', 'cue')] : []), act('Stop', 'stop', 'stop'), ...(isPlaylist(i) ? [act('Previous clip', 'prev', 'prev'), act('Next clip', 'next', 'next')] : []), null,
        { label: 'Mark as used', onClick: () => void call('used', ids, true) }, { label: 'Mark as unused', onClick: () => void call('used', ids, false) }]);
      return;
    }
    menu({ x: e.clientX, y: e.clientY }, [
      act('Play', 'play', 'play'), act('Load', 'load', 'cue'), act('Stop', 'stop', 'stop'),
      ...(isPlaylist(i) ? [act('Previous clip', 'prev', 'prev'), act('Next clip', 'next', 'next')] : []), null,
      { label: 'Copy', icon: 'copy', onClick: () => copy() }, { label: 'Cut', onClick: () => copy(true) }, { label: 'Paste', onClick: () => paste() }, { label: 'Duplicate', onClick: () => duplicate() }, null,
      { label: 'Copy template (Ctrl+Shift+C)', icon: 'template2', onClick: () => copyTemplate() }, ...(hasTemplate() ? [{ label: `Apply template from ${hasTemplate()!.label}`, icon: 'apply', onClick: () => applyTemplate() }] : []),
      ...(tool(i.type).named ? [{ label: missing(i) ? 'Find missing clip…' : 'Replace clip…', icon: 'search', onClick: () => void relinkSheet(missing(i) ? selected().filter(missing) : [i], !missing(i)) }] : []), null,
      { label: 'Make playlist', icon: 'playlist', onClick: () => wrap('PLAYLIST') }, { label: 'Group', icon: 'folder', onClick: () => wrap('GROUP') },
      ...(isContainer(i) ? [{ label: 'Ungroup', onClick: () => ungroup() }] : []), null,
      { label: 'Colour…', icon: 'palette', onClick: () => colour(e, ids) },
      { label: 'Mark as used', onClick: () => void call('used', ids, true) }, { label: 'Mark as unused', onClick: () => void call('used', ids, false) }, null,
      { label: one ? 'Delete' : `Delete ${ids.length} items`, icon: 'trash', destructive: true, onClick: () => removeSelected() },
    ]);
  }
  function colour(e: MouseEvent, ids: string[]): void {
    menu({ x: e.clientX, y: e.clientY }, COLORS.map((c) => ({ label: c ? c.toUpperCase() : 'Default', onClick: () => edit(ids, 'color', (x) => { if (c) x.color = c; else delete x.color; }) })));
    document.querySelectorAll<HTMLElement>('.menu button').forEach((b, n) => { if (COLORS[n]) b.prepend(h('span.swatch', { style: `background:${COLORS[n]}` })); });
  }

  function render(): void {
    const top = list.scrollTop;
    list.textContent = '';
    rows = [];
    if (root.hidden) return; // drawn again when its tab opens
    const d = doc();
    for (const { item, parent } of visible()) {
      const r = row(item, parent, parent ? parent.items!.indexOf(item) : 0);
      rows.push(r);
      list.append(r.el);
      if (isContainer(item) && item.expanded !== false && !item.items?.length) list.append(h('div.rd-hint', { dataset: { into: item.id } }, show ? 'Empty' : isPlaylist(item) ? 'Drop videos here' : 'Drop items here'));
    }
    if (!d?.items.length) list.append(show ? h('div.rd-empty', h('div', icon('playlist')), 'Nothing in this rundown yet', h('span.caption', 'Add entries in the Edit tab')) : h('div.rd-empty', h('div', icon('playlist')), 'Drag media and tools here', h('span.caption', 'or double-click them in the library')));
    let n = 0;
    walk(d?.items ?? [], () => n++);
    count.textContent = n ? `${n} items` : '';
    const lost = missingItems().length;
    miss.hidden = !lost;
    miss.replaceChildren(icon('warn'), `${lost} missing`);
    list.classList.toggle('compact', store.settings.compact);
    list.scrollTop = top;
    paintSel();
    paint();
  }
  function paintSel(): void {
    paintBar();
    for (const r of rows) r.el.classList.toggle('sel', store.sel.has(r.id));
    const last = [...store.sel].pop();
    if (last) rows.find((r) => r.id === last)?.el.scrollIntoView({ block: 'nearest' });
  }

  /** Paint live state; only touches rows that changed. */
  function paint(): void {
    const s = store.state;
    if (!s) return;
    paintBar();
    for (const r of rows) {
      const i = r.item;
      const st = s.items[i.id];
      let t = '';
      let pct = 0;
      let badge: string = st?.state ?? '';
      let extra = '';
      const deck = isPlaylist(i) ? s.decks.find((d) => d.playlistId === i.id) : undefined;
      if (st?.state && (deck || i.type === 'MOVIE' || i.type === 'AUDIO')) {
        const own = r.parent && isPlaylist(r.parent) ? s.decks.find((d) => d.playlistId === r.parent!.id) : deck;
        const key = own ? `${own.device}|${own.channel}-${own.layer}` : `${i.device}|${i.channel}-${i.layer}`;
        const l = s.layers[key];
        if (l?.end) {
          t = clock(l.end - l.pos, true);
          pct = Math.round(((l.pos - l.start) / Math.max(0.01, l.end - l.start)) * 200) / 2;
          if (badge === 'playing' && !l.loop && l.end - l.pos <= 0.05) badge = 'end';
        }
        if (deck) {
          t = `${deck.index + 1}/${deck.count}  ${t}`;
          // Say where it is once it has been taken somewhere else.
          if (deck.channel !== i.channel || deck.layer !== i.layer) extra = `on ${deck.channel}-${deck.layer}`;
        }
      } else if (r.parent && isPlaylist(r.parent) && s.decks.some((d) => { const n = d.manual && s.items[d.playlistId]?.state ? (d.index + 1 < d.count ? d.index + 1 : d.loop ? 0 : null) : d.queued; return d.playlistId === r.parent!.id && n !== null && n !== d.index && r.parent!.items!.filter((x) => x.type === 'MOVIE')[n]?.id === i.id; })) badge = 'next';
      const left = isContainer(i) ? timeLeft(i) : null;
      const sig = `${badge}|${t}|${pct}|${st?.used}|${extra}|${left?.text}`;
      if (sig === r.was) continue;
      r.was = sig;
      r.badge.textContent = { loaded: 'CUED', playing: 'PLAY', paused: 'PAUSE', end: 'END', next: 'NEXT' }[badge] ?? '';
      r.badge.className = `rd-badge ${badge}`;
      r.time.textContent = t;
      r.total.textContent = left?.text ?? '';
      r.total.title = left?.title ?? '';
      r.bar.style.width = `${pct}%`;
      r.el.classList.toggle('on', !!st?.state || !!left);
      r.where.textContent = extra;
      r.el.classList.toggle('used', !!st?.used && !st.state && !left);
    }
  }

  // ---- drag and drop -----------------------------------------------------------------------------------------
  let mark: HTMLElement | null = null;
  const clearMark = () => { list.querySelectorAll('.drop-into,.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-into', 'drop-before', 'drop-after')); mark = null; };
  function spotAt(e: DragEvent): { spot: Spot; el: HTMLElement | null; how: 'into' | 'before' | 'after' | '' } {
    const d = doc();
    const target = (e.target as HTMLElement).closest<HTMLElement>('.rd-row,.rd-hint');
    if (!target || !d) return { spot: { parent: null, index: d?.items.length ?? 0 }, el: null, how: '' };
    if (target.dataset.into) return { spot: { parent: target.dataset.into, index: 0 }, el: target, how: 'into' };
    const f = findItem(d.items, target.dataset.id!)!;
    const b = target.getBoundingClientRect();
    const y = (e.clientY - b.top) / b.height;
    if (isContainer(f.item) && y > 0.3 && y < 0.75) return { spot: { parent: f.item.id, index: f.item.items!.length }, el: target, how: 'into' };
    const arr = f.parent ? f.parent.items! : d.items;
    const at = arr.indexOf(f.item);
    if (isContainer(f.item) && f.item.expanded !== false && y >= 0.75) return { spot: { parent: f.item.id, index: 0 }, el: target, how: 'after' };
    return { spot: { parent: f.parent?.id ?? null, index: at + (y >= 0.5 ? 1 : 0) }, el: target, how: y >= 0.5 ? 'after' : 'before' };
  }
  if (!show) list.addEventListener('dragover', (e) => {
    const types = e.dataTransfer?.types ?? [];
    if (!types.includes(DRAG) && !types.includes(MOVE)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = types.includes(MOVE) ? 'move' : 'copy';
    const s = spotAt(e);
    clearMark();
    if (s.el && s.how) { mark = s.el; mark.classList.add(`drop-${s.how}`); }
  });
  list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget as Node)) clearMark(); });
  if (!show) list.addEventListener('drop', (e) => {
    e.preventDefault();
    const s = spotAt(e);
    clearMark();
    const mv = e.dataTransfer!.getData(MOVE);
    if (mv) moveItems(JSON.parse(mv) as string[], s.spot);
    else {
      const items = dragItems(e);
      const d = doc();
      const p = s.spot.parent && d ? findItem(d.items, s.spot.parent)?.item : null;
      if (p && !items.some((x) => canHold(p, x))) return toast(isPlaylist(p) ? 'Playlists hold videos only' : 'That cannot go in a group', 'bad');
      insert(items, s.spot);
    }
    list.focus();
  });

  on('tabs', renderTabs);
  on('doc', render);
  on('select', paintSel);
  on('state', paint);
  on('library', render);
  on('settings', render);
  let pos = 0;
  list.addEventListener('scroll', () => { if (!root.hidden && rows.length) pos = list.scrollTop; });
  on('tab', () => { render(); if (!root.hidden) { list.scrollTop = pos; paintSel(); } });
  renderTabs();
  render();
  return root;
}

/** How long a group runs: one after another with auto play, otherwise as long as its longest clip. */
function groupLength(g: Item): number {
  const s = (g.items ?? []).filter((i) => i.type === 'MOVIE' || i.type === 'AUDIO').map(itemSeconds);
  return s.length ? (g.props.autoplay ? s.reduce((a, b) => a + b, 0) : Math.max(...s)) : 0;
}
/** Time left on a whole playlist or group that is loaded or playing. */
function timeLeft(c: Item): { text: string; title: string; secs: number; ends: boolean } | null {
  const s = store.state;
  if (!s) return null;
  const rest = (from: Item[]) => from.reduce((a, i) => a + itemSeconds(i), 0);
  const left = (key: string) => { const l = s.layers[key]; return l?.end ? { t: Math.max(0, l.end - l.pos), loop: l.loop } : null; };
  if (isPlaylist(c)) {
    const d = s.decks.find((x) => x.playlistId === c.id);
    const now = d && s.items[c.id]?.state ? left(`${d.device}|${d.channel}-${d.layer}`) : null;
    if (!d || !now) return null;
    const clips = (c.items ?? []).filter((i) => i.type === 'MOVIE');
    const secs = now.t + rest(clips.slice(d.index + 1));
    const t = clock(secs, true);
    return d.loop ? { secs, ends: false, text: `${t} to loop`, title: 'Time until the playlist starts again' } : { secs, ends: s.items[c.id]?.state === 'playing', text: `${t} left`, title: `Time left on the whole playlist${d.manual ? ', not counting the waits' : ''}` };
  }
  const kids = (c.items ?? []).filter((i) => i.type === 'MOVIE' || i.type === 'AUDIO');
  const on_ = kids.map((i) => ({ i, now: s.items[i.id]?.state ? left(`${i.device || homeDevice()}|${i.channel}-${i.layer}`) : null })).filter((x) => x.now);
  if (!on_.length) return null;
  if (on_.some((x) => x.now!.loop)) return { secs: 0, ends: false, text: 'Loops', title: 'A clip in this group loops' };
  const t = c.props.autoplay ? on_.at(-1)!.now!.t + rest(kids.slice(kids.indexOf(on_.at(-1)!.i) + 1)) : Math.max(...on_.map((x) => x.now!.t));
  return { secs: t, ends: true, text: `${clock(t, true)} left`, title: 'Time left on the whole group' };
}

export function setCollapsed(shut: boolean): void {
  for (const i of doc()?.items ?? []) if (isContainer(i)) i.expanded = !shut;
  emit('doc');
}
export { mutate, stem };
