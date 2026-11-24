// What each tool sends for each playout action. Mirrors the original client command for command.
import type { Action, Item } from '../shared/types';

/** Quote a value for AMCP. */
export const q = (s: unknown) => `"${String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const word = (s: unknown) => String(s ?? '').replace(/[\r\n"\s]+/g, '');
const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const join = (...p: (string | number | false | undefined | '')[]) => p.filter((x) => x !== '' && x !== false && x !== undefined).join(' ');

function premultiplied(color: string): string {
  const h = color.replace('#', '').padStart(8, 'F').slice(-8);
  const [a, r, g, b] = [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
  return '#' + [a, (r * a) / 255, (g * a) / 255, (b * a) / 255].map((x) => Math.trunc(x).toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function templateData(i: Item): string {
  const kv = i.data ?? [];
  if (!kv.length) return '';
  const up = (s: string) => (i.props.useuppercasedata ? s.toUpperCase() : s);
  if (i.props.usestoreddata) return kv[0].value;
  if (i.props.sendasjson) return JSON.stringify(Object.fromEntries(kv.map((x) => [x.key, up(x.value)])));
  const x = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<templateData>${kv.map((d) => `<componentData id="${x(d.key)}"><data id="text" value="${x(up(d.value))}"/></componentData>`).join('')}</templateData>`;
}

/** CRC-16/ISO-3309, as Qt's qChecksum; the original uses it as the recorder's consumer index. */
export function qChecksum(s: string): number {
  let c = 0xffff;
  for (const b of Buffer.from(s, 'utf8')) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >> 1) ^ 0x8408 : c >> 1;
  }
  return ~c & 0xffff;
}

const trans = (p: Item['props']) => join(word(p.transition), num(p.transitionDuration), word(p.tween), word(p.direction));
const anim = (p: Item['props']) => join(num(p.transitionDuration) > 0 && num(p.transitionDuration), num(p.transitionDuration) > 0 && word(p.tween), !!p.defer && 'DEFER');

export interface Run { loaded: boolean; paused: boolean }

