// Every tool of the original client (same types, property names and defaults as its XML), plus playlists.
import { uid, type Item } from './types';

export type PropKind = 'num' | 'int' | 'bool' | 'text' | 'area' | 'select' | 'color' | 'pct';
export interface Prop {
  key: string;
  label: string;
  kind: PropKind;
  def: string | number | boolean;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
}
export interface Tool {
  type: string;
  label: string;
  cat: 'Library' | 'Mixer' | 'Other' | 'Structure';
  icon: string;
  /** Row stripe colour. */
  color: string;
  props: Prop[];
  /** Output fields that make sense for this tool. */
  out: ('device' | 'channel' | 'layer' | 'delay' | 'duration')[];
  layer?: number;
  /** Editable name/value table. */
  data?: string;
  /** Uses item.name as a media/template name. */
  named?: 'MOVIE' | 'STILL' | 'AUDIO' | 'TEMPLATE';
  note?: string;
}

const TWEENS = ['Linear', 'EaseNone', ...['Quad', 'Cubic', 'Quart', 'Quint', 'Sine', 'Expo', 'Circ', 'Elastic', 'Back', 'Bounce'].flatMap((n) => [`EaseIn${n}`, `EaseOut${n}`, `EaseInOut${n}`, `EaseOutIn${n}`])];
const TRANSITIONS = ['CUT', 'MIX', 'PUSH', 'SLIDE', 'WIPE'];
export const BLENDS = ['Normal', 'Lighten', 'Darken', 'Multiply', 'Average', 'Add', 'Subtract', 'Difference', 'Negation', 'Exclusion', 'Screen', 'Overlay', 'Soft_Light', 'Hard_Light', 'Color_Dodge', 'Color_Burn', 'Linear_Dodge', 'Linear_Burn', 'Linear_Light', 'Vivid_Light', 'Pin_Light', 'Hard_Mix', 'Reflect', 'Glow', 'Phoenix', 'Contrast', 'Saturation', 'Color', 'Luminosity'];
export const FORMATS = ['PAL', 'NTSC', '576p2500', '720p2500', '720p5000', '720p5994', '720p6000', '1080i5000', '1080i5994', '1080i6000', '1080p2398', '1080p2400', '1080p2500', '1080p2997', '1080p3000', '1080p5000', '1080p5994', '1080p6000', '2160p2500', '2160p2997', '2160p5000', '2160p5994', '2160p6000'];

const P = (key: string, label: string, kind: PropKind, def: string | number | boolean, o: Partial<Prop> = {}): Prop => ({ key, label, kind, def, ...o });
const trans = (): Prop[] => [
  P('transition', 'Transition', 'select', 'CUT', { options: TRANSITIONS }),
  P('transitionDuration', 'Frames', 'int', 0, { min: 0, max: 5000 }),
  P('tween', 'Tween', 'select', 'Linear', { options: TWEENS }),
  P('direction', 'Direction', 'select', 'RIGHT', { options: ['RIGHT', 'LEFT'] }),
];
const anim = (): Prop[] => [
  P('transitionDuration', 'Frames', 'int', 0, { min: 0, max: 5000 }),
  P('tween', 'Tween', 'select', 'Linear', { options: TWEENS }),
  P('defer', 'Defer to Commit', 'bool', false),
];
const onNext = P('triggeronnext', 'Trigger on Next', 'bool', false);
const auto = P('useauto', 'Use Auto', 'bool', false);
const n = (key: string, label: string, def: number, min: number, max: number, step = 0.01): Prop => P(key, label, 'num', def, { min, max, step });
const ALL: Tool['out'] = ['device', 'channel', 'layer', 'delay', 'duration'];
const MIX: Tool['out'] = ['device', 'channel', 'layer', 'delay', 'duration'];
const mixer = (type: string, label: string, icon: string, props: Prop[], o: Partial<Tool> = {}): Tool => ({ type, label, cat: 'Mixer', icon, color: '#8a5a3c', out: MIX, props, ...o });

