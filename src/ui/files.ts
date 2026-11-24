// Opening and saving from a browser, where there are no file dialogs for the show PC.
import type { Doc } from '../shared/types';
import { button, confirmSheet, h, icon, popup, textField } from './kit';

export interface Folder { dir: string; files: string[] }
const short = (d: string) => d.split(/[\\/]/).filter(Boolean).slice(-2).join(' / ');

function sheet<T>(build: (done: (v: T | null) => void) => { title: string; body: HTMLElement[]; acts: HTMLElement[] }): Promise<T | null> {
  return new Promise((ok) => {
    const done = (v: T | null) => { layer.remove(); document.removeEventListener('keydown', key, true); ok(v); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.sheet-layer:not(.files-layer)')) { e.stopPropagation(); done(null); } };
    const b = build(done);
    const layer = h('div.sheet-layer.files-layer', h('div.sheet.relink.files', h('h3', b.title), ...b.body, h('div.actions', button('Cancel', () => done(null)), ...b.acts)));
    document.body.append(layer);
    document.addEventListener('keydown', key, true);
  });
}

export function openSheet(folders: Folder[]): Promise<{ path: string } | { name: string; text: string } | null> {
  return sheet((done) => {
    const input = h('input', { type: 'file', accept: '.xml,application/xml,text/xml', hidden: true }) as HTMLInputElement;
    input.addEventListener('change', () => { const f = input.files?.[0]; if (f) void f.text().then((text) => done({ name: f.name, text })); });
    const list = h('div.rl-list', ...folders.filter((f) => f.files.length).flatMap((f) => [h('div.files-dir', { title: f.dir }, short(f.dir)), ...f.files.map((n) => {
      const b = h('button.files-row', icon('doc'), h('span', n));
      b.addEventListener('click', () => done({ path: `${f.dir}\\${n}` }));
      return b;
    })]));
    if (!list.children.length) list.append(h('div.lib-empty', 'No rundowns found on the show PC'));
    return { title: 'Open a rundown from the show PC', body: [list, input], acts: [button('From this device…', () => input.click())] };
  });
}

export function saveSheet(folders: Folder[], d: Doc): Promise<{ dir: string; name: string } | 'download' | null> {
  return sheet((done) => {
    const at = d.path ? d.path.slice(0, Math.max(d.path.lastIndexOf('\\'), d.path.lastIndexOf('/'))) : '';
    let dir = folders.find((f) => f.dir.toLowerCase() === at.toLowerCase())?.dir ?? folders[0]?.dir ?? '';
    const name = textField(d.name, () => undefined, {});
    const go = async () => {
      const n = name.el.value.trim().replace(/\.xml$/i, '');
      if (!n || /[<>:"/\\|?*]/.test(n)) { name.el.focus(); name.el.select(); return; }
      const there = folders.find((f) => f.dir === dir)?.files.some((x) => x.toLowerCase() === `${n}.xml`.toLowerCase());
      if (there && !(await confirmSheet(`Replace ${n}.xml?`, 'A rundown with that name is already there.', 'Replace', true))) return;
      done({ dir, name: n });
    };
    name.el.addEventListener('keydown', (e) => { if (e.key === 'Enter') void go(); });
    setTimeout(() => name.el.select());
    return {
      title: 'Save the rundown on the show PC',
      body: [h('div.group', h('div.in-row.wide', h('label', 'Name'), name.el), h('div.in-row', h('label', 'Folder'), popup(folders.map((f) => ({ value: f.dir, label: short(f.dir) })), dir, (v) => { dir = v; }, { cls: 'sm' }).el))],
      acts: [button('Download instead', () => done('download')), button('Save', () => void go(), 'primary')],
    };
  });
}
