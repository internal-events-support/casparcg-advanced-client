import { contextBridge, ipcRenderer } from 'electron';

const CHANNELS = ['docs', 'state', 'previewProgress', 'log', 'library', 'toast', 'settings', 'playout', 'rundown', 'askquit'];
contextBridge.exposeInMainWorld('vt', {
  call: (name: string, ...args: unknown[]) => ipcRenderer.invoke('vt', name, ...args),
  on: (name: string, fn: (...a: unknown[]) => void) => {
    if (CHANNELS.includes(name)) ipcRenderer.on(name, (_e, ...a) => fn(...a));
  },
});
