// Types shared by the main process and the renderer.

export type Action =
  | 'stop' | 'play' | 'playNow' | 'load' | 'pause' | 'next' | 'prev' | 'back' | 'forward' | 'update' | 'invoke' | 'preview'
  | 'clear' | 'clearLayer' | 'clearChannel';

export interface KV { key: string; value: string }

/** One rundown entry. `props` holds the tool-specific values, keyed exactly as in the original client's XML. */
export interface Item {
  id: string;
  type: string;
  label: string;
  name: string;
  device: string;
  channel: number;
  layer: number;
  delay: number;
  duration: number;
  allowGpi: boolean;
  allowRemote: boolean;
  remoteId: string;
  storyId: string;
  color?: string;
  props: Record<string, string | number | boolean>;
  data?: KV[];
  expanded?: boolean;
  items?: Item[];
  /** Tags this app does not know about, kept so files survive a round trip. */
  extra?: Record<string, string>;
}

export interface Doc {
  id: string;
  path: string;
  name: string;
  allowRemote: boolean;
  dirty: boolean;
  items: Item[];
}

/** A rundown and its change number. */
export interface DocPut { doc: Doc; rev: number }
export interface DocSync { revs: Record<string, number>; conflicts: DocPut[] }

export interface DeviceCfg {
  name: string;
  host: string;
  port: number;
  preview: number;
  shadow: boolean;
  /** Media scanner address for thumbnails; empty = port 8000 on the server. */
  scanner?: string;
  /** Folder on this PC (or a share) holding the server's media, for local preview. Empty = found automatically when the server is on this PC. */
  media?: string;
}

/** One layer on one server. */
export interface Loc { device: string; channel: number; layer: number }

export interface Settings {
  devices: DeviceCfg[];
  skipSeconds: number;
  /** ffmpeg.exe used to make preview copies of clips this PC cannot play directly. Empty = found automatically. */
  ffmpeg: string;
  compact: boolean;
  markUsed: boolean;
  autoStepPreview: boolean;
  confirmClear: boolean;
  /** Name of the sound output the local preview plays on. Empty = the Windows default. */
  previewOutput: string;
  /** Shell Command items may run programs on this PC. */
  allowShell: boolean;
  web: { enabled: boolean; port: number; lan: boolean; code: string };
  http: { enabled: boolean; port: number };
  osc: { enabled: boolean; port: number };
  countdown: { enabled: boolean; port: number; layer: number; caution: number; warn: number; flash: number };
  oscOutputs: { name: string; host: string; port: number }[];
  legacyConfig: string;
  recent: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  devices: [{ name: 'Localhost', host: '127.0.0.1', port: 5250, preview: 0, shadow: false }],
  skipSeconds: 5,
  ffmpeg: '',
  compact: false,
  markUsed: true,
  autoStepPreview: false,
  confirmClear: true,
  previewOutput: '',
  allowShell: false,
  web: { enabled: true, port: 8126, lan: false, code: '' },
  http: { enabled: true, port: 8125 },
  osc: { enabled: true, port: 3250 },
  countdown: { enabled: true, port: 8123, layer: 10, caution: 30, warn: 10, flash: 5 },
  oscOutputs: [],
  legacyConfig: '',
  recent: [],
};

export interface MediaEntry { name: string; type: 'MOVIE' | 'STILL' | 'AUDIO'; frames: number; fps: number; seconds: number; size: number; date: string }

export interface LayerState {
  producer: string;
  name: string;
  pos: number;
  start: number;
  end: number;
  paused: boolean;
  loop: boolean;
  next: string;
}

export interface DeviceState {
  name: string;
  connected: boolean;
  error: string;
  version: string;
  channels: string[];
  /** Frame rate of each channel, channel 1 first. */
  fps: number[];
}

/** A playlist that is loaded somewhere. It follows its layer through takes. */
export interface Deck {
  device: string;
  channel: number;
  layer: number;
  playlistId: string;
  label: string;
  index: number;
  count: number;
  loop: boolean;
  /** Holds on the last frame of each clip until Next. */
  manual?: boolean;
  queued: number | null;
  clip: string;
  resumed?: boolean;
}

export interface AppState {
  devices: DeviceState[];
  /** device|channel-layer → state */
  layers: Record<string, LayerState>;
  decks: Deck[];
  /** device|channel → linear peak per side */
  audio: Record<string, number[]>;
  /** item id → runtime flag */
  items: Record<string, { state: 'loaded' | 'playing' | 'paused' | ''; used: boolean }>;
  services: { http: string; osc: string; countdown: string; web: string };
  busy: boolean;
}

export interface LogLine { t: number; dir: 'out' | 'in' | 'info' | 'err'; device: string; text: string }

export interface Library {
  media: MediaEntry[];
  templates: string[];
  data: string[];
  presets: string[];
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const stem = (p: string) => p.replace(/\\/g, '/').split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase();
export const emptyLayer = (): LayerState => ({ producer: 'empty', name: '', pos: 0, start: 0, end: 0, paused: false, loop: false, next: '' });
