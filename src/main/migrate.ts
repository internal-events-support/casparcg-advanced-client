// Until 1.2.0 this app was called CasparCG Client and kept its settings in "Caspar VT". Copies them to the new folder.
import fs from 'node:fs';
import path from 'node:path';

export const OLD_FOLDER = 'Caspar VT';
/** settings.json goes last: while it is missing, the copy has not finished. Caches are left to be made again. */
const FILES = ['presets', 'Local Storage', 'web.key', 'session.json', 'decks.json', 'media.json', 'seen.json', 'settings.json'];

/** Runs until the new folder has settings. The old folder is only read. Returns what could not be copied. */
export function carryOver(from: string, to: string): string[] {
  if (fs.existsSync(path.join(to, 'settings.json')) || !fs.existsSync(from)) return [];
  const failed: string[] = [];
  fs.mkdirSync(to, { recursive: true });
  for (const f of FILES) {
    const src = path.join(from, f);
    const dst = path.join(to, f);
    if (!fs.existsSync(src)) continue;
    try {
      // LOCK belongs to whichever app has the storage open.
      if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true, filter: (p) => path.basename(p) !== 'LOCK' });
      else { fs.copyFileSync(src, dst + '.tmp'); fs.renameSync(dst + '.tmp', dst); }
    } catch {
      // Local Storage only holds the open tab and panel sizes, and half of it is worse than none.
      if (f === 'Local Storage') fs.rmSync(dst, { recursive: true, force: true });
      else failed.push(f);
    }
  }
  return failed;
}
