// Rundown files and tool commands, without a server.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, checker } from './lib.mjs'

const out = path.join(ROOT, 'dist/test')
for (const f of ['shared/xml', 'shared/tools', 'main/commands', 'main/osc']) execFileSync(process.execPath, [path.join(ROOT, 'node_modules/esbuild/bin/esbuild'), path.join(ROOT, `src/${f}.ts`), '--bundle', '--platform=node', '--format=esm', `--outfile=${path.join(out, path.basename(f))}.mjs`, '--log-level=error'])
const imp = (n) => import(pathToFileURL(path.join(out, n + '.mjs')))
const { parseRundown, writeRundown } = await imp('xml')
const { TOOLS, newItem } = await imp('tools')
const { commandsFor, qChecksum } = await imp('commands')
const osc = await imp('osc')
const c = checker()
const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'id' ? undefined : v)))

// Every tool survives a save and reload.
const all = TOOLS.map((t) => newItem(t.type, { label: `A & <b> "${t.label}"`, name: 'DIR/clip, one', device: 'Localhost', channel: 3, layer: 12, delay: 250, duration: 4000, allowRemote: true, remoteId: 'r1', storyId: 's', color: '#4673c3', ...(t.data ? { data: [{ key: 'f0', value: 'x < y & "z"' }] } : {}), ...(t.type === 'GROUP' || t.type === 'PLAYLIST' ? { name: t.label, items: [newItem('MOVIE', { name: 'a', label: 'a', props: { autoplay: true } })], expanded: false } : {}) }))
const xml = writeRundown(all, true)
const back = parseRundown(xml)
c.ok('tool count (39 original tools, group, playlist, channel take)', TOOLS.length === 42, TOOLS.length)
for (const [i, t] of TOOLS.entries()) {
	const a = strip(all[i])
	if (t.type === 'GROUP' || t.type === 'PLAYLIST') { a.name = back.items[i].name; if (t.type === 'GROUP') a.device = back.items[i].device }
	c.ok(`round trip ${t.type}`, JSON.stringify(strip(back.items[i])) === JSON.stringify(a) || JSON.stringify(Object.entries(strip(back.items[i])).sort()) === JSON.stringify(Object.entries(a).sort()), [strip(back.items[i]), a])
}
c.ok('a playlist that waits survives a save; older files play on', parseRundown(writeRundown([newItem('PLAYLIST', { props: { cgauto: false } })], true)).items[0].props.cgauto === false && parseRundown('<items><item><type>GROUP</type><cgplaylist>true</cgplaylist><items></items></item></items>').items[0].props.cgauto === true)
c.ok('remote flag kept', back.allowRemote)
c.ok('playlist saved as a group the original understands', /<type>GROUP<\/type>[\s\S]*<autoplay>true<\/autoplay>[\s\S]*<cgplaylist>true/.test(xml) && !/<type>PLAYLIST/.test(xml))
const desk = path.join(os.homedir(), 'Desktop/CasparCG VT rundown.xml')
if (fs.existsSync(desk)) { const d = parseRundown(fs.readFileSync(desk, 'utf8')); c.ok('opens the desktop rundown, 94 items', d.items.length === 94, d.items.length) }
const un = parseRundown('<?xml version="1.0"?><items><item><type>MOVIE</type><name>x</name><mystery>7</mystery><transtitionDuration>9</transtitionDuration></item></items>')
c.ok('unknown tags are kept, old spelling is read', un.items[0].extra?.mystery === '7' && un.items[0].props.transitionDuration === 9, un.items[0])
for (const bad of ['', '<items>', '<x></x>', '<items><item></items>', 'hello']) { let threw = false; try { parseRundown(bad) } catch { threw = true } c.ok(`refuses broken file ${JSON.stringify(bad)}`, threw) }