/** Commands for one item and action. Returns [] when the tool ignores that action. */
export function commandsFor(i: Item, a: Action, run: Run): string[] {
  const p = i.props;
  const ch = i.channel;
  const t = `${i.channel}-${i.layer}`;
  const producer = (play: string, load: string): string[] => {
    switch (a) {
      case 'play': case 'playNow': case 'update': return [run.loaded ? `PLAY ${t}` : play];
      case 'load': return [load];
      case 'stop': return [`STOP ${t}`];
      case 'pause': return [`${run.paused ? 'RESUME' : 'PAUSE'} ${t}`];
      case 'next': return p.triggeronnext ? [run.loaded ? `PLAY ${t}` : play] : [];
      case 'clear': case 'clearLayer': return [`CLEAR ${t}`];
      case 'clearChannel': return [`CLEAR ${ch}`, `MIXER ${ch} CLEAR`];
      default: return [];
    }
  };
  const mixer = (set: string[], reset: string[]): string[] => {
    if (a === 'play' || a === 'playNow' || a === 'update') return set;
    if (a === 'next') return p.triggeronnext ? set : [];
    if (a === 'stop') return reset;
    if (a === 'clear' || a === 'clearLayer') return [`MIXER ${t} CLEAR`];
    if (a === 'clearChannel') return [`CLEAR ${ch}`, `MIXER ${ch} CLEAR`];
    return [];
  };
  const m = (name: string, vals: (string | number)[], def: (string | number)[]) => mixer([join(`MIXER ${t} ${name}`, ...vals, anim(p))], [join(`MIXER ${t} ${name}`, ...def)]);
  const once = (c: string[]) => (a === 'play' || a === 'playNow' || a === 'update' || (a === 'next' && p.triggeronnext) ? c : []);

  switch (i.type) {
    case 'MOVIE': {
      const tail = join(trans(p), num(p.seek) > 0 && `SEEK ${num(p.seek)}`, num(p.length) > 0 && `LENGTH ${num(p.length)}`, !!p.loop && 'LOOP');
      // Auto play queues behind whatever is on the layer (and starts at once on an empty layer).
      const play = p.autoplay ? join('LOADBG', t, q(i.name), tail, 'AUTO') : join('PLAY', t, q(i.name), tail);
      if (a === 'playNow') return [join('PLAY', t, q(i.name), tail)];
      return producer(play, join(p.freezeonload ? 'LOAD' : 'LOADBG', t, q(i.name), tail));
    }
    case 'AUDIO': return producer(join('PLAY', t, q(i.name), trans(p), !!p.loop && 'LOOP'), join('LOADBG', t, q(i.name), trans(p), !!p.loop && 'LOOP', !!p.useauto && 'AUTO'));
    case 'STILL': return producer(join('PLAY', t, q(i.name), trans(p)), join('LOADBG', t, q(i.name), trans(p), !!p.useauto && 'AUTO'));
    case 'IMAGESCROLLER': {
      const s = join(q(i.name), 'BLUR', num(p.blur), 'SPEED', num(p.speed, 8), !!p.premultiply && 'PREMULTIPLY', !!p.progressive && 'PROGRESSIVE');
      return producer(`PLAY ${t} ${s}`, `LOADBG ${t} ${s}`);
    }
    case 'HTML': return producer(join('PLAY', t, '[HTML]', q(p.url), trans(p)), join(p.freezeonload ? 'LOAD' : 'LOADBG', t, '[HTML]', q(p.url), trans(p), !!p.useauto && 'AUTO'));
    case 'SOLIDCOLOR': { const c = q(premultiplied(String(p.solidcolor))); return producer(join('PLAY', t, c, trans(p)), join('LOADBG', t, c, trans(p), !!p.useauto && 'AUTO')); }
    case 'FADETOBLACK': { const c = q('#FF000000'); return producer(join('PLAY', t, c, trans(p)), join('LOADBG', t, c, trans(p), !!p.useauto && 'AUTO')); }
    case 'DECKLINKINPUT': { const s = join('DECKLINK DEVICE', num(p.device, 1), 'FORMAT', word(p.format), trans(p)); return producer(`PLAY ${t} ${s}`, `LOADBG ${t} ${s}`); }
    case 'ROUTECHANNEL': case 'ROUTEVIDEOLAYER': {
      const s = join(`route://${num(p.fromchannel, 1)}${i.type === 'ROUTEVIDEOLAYER' ? `-${num(p.fromvideolayer)}` : ''}`, num(p.outputdelay) > 0 && `FRAMES_DELAY ${num(p.outputdelay)}`);
      return producer(`PLAY ${t} ${s}`, `LOADBG ${t} ${s}`);
    }
    case 'TEMPLATE': {
      const fl = num(p.flashlayer, 1);
      const d = templateData(i);
      const cg = `CG ${t}`;
      switch (a) {
        case 'play': case 'playNow': return [run.loaded ? `${cg} PLAY ${fl}` : join(cg, 'ADD', fl, q(i.name), 1, d && q(d))];
        case 'load': return [join(cg, 'ADD', fl, q(i.name), 0, d && q(d))];
        case 'stop': return [`${cg} STOP ${fl}`];
        case 'next': return p.triggeronnext ? [join(cg, 'ADD', fl, q(i.name), 1, d && q(d))] : [`${cg} NEXT ${fl}`];
        case 'update': return d ? [`${cg} UPDATE ${fl} ${q(d)}`] : [];
        case 'invoke': return p.invoke ? [`${cg} INVOKE ${fl} ${q(p.invoke)}`] : [];
        case 'clear': return [`${cg} REMOVE ${fl}`];
        case 'clearLayer': return [`CLEAR ${t}`];
        case 'clearChannel': return [`CLEAR ${ch}`, `MIXER ${ch} CLEAR`];
        default: return [];
      }
    }
    case 'ANCHOR': return m('ANCHOR', [num(p.positionx), num(p.positiony)], [0, 0]);
    case 'BLENDMODE': return mixer([`MIXER ${t} BLEND ${word(p.blendmode)}`], [`MIXER ${t} BLEND Normal`]);
    case 'BRIGHTNESS': return m('BRIGHTNESS', [num(p.brightness, 1)], [1]);
    case 'CONTRAST': return m('CONTRAST', [num(p.contrast, 1)], [1]);
    case 'SATURATION': return m('SATURATION', [num(p.saturation, 1)], [1]);
    case 'OPACITY': return m('OPACITY', [num(p.opacity, 1)], [1]);
    case 'ROTATION': return m('ROTATION', [num(p.rotation)], [0]);
    case 'CHROMAKEY': return mixer([`MIXER ${t} CHROMA ${word(p.key)} ${num(p.threshold)} ${num(p.spread)} ${num(p.spill)}`], [`MIXER ${t} CHROMA None 0 0 0`]);
    case 'CLIP': return m('CLIP', [num(p.left), num(p.top), num(p.width, 1), num(p.height, 1)], [0, 0, 1, 1]);
    case 'CROP': return m('CROP', [num(p.left), num(p.top), num(p.right, 1), num(p.bottom, 1)], [0, 0, 1, 1]);
    case 'LEVELS': return m('LEVELS', [num(p.minin), num(p.maxin, 1), num(p.gamma, 1), num(p.minout), num(p.maxout, 1)], [0, 1, 1, 0, 1]);
    case 'KEYER': return mixer([join(`MIXER ${t} KEYER 1`, !!p.defer && 'DEFER')], [`MIXER ${t} KEYER 0`]);
    case 'VOLUME':
      if (p.mastervolume) return mixer([`MIXER ${ch} MASTERVOLUME ${num(p.volume, 1)}`], [`MIXER ${ch} MASTERVOLUME 1`]);
      return m('VOLUME', [num(p.volume, 1)], [1]);
    case 'FILL': return mixer([`MIXER ${t} MIPMAP ${p.usemipmap ? 1 : 0}`, join(`MIXER ${t} FILL`, num(p.positionx), num(p.positiony), num(p.scalex, 1), num(p.scaley, 1), anim(p))], [`MIXER ${t} FILL 0 0 1 1`]);
    case 'PERSPECTIVE': {
      const pts = ['upperleftx', 'upperlefty', 'upperrightx', 'upperrighty', 'lowerrightx', 'lowerrighty', 'lowerleftx', 'lowerlefty'].map((k) => num(p[k]));
      return mixer([`MIXER ${t} MIPMAP ${p.usemipmap ? 1 : 0}`, join(`MIXER ${t} PERSPECTIVE`, ...pts, anim(p))], [`MIXER ${t} PERSPECTIVE 0 0 1 0 1 1 0 1`]);
    }
    case 'GRID':
      if (a === 'stop') return [...Array(num(p.grid, 2) ** 2).keys()].map((k) => `MIXER ${ch}-${k + 1} CLEAR`);
      return once([join(`MIXER ${ch} GRID`, num(p.grid, 2), num(p.transitionDuration), word(p.tween), !!p.defer && 'DEFER')]);
    case 'COMMIT': return once([`MIXER ${ch} COMMIT`]);
    case 'RESET': return once([`MIXER ${t} CLEAR`]);
    case 'PRINT': return once([join(`ADD ${ch} IMAGE`, p.output && q(p.output))]);
    case 'CLEAROUTPUT': return once(p.clearchannel ? [`CLEAR ${ch}`, `MIXER ${ch} CLEAR`] : [`CLEAR ${t}`]);
    case 'FILERECORDER': {
      const id = qChecksum(String(p.output));
      if (a === 'stop' || a === 'clear' || a === 'clearLayer') return [`REMOVE ${ch}-${id}`];
      return once([join(`ADD ${ch}-${id} FILE`, q(p.output), String(p.preset ?? '').replace(/[\r\n]+/g, ' '), !!p.withalpha && 'SEPARATE_KEY')]);
    }
    case 'CUSTOMCOMMAND': {
      const key: Record<Action, string> = { play: 'play', playNow: 'play', stop: 'stop', load: 'load', pause: 'pause', next: 'next', prev: '', back: '', forward: '', update: 'update', invoke: 'invoke', preview: 'preview', clear: 'clear', clearLayer: 'clearVideolayer', clearChannel: 'clearChannel' };
      const v = String(p[`${a === 'next' && p.triggeronnext ? 'play' : key[a]}Command`] ?? '').trim();
      return v ? [v] : [];
    }
    default: return [];
  }
}

/** Preview (F8): the same item on the server's preview channel, held on its first frame. */
export function previewCommands(i: Item, channel: number): string[] {
  if (channel <= 0) return [];
  const c = { ...i, channel };
  if (i.type === 'MOVIE') return commandsFor({ ...c, props: { ...c.props, freezeonload: true } }, 'load', { loaded: false, paused: false });
  if (['STILL', 'HTML', 'SOLIDCOLOR', 'TEMPLATE', 'ROUTECHANNEL', 'ROUTEVIDEOLAYER'].includes(i.type) || i.type in MIXERS) return commandsFor(c, 'playNow', { loaded: false, paused: false });
  return [];
}
const MIXERS: Record<string, 1> = { ANCHOR: 1, BLENDMODE: 1, BRIGHTNESS: 1, CHROMAKEY: 1, CLIP: 1, COMMIT: 1, CONTRAST: 1, CROP: 1, PERSPECTIVE: 1, GRID: 1, LEVELS: 1, KEYER: 1, OPACITY: 1, RESET: 1, ROTATION: 1, SATURATION: 1, FILL: 1, VOLUME: 1 };
