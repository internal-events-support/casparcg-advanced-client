// The edges between the columns. Each is dragged, and a double click puts it back. Show keeps its own width.
import { h } from './kit';

type Col = 'library' | 'details' | 'showDetails';
const LEAST: Record<Col, number> = { library: 200, details: 310, showDetails: 280 };
const MOST: Record<Col, number> = { library: 640, details: 900, showDetails: 900 };
/** What is left for the rundown, at least. */
const CENTRE = 440;
const usual = (c: Col): number => (c === 'library' ? 268 : c === 'details' ? 330 : Math.max(300, Math.min(420, innerWidth * 0.26)));

export function splitters(body: HTMLElement): { apply: () => void } {
  const kept: Partial<Record<Col, number>> = {};
  try {
    const v: unknown = JSON.parse(localStorage.getItem('vt.columns') ?? '{}');
    if (v && typeof v === 'object') for (const c of Object.keys(LEAST) as Col[]) { const n = (v as Record<string, unknown>)[c]; if (typeof n === 'number' && Number.isFinite(n)) kept[c] = n; }
  } catch { /* as they were */ }
  const save = () => { try { localStorage.setItem('vt.columns', JSON.stringify(kept)); } catch { /* not kept */ } };
  const showing = () => body.classList.contains('show');
  const left = h('div.split.left', { title: 'Drag to resize, double-click to reset' });
  const right = h('div.split.right', { title: 'Drag to resize, double-click to reset' });

  const within = (c: Col, v: number, other: number) => Math.round(Math.max(LEAST[c], Math.min(MOST[c], body.clientWidth - other - CENTRE, v)));
  /** The widths as they fit now. What was set is kept, for when there is room again. */
  function widths(): { lib: number; det: number } {
    const col: Col = showing() ? 'showDetails' : 'details';
    const det = kept[col] ?? usual(col);
    if (showing()) return { lib: 0, det: within(col, det, 0) };
    const lib = within('library', kept.library ?? usual('library'), LEAST.details);
    return { lib, det: within(col, det, lib) };
  }
  function apply(): void {
    if (body.classList.contains('wide') || !body.clientWidth) return;
    const { lib, det } = widths();
    body.style.setProperty('--lib', `${lib}px`);
    body.style.setProperty('--det', `${det}px`);
  }

  for (const [el, isLeft] of [[left, true], [right, false]] as const) {
    const col = (): Col => (isLeft ? 'library' : showing() ? 'showDetails' : 'details');
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const c = col();
      const was = kept[c];
      const { lib, det } = widths();
      const from = isLeft ? lib : det;
      const other = isLeft ? det : lib;
      let moved = false;
      document.body.classList.add('resizing');
      el.classList.add('on');
      const move = (m: PointerEvent) => {
        const by = isLeft ? m.clientX - e.clientX : e.clientX - m.clientX;
        if (!moved && Math.abs(by) < 2) return;
        moved = true;
        kept[c] = within(c, from + by, other);
        apply();
      };
      const done = (keep: boolean) => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', stop);
        document.removeEventListener('keydown', esc, true);
        document.body.classList.remove('resizing');
        el.classList.remove('on');
        if (keep) { if (moved) save(); return; }
        if (was === undefined) delete kept[c]; else kept[c] = was;
        apply();
      };
      const up = () => done(true);
      const stop = () => done(false);
      const esc = (k: KeyboardEvent) => { if (k.key === 'Escape') { k.stopPropagation(); k.preventDefault(); done(false); } };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', stop);
      document.addEventListener('keydown', esc, true);
    });
    el.addEventListener('dblclick', () => { delete kept[col()]; save(); apply(); });
  }
  body.append(left, right);
  new ResizeObserver(apply).observe(body);
  return { apply };
}