// Commands match the original client's strings.
const cmd = (type, a, o = {}, run = { loaded: false, paused: false }) => commandsFor(newItem(type, { channel: 1, layer: 10, name: 'CLIP', ...o }), a, run).join(' | ')
const eq = (n, got, want) => c.ok(n, got === want, { got, want })
eq('movie play', cmd('MOVIE', 'play'), 'PLAY 1-10 "CLIP" CUT 0 Linear RIGHT')
eq('movie play options', cmd('MOVIE', 'play', { props: { transition: 'MIX', transitionDuration: 25, seek: 50, length: 100, loop: true } }), 'PLAY 1-10 "CLIP" MIX 25 Linear RIGHT SEEK 50 LENGTH 100 LOOP')
eq('movie load frozen', cmd('MOVIE', 'load'), 'LOAD 1-10 "CLIP" CUT 0 Linear RIGHT')
eq('movie load background', cmd('MOVIE', 'load', { props: { freezeonload: false } }), 'LOADBG 1-10 "CLIP" CUT 0 Linear RIGHT')
eq('movie loaded then play', cmd('MOVIE', 'play', {}, { loaded: true, paused: false }), 'PLAY 1-10')
eq('movie auto', cmd('MOVIE', 'play', { props: { autoplay: true } }), 'LOADBG 1-10 "CLIP" CUT 0 Linear RIGHT AUTO')
eq('movie pause', cmd('MOVIE', 'pause'), 'PAUSE 1-10')
eq('movie resume', cmd('MOVIE', 'pause', {}, { loaded: false, paused: true }), 'RESUME 1-10')
eq('stop', cmd('MOVIE', 'stop'), 'STOP 1-10')
eq('clear channel', cmd('STILL', 'clearChannel'), 'CLEAR 1 | MIXER 1 CLEAR')
eq('quotes are escaped', cmd('MOVIE', 'play', { name: 'a "b" \\c\r\nKILL' }), 'PLAY 1-10 "a \\"b\\" \\\\c KILL" CUT 0 Linear RIGHT')
eq('audio', cmd('AUDIO', 'play', { props: { loop: true } }), 'PLAY 1-10 "CLIP" CUT 0 Linear RIGHT LOOP')
eq('still', cmd('STILL', 'play'), 'PLAY 1-10 "CLIP" CUT 0 Linear RIGHT')
eq('scroller', cmd('IMAGESCROLLER', 'play', { props: { progressive: true } }), 'PLAY 1-10 "CLIP" BLUR 0 SPEED 8 PROGRESSIVE')
eq('template play', cmd('TEMPLATE', 'play', { layer: 20, data: [{ key: 'f0', value: 'A & B' }] }), 'CG 1-20 ADD 1 "CLIP" 1 "<templateData><componentData id=\\"f0\\"><data id=\\"text\\" value=\\"A &amp; B\\"/></componentData></templateData>"')
eq('template json', cmd('TEMPLATE', 'update', { layer: 20, data: [{ key: 'f0', value: 'A' }], props: { sendasjson: true } }), 'CG 1-20 UPDATE 1 "{\\"f0\\":\\"A\\"}"')
eq('template stop', cmd('TEMPLATE', 'stop', { layer: 20 }), 'CG 1-20 STOP 1')
eq('template invoke', cmd('TEMPLATE', 'invoke', { layer: 20, props: { invoke: 'go' } }), 'CG 1-20 INVOKE 1 "go"')
eq('template clear', cmd('TEMPLATE', 'clear', { layer: 20 }), 'CG 1-20 REMOVE 1')
eq('opacity', cmd('OPACITY', 'play', { props: { opacity: 0.5, transitionDuration: 25, tween: 'EaseInQuad', defer: true } }), 'MIXER 1-10 OPACITY 0.5 25 EaseInQuad DEFER')
eq('opacity stop resets', cmd('OPACITY', 'stop'), 'MIXER 1-10 OPACITY 1')
eq('fill', cmd('FILL', 'play', { props: { positionx: 0.25, scalex: 0.5 } }), 'MIXER 1-10 MIPMAP 0 | MIXER 1-10 FILL 0.25 0 0.5 1')
eq('levels', cmd('LEVELS', 'play', { props: { gamma: 1.5 } }), 'MIXER 1-10 LEVELS 0 1 1.5 0 1')
eq('chroma', cmd('CHROMAKEY', 'play', { props: { key: 'Green' } }), 'MIXER 1-10 CHROMA Green 0.34 0.44 1')
eq('perspective', cmd('PERSPECTIVE', 'play'), 'MIXER 1-10 MIPMAP 0 | MIXER 1-10 PERSPECTIVE 0 0 1 0 1 1 0 1')
eq('grid', cmd('GRID', 'play'), 'MIXER 1 GRID 2 0 Linear')
eq('mask', cmd('KEYER', 'play'), 'MIXER 1-10 KEYER 1')
eq('commit', cmd('COMMIT', 'play'), 'MIXER 1 COMMIT')
eq('reset', cmd('RESET', 'play'), 'MIXER 1-10 CLEAR')
eq('print', cmd('PRINT', 'play', { props: { output: 'shot' } }), 'ADD 1 IMAGE "shot"')
eq('decklink', cmd('DECKLINKINPUT', 'play', { props: { device: 3, format: '1080i5000' } }), 'PLAY 1-10 DECKLINK DEVICE 3 FORMAT 1080i5000 CUT 0 Linear RIGHT')
eq('route channel', cmd('ROUTECHANNEL', 'play', { props: { fromchannel: 2, outputdelay: 5 } }), 'PLAY 1-10 route://2 FRAMES_DELAY 5')
eq('route layer', cmd('ROUTEVIDEOLAYER', 'load', { props: { fromchannel: 2, fromvideolayer: 7 } }), 'LOADBG 1-10 route://2-7')
eq('solid colour is premultiplied', cmd('SOLIDCOLOR', 'play', { props: { solidcolor: '#80FF0000' } }), 'PLAY 1-10 "#80800000" CUT 0 Linear RIGHT')
eq('fade out', cmd('FADETOBLACK', 'play'), 'PLAY 1-10 "#FF000000" MIX 12 Linear RIGHT')
eq('html', cmd('HTML', 'play', { props: { url: 'http://x/?a=1' } }), 'PLAY 1-10 [HTML] "http://x/?a=1" CUT 0 Linear RIGHT')
eq('custom', cmd('CUSTOMCOMMAND', 'stop', { props: { stopCommand: 'CLEAR 4' } }), 'CLEAR 4')
eq('trigger on next', cmd('STILL', 'next', { props: { triggeronnext: true } }), 'PLAY 1-10 "CLIP" CUT 0 Linear RIGHT')
eq('recorder start and stop share an index', cmd('FILERECORDER', 'stop', { props: { output: 'a.mxf' } }), `REMOVE 1-${qChecksum('a.mxf')}`)
eq('Qt checksum', String(qChecksum('123456789')), String(0x906e))
for (const [t, v, want] of [['Int32', '7', 7], ['Float', '1.5', 1.5], ['String', 'héllo', 'héllo'], ['Bool', 'true', true], ['Int64', '9', 9], ['Double', '2.5', 2.5]]) for (const b of [false, true]) { let got; osc.decode(osc.encode('/a/b', v, t, b), (a, args) => (got = [a, args[0]])); c.ok(`osc ${t}${b ? ' bundle' : ''}`, got?.[0] === '/a/b' && got[1] === want, got) }
c.done()
