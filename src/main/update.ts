// Keeps an installed copy up to date from the GitHub releases. New versions are downloaded in the background and
// installed when the app quits or when asked to, never while it is running and never as it starts.
import { app } from 'electron';
import { NsisUpdater } from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import type { UpdateState } from '../shared/types';

export const RELEASES = 'https://github.com/internal-events-support/casparcg-advanced-client/releases';
const EVERY = 6 * 3600e3;

interface Hooks {
  automatic: () => boolean;
  /** Something is on air that this app is looking after. */
  busy: () => boolean;
  changed: (s: UpdateState) => void;
  log: (dir: 'info' | 'err', text: string) => void;
}

export class Updater {
  private up: NsisUpdater | null = null;
  private installer = '';
  private s: UpdateState = { installed: false, version: app.getVersion(), activity: '', percent: 0, ready: '', checked: 0, error: '' };

  constructor(private h: Hooks) {
    // Not run from source, unpacked, or as the portable exe of 1.3.0 and earlier.
    const exe = app.getPath('exe');
    if (!app.isPackaged || !fs.existsSync(path.join(path.dirname(exe), `Uninstall ${path.basename(exe)}`))) return;
    const up = new NsisUpdater();
    up.logger = null;
    up.autoInstallOnAppQuit = false; // see quit()
    up.disableWebInstaller = true;
    // Another place to look, for testing updates.
    const from = process.env.CASPARCG_ADVANCED_UPDATES;
    if (from) up.setFeedURL({ provider: 'generic', url: from });
    up.on('error', () => undefined); // what goes wrong is also thrown to check()
    // Downloading a newer one throws away the one that was ready.
    up.on('update-available', (i) => this.set({ activity: 'downloading', percent: 0, ready: i.version === this.s.ready ? i.version : '' }));
    up.on('download-progress', (p) => { const percent = Math.floor(p.percent); if (percent !== this.s.percent) this.set({ percent }); });
    up.on('update-downloaded', (e) => {
      this.installer = e.downloadedFile;
      if (e.version === this.s.ready) return;
      this.set({ ready: e.version });
      this.h.log('info', `Version ${e.version} is ready to install`);
    });
    this.up = up;
    this.s.installed = true;
  }

  state(): UpdateState { return this.s; }
  private set(p: Partial<UpdateState>): void { this.s = { ...this.s, ...p }; this.h.changed(this.s); }

  /** Checks soon after starting, then every few hours, but not while something is on air: a download could get in its way. */
  start(): void {
    if (!this.up) return;
    const look = () => { if (this.h.automatic() && Date.now() - this.s.checked >= EVERY && !this.h.busy()) void this.check(); };
    setTimeout(look, 15e3); // playlists from before a restart are picked up first
    setInterval(look, 5 * 60e3);
  }

  /** Looks for a newer version and downloads it. */
  async check(): Promise<void> {
    if (!this.up || this.s.activity) return;
    this.set({ activity: 'checking', error: '' });
    let error = '';
    try {
      await (await this.up.checkForUpdates())?.downloadPromise;
    } catch (e) {
      const { code, message } = e as Error & { code?: string };
      const why = code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ? 'the latest release has no update files yet' : String(message).split('\n')[0].slice(0, 200);
      error = `${this.state().activity === 'downloading' ? 'The update could not be downloaded' : 'Could not check for updates'}: ${why}`;
      this.h.log('err', error);
      if (this.state().activity === 'downloading') this.set({ ready: '' });
    }
    this.set({ activity: '', checked: Date.now(), error });
  }

  /** The app is ending: have the update installed as soon as it has. */
  quit(open: boolean): void {
    if (!this.up || !this.s.ready || !(open || this.h.automatic())) return;
    const f = files();
    fs.rmSync(f.reopen, { force: true });
    fs.writeFileSync(f.updating, JSON.stringify({ installer: this.installer, open, at: Date.now() }));
    // Always started again afterwards, in case the app was opened while it was being updated.
    if (this.up.install(!open, true)) return;
    fs.rmSync(f.updating, { force: true });
    if (open) app.relaunch();
  }
}

// ---- starting around an update ------------------------------------------------------------------------------
const files = () => ({ updating: path.join(app.getPath('userData'), 'updating.json'), reopen: path.join(app.getPath('userData'), 'updating.reopen') });

/** Windows does not let the file of a running program be opened for writing. */
function running(exe: string): boolean {
  try { fs.closeSync(fs.openSync(exe, 'r+')); return false; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

/**
 * Call first. False = exit straight away: an update has just been installed after quitting, or one is still being
 * installed (the installer ends any copy that is running, so the app opens when it has finished instead).
 */
export function mayStart(): boolean {
  const f = files();
  try {
    if (!fs.existsSync(f.updating)) return true;
    const u = JSON.parse(fs.readFileSync(f.updating, 'utf8')) as { installer: string; open: boolean; at: number };
    let open = true;
    if (process.argv.includes('--updated')) {
      // Opening the app right up until the installer ends counts as during the update.
      for (let i = 0; i < 50 && running(u.installer); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      open = u.open || fs.existsSync(f.reopen);
    } else if (Date.now() - u.at < 120e3 && running(u.installer)) { // an installer that is stuck must not keep the app from opening
      fs.writeFileSync(f.reopen, '');
      return false;
    }
    fs.rmSync(f.updating, { force: true });
    fs.rmSync(f.reopen, { force: true });
    return open;
  } catch { return true; } // opening the app matters more
}