export const TOOLS: Tool[] = [
  // Library
  { type: 'AUDIO', label: 'Audio', cat: 'Library', icon: 'waveform', color: '#6b7a8c', out: ALL, layer: 30, named: 'AUDIO', props: [...trans(), P('loop', 'Loop', 'bool', false), auto, onNext] },
  { type: 'STILL', label: 'Image', cat: 'Library', icon: 'image', color: '#b8922f', out: ALL, named: 'STILL', props: [...trans(), auto, onNext] },
  { type: 'IMAGESCROLLER', label: 'Image Scroller', cat: 'Library', icon: 'layers', color: '#b8922f', out: ALL, named: 'STILL', props: [P('blur', 'Blur', 'int', 0, { min: 0, max: 100 }), P('speed', 'Speed', 'int', 8, { min: -100, max: 100 }), P('premultiply', 'Premultiply', 'bool', false), P('progressive', 'Progressive', 'bool', false)] },
  { type: 'TEMPLATE', label: 'Template', cat: 'Library', icon: 'template', color: '#6b8e23', out: ALL, layer: 20, named: 'TEMPLATE', data: 'templatedata', props: [P('flashlayer', 'Template layer', 'int', 1, { min: 0, max: 99 }), P('invoke', 'Invoke', 'text', ''), P('usestoreddata', 'Use stored data', 'bool', false), P('useuppercasedata', 'Uppercase data', 'bool', false), P('sendasjson', 'Send as JSON', 'bool', false), onNext] },
  { type: 'MOVIE', label: 'Video', cat: 'Library', icon: 'film', color: '#b9b06b', out: ALL, named: 'MOVIE', props: [...trans(), P('seek', 'Seek (frames)', 'int', 0, { min: 0, max: 9999999 }), P('length', 'Length (frames)', 'int', 0, { min: 0, max: 9999999 }), P('loop', 'Loop', 'bool', false), P('freezeonload', 'Freeze on load', 'bool', true), P('autoplay', 'Auto play', 'bool', false, { hint: 'Queue behind the clip that is playing' }), onNext] },

  // Mixer
  mixer('ANCHOR', 'Anchor Point', 'pin', [n('positionx', 'X', 0, -10, 10), n('positiony', 'Y', 0, -10, 10), ...anim(), onNext]),
  mixer('BLENDMODE', 'Blend Mode', 'layers', [P('blendmode', 'Blend mode', 'select', 'Normal', { options: BLENDS })]),
  mixer('BRIGHTNESS', 'Brightness', 'sliders', [n('brightness', 'Brightness', 1, 0, 10), ...anim()]),
  mixer('CHROMAKEY', 'Chroma Key', 'eraser', [P('key', 'Key', 'select', 'None', { options: ['None', 'Green', 'Blue'] }), n('threshold', 'Threshold', 0.34, 0, 1), n('spread', 'Softness', 0.44, 0, 1), n('spill', 'Spill', 1, 0, 1)]),
  mixer('CLIP', 'Clipping', 'crop', [n('left', 'X', 0, -10, 10), n('top', 'Y', 0, -10, 10), n('width', 'Width', 1, 0, 10), n('height', 'Height', 1, 0, 10), ...anim()]),
  mixer('COMMIT', 'Commit', 'check', [], { out: ['device', 'channel', 'delay'] }),
  mixer('CONTRAST', 'Contrast', 'sliders', [n('contrast', 'Contrast', 1, 0, 10), ...anim()]),
  mixer('CROP', 'Crop', 'crop', [n('left', 'Left', 0, 0, 1), n('top', 'Top', 0, 0, 1), n('right', 'Right', 1, 0, 1), n('bottom', 'Bottom', 1, 0, 1), ...anim()]),
  mixer('PERSPECTIVE', 'Distort', 'crop', [n('upperleftx', 'Upper left X', 0, -10, 10), n('upperlefty', 'Upper left Y', 0, -10, 10), n('upperrightx', 'Upper right X', 1, -10, 10), n('upperrighty', 'Upper right Y', 0, -10, 10), n('lowerrightx', 'Lower right X', 1, -10, 10), n('lowerrighty', 'Lower right Y', 1, -10, 10), n('lowerleftx', 'Lower left X', 0, -10, 10), n('lowerlefty', 'Lower left Y', 1, -10, 10), ...anim(), P('usemipmap', 'Mipmap', 'bool', false), onNext]),
  mixer('GRID', 'Grid', 'grid', [P('grid', 'Grid', 'int', 2, { min: 1, max: 10 }), ...anim()], { out: ['device', 'channel', 'delay', 'duration'] }),
  mixer('LEVELS', 'Levels', 'sliders', [n('minin', 'Min in', 0, 0, 1), n('maxin', 'Max in', 1, 0, 1), n('gamma', 'Gamma', 1, 0, 10), n('minout', 'Min out', 0, 0, 1), n('maxout', 'Max out', 1, 0, 1), ...anim()]),
  mixer('KEYER', 'Mask', 'keyer', [P('defer', 'Defer to Commit', 'bool', false)]),
  mixer('OPACITY', 'Opacity', 'eye', [n('opacity', 'Opacity', 1, 0, 1), ...anim(), onNext]),
  mixer('RESET', 'Reset', 'refresh', [], { out: ['device', 'channel', 'layer', 'delay'] }),
  mixer('ROTATION', 'Rotation', 'rotate', [n('rotation', 'Degrees', 0, -3600, 3600, 1), ...anim()]),
  mixer('SATURATION', 'Saturation', 'palette', [n('saturation', 'Saturation', 1, 0, 10), ...anim()]),
  mixer('FILL', 'Transform', 'share', [n('positionx', 'X', 0, -10, 10), n('positiony', 'Y', 0, -10, 10), n('scalex', 'Width', 1, -10, 10), n('scaley', 'Height', 1, -10, 10), ...anim(), P('usemipmap', 'Mipmap', 'bool', false), onNext]),
  mixer('VOLUME', 'Volume', 'speaker', [n('volume', 'Volume', 1, 0, 10), P('mastervolume', 'Channel master volume', 'bool', false), ...anim(), onNext]),

  // Other
  { type: 'PRINT', label: 'Channel Snapshot', cat: 'Other', icon: 'preview', color: '#b8922f', out: ['device', 'channel', 'delay'], props: [P('output', 'File name', 'text', '')] },
  { type: 'CLEAROUTPUT', label: 'Clear Output', cat: 'Other', icon: 'eraser', color: '#b8922f', out: ['device', 'channel', 'layer', 'delay'], props: [P('clearchannel', 'Clear whole channel', 'bool', false), onNext] },
  { type: 'CUSTOMCOMMAND', label: 'Custom Command', cat: 'Other', icon: 'terminal', color: '#5f7386', out: ['device', 'delay', 'duration'], props: [...['play', 'stop', 'load', 'pause', 'next', 'update', 'invoke', 'preview', 'clear', 'clearVideolayer', 'clearChannel'].map((k) => P(`${k}Command`, { clearVideolayer: 'Clear layer', clearChannel: 'Clear channel' }[k] ?? k[0].toUpperCase() + k.slice(1), 'text', '')), onNext] },
  { type: 'DECKLINKINPUT', label: 'DeckLink Input', cat: 'Other', icon: 'inbox', color: '#2e8b57', out: ALL, props: [P('device', 'DeckLink device', 'int', 2, { min: 1, max: 64 }), P('format', 'Format', 'select', 'PAL', { options: FORMATS }), ...trans()] },
  { type: 'CGTAKE', label: 'Channel Take', cat: 'Other', icon: 'cut', color: '#c0504d', out: ['device', 'delay'], props: [P('cgtfromchannel', 'From channel', 'int', 1, { min: 1, max: 99 }), P('cgtfromlayer', 'From layer', 'int', 10, { min: 0, max: 9998 }), P('cgttochannel', 'To channel', 'int', 2, { min: 1, max: 99 }), P('cgttolayer', 'To layer', 'int', 10, { min: 0, max: 9998 }), P('cgtmode', 'Type', 'select', 'Cut', { options: ['Cut', 'Fade'] }), P('cgtframes', 'Fade frames', 'int', 25, { min: 1, max: 500 }), P('cgtroll', 'Play when taken', 'bool', false), P('cgthold', 'Pause what comes off', 'bool', true, { hint: 'The two layers swap places. This pauses the clip that was there before.' })] },
  { type: 'FADETOBLACK', label: 'Fade Out', cat: 'Other', icon: 'fade', color: '#b8922f', out: ALL, props: [P('transition', 'Transition', 'select', 'MIX', { options: TRANSITIONS }), P('transitionDuration', 'Frames', 'int', 12, { min: 0, max: 5000 }), P('tween', 'Tween', 'select', 'Linear', { options: TWEENS }), P('direction', 'Direction', 'select', 'RIGHT', { options: ['RIGHT', 'LEFT'] }), auto, onNext] },
  { type: 'FILERECORDER', label: 'File Recorder', cat: 'Other', icon: 'record', color: '#8c3a3a', out: ['device', 'channel', 'delay', 'duration'], props: [P('output', 'File name', 'text', 'Output.mxf'), P('codec', 'Codec', 'select', 'dnxhd', { options: ['dnxhd', 'h264'] }), P('preset', 'Arguments', 'area', '-codec:v dnxhd -b:v 120M -flags:v +ilme+ildct -threads:v 4 -filter:v format=yuv422p,interlace'), P('withalpha', 'Separate key', 'bool', false)] },
  { type: 'GPIOUTPUT', label: 'GPI Output', cat: 'Other', icon: 'bolt', color: '#a0522d', out: ['delay'], props: [P('gpoport', 'GPO port', 'int', 0, { min: 0, max: 7 }), onNext], note: 'Kept in files, but this app has no serial GPI support, so it does nothing when played.' },
  { type: 'HTML', label: 'HTML Page', cat: 'Other', icon: 'globe', color: '#2e8b57', out: ALL, props: [P('url', 'URL', 'text', ''), ...trans(), P('freezeonload', 'Freeze on load', 'bool', false), auto, onNext] },
  { type: 'HTTPGET', label: 'HTTP GET Request', cat: 'Other', icon: 'externalLink', color: '#55702f', out: ['delay'], data: 'httpdata', props: [P('url', 'URL', 'text', ''), onNext] },
  { type: 'HTTPPOST', label: 'HTTP POST Request', cat: 'Other', icon: 'externalLink', color: '#55702f', out: ['delay'], data: 'httpdata', props: [P('url', 'URL', 'text', ''), onNext] },
  { type: 'OSCOUTPUT', label: 'OSC Output', cat: 'Other', icon: 'osc', color: '#a0522d', out: ['delay'], props: [P('output', 'Target', 'text', '', { hint: 'Name of an OSC target from Settings' }), P('path', 'Path', 'text', ''), P('message', 'Value', 'text', ''), P('osctype', 'Type', 'select', 'String', { options: ['String', 'Bool', 'Int32', 'Float', 'Double', 'Int64'] }), P('usebundle', 'Send as bundle', 'bool', false), onNext] },
  { type: 'PLAYOUTCOMMAND', label: 'Playout Command', cat: 'Other', icon: 'play', color: '#5f7386', out: ['delay'], props: [P('playoutcommand', 'Command', 'select', 'Play', { options: ['Stop', 'Play', 'Play Now', 'Load', 'Pause / Resume', 'Next', 'Update', 'Invoke', 'Preview', 'Clear', 'Clear Video Layer', 'Clear Channel'] })] },
  { type: 'ROUTECHANNEL', label: 'Route Channel', cat: 'Other', icon: 'route', color: '#2e8b57', out: ALL, props: [P('fromchannel', 'From channel', 'int', 1, { min: 1, max: 64 }), P('outputdelay', 'Delay (frames)', 'int', 0, { min: 0, max: 500 })] },
  { type: 'ROUTEVIDEOLAYER', label: 'Route Video Layer', cat: 'Other', icon: 'route', color: '#2e8b57', out: ALL, props: [P('fromchannel', 'From channel', 'int', 1, { min: 1, max: 64 }), P('fromvideolayer', 'From layer', 'int', 10, { min: 0, max: 9999 }), P('outputdelay', 'Delay (frames)', 'int', 0, { min: 0, max: 500 })] },
  { type: 'SHELL', label: 'Shell Command', cat: 'Other', icon: 'terminal', color: '#8a8a8a', out: ['delay', 'duration'], props: [P('cgshell', 'Play runs', 'area', ''), P('cgshellstop', 'Stop runs', 'area', '', { hint: 'Stop also ends the Play command if it is still running' }), P('cgshelldir', 'Folder', 'text', '', { hint: 'Where the command runs. Empty = your user folder' })] },
  { type: 'SEPARATOR', label: 'Separator', cat: 'Other', icon: 'line', color: '#7a1f1f', out: [], props: [] },
  { type: 'SOLIDCOLOR', label: 'Solid Color', cat: 'Other', icon: 'palette', color: '#b8922f', out: ALL, props: [P('solidcolor', 'Colour', 'color', '#FF000000'), ...trans(), auto, onNext] },

  // Structure
  { type: 'GROUP', label: 'Group', cat: 'Structure', icon: 'folder', color: '#4673c3', out: ['duration'], props: [P('notes', 'Notes', 'area', ''), P('autostep', 'Auto step', 'bool', false, { hint: 'Select the next item after playing' }), P('autoplay', 'Auto play', 'bool', false, { hint: 'Play the videos one after another' })] },
  { type: 'PLAYLIST', label: 'Playlist', cat: 'Structure', icon: 'playlist', color: '#bf5af2', out: ['device', 'channel', 'layer'], props: [P('cgauto', 'Play next automatically', 'bool', true, { hint: 'Off: each clip holds on its last frame until you press Next (F5)' }), P('cgloop', 'After the last clip', 'select', 'Stop on last', { options: ['Stop on last', 'Loop forever'] }), P('cgtransition', 'Between clips', 'select', 'CUT', { options: ['CUT', 'MIX'] }), P('cgtransitionframes', 'Mix frames', 'int', 12, { min: 1, max: 250 }), P('notes', 'Notes', 'area', '')] },
];

const BY_TYPE = new Map(TOOLS.map((t) => [t.type, t]));
export const tool = (type: string): Tool => BY_TYPE.get(type) ?? { type, label: type, cat: 'Other', icon: 'warn', color: '#555', out: [], props: [] };
export const isContainer = (i: Item) => i.type === 'GROUP' || i.type === 'PLAYLIST';
export const isPlaylist = (i: Item) => i.type === 'PLAYLIST';

export function newItem(type: string, o: Partial<Item> = {}): Item {
  const t = tool(type);
  const props: Item['props'] = {};
  for (const p of t.props) props[p.key] = p.def;
  return {
    id: uid(), type, label: t.label, name: t.label, device: '', channel: 1, layer: t.layer ?? 10, delay: 0, duration: 0,
    allowGpi: false, allowRemote: false, remoteId: '', storyId: '', ...(t.data ? { data: [] } : {}),
    ...(type === 'GROUP' || type === 'PLAYLIST' ? { items: [], expanded: true } : {}), ...o, props: { ...props, ...(o.props ?? {}) },
  };
}

/** Deep copy with fresh ids. */
export function cloneItem(i: Item): Item {
  return { ...structuredClone(i), id: uid(), ...(i.items ? { items: i.items.map(cloneItem) } : {}) };
}

export function walk(items: Item[], fn: (i: Item, parent: Item | null) => void, parent: Item | null = null): void {
  for (const i of items) {
    fn(i, parent);
    if (i.items) walk(i.items, fn, i);
  }
}
export function findItem(items: Item[], id: string): { item: Item; parent: Item | null } | null {
  let hit: { item: Item; parent: Item | null } | null = null;
  walk(items, (item, parent) => { if (item.id === id) hit = { item, parent }; });
  return hit;
}
