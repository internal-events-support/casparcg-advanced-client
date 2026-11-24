// Drives the real app with real key presses against an isolated server. Run through hidden.py.
import dgram from 'node:dgram'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { CG, checker, sleep, startApp, startServer } from './lib.mjs'

const [dir, media, legacy, logFile] = process.argv.slice(2)
if (logFile) { const s = fs.createWriteStream(logFile); console.log = (...a) => s.write(a.join(' ') + '\n') }
fs.mkdirSync(dir, { recursive: true })
const ud = path.join(dir, 'userdata-' + process.pid)
const settings = { devices: [{ name: 'Localhost', host: '127.0.0.1', port: 5350, preview: 3, shadow: false }], http: { enabled: true, port: 8131 }, osc: { enabled: true, port: 3351 }, countdown: { enabled: true, port: 8132, layer: 10, caution: 30, warn: 10, flash: 5 }, oscOutputs: [{ name: 'me', host: '127.0.0.1', port: 7351 }], legacyConfig: legacy }
const c = checker()
let srv, app
try {
	srv = await startServer(path.join(dir, 'server'), media)
	const begin = srv.mark()
	app = await startApp(ud, settings)
	let p = await app.page('index.html')
	await sleep(4500)
	const http = async (u) => (await (await fetch('http://127.0.0.1:8131' + u)).text())
	// Layers 1-10 and 2-10 get short names; nothing in the app treats them specially.
	const st = async () => { const x = JSON.parse(await http('/status')); const at = (k) => ({ producer: 'empty', name: '', pos: 0, end: 0, ...x.layers[k], deck: x.layers[k]?.playlist }); return { ...x, at, one: at('1-10'), two: at('2-10') } }
	const take = (kind, from = '2-10', to = '1-10') => http(`/take/${from}/${to}/${kind}`)
	const until = async (f, ms = 4000) => { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await f(); if (v) return v; await sleep(80) } return v }
	const name = (l) => l.name.toLowerCase()
	c.ok('connects', (await st()).connected, app.output())
	c.ok('window has the whole layout', await p.ev(`['.topbar','.library','.preview','.rundown','.channels','.inspector','.statusbar'].every(s=>document.querySelector(s))`))
	c.ok('tabs', (await p.ev(`[...document.querySelectorAll('.topbar .segmented button')].map(b=>b.textContent).join()`)) === 'Edit,Show,Channels,Activity')
	c.ok('nothing left of a vision mixer', await p.ev(`!/\\b(PGM|PVW|Program|Programme)\\b/.test(document.body.innerText) && !document.querySelector('.monitors,.takes,canvas')`), await p.ev(`document.body.innerText`))

	// Build a rundown through the app's own XML import.
	const file = path.join(dir, 'show.xml')
	const mov = (n, ch, o = '') => `<item><type>MOVIE</type><devicename>Localhost</devicename><label>${n}</label><name>${n}</name><channel>${ch}</channel><videolayer>10</videolayer><delay>0</delay><duration>0</duration><transition>CUT</transition><transitionDuration>0</transitionDuration><tween>Linear</tween><direction>RIGHT</direction><freezeonload>true</freezeonload><autoplay>true</autoplay>${o}</item>`
	const grp = (n, kids, o = '', id = '') => `<item><type>GROUP</type><devicename>Localhost</devicename><label>${n}</label><expanded>true</expanded><channel>2</channel><videolayer>10</videolayer><allowremotetriggering>${!!id}</allowremotetriggering><remotetriggerid>${id}</remotetriggerid><autoplay>true</autoplay>${o}<items>${kids.join('')}</items></item>`
	const PL = '<cgplaylist>true</cgplaylist>'
	fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?><items><allowremotetriggering>true</allowremotetriggering>`
		+ grp('Loop', ['p1', 'p2', 'p3'].map((n) => mov(n, 2)), PL + '<cgloop>Loop forever</cgloop>', 'loop')
		+ grp('Ends', ['e1', 'e2', 'e3'].map((n) => mov(n, 2)), PL + '<cgloop>Stop on last</cgloop>', 'ends')
		+ grp('Plain group', ['e1', 'e2', 'e3'].map((n) => mov(n, 3)))
		+ mov('a1', 1).replace('<autoplay>true', '<autoplay>false') + `<item><type>OPACITY</type><devicename>Localhost</devicename><label>Half</label><channel>4</channel><videolayer>20</videolayer><delay>300</delay><duration>700</duration><opacity>0.5</opacity><allowremotetriggering>true</allowremotetriggering><remotetriggerid>half</remotetriggerid></item>`
		+ `<item><type>OSCOUTPUT</type><label>osc</label><output>me</output><path>/hello</path><message>5</message><osctype>Int32</osctype></item><item><type>CUSTOMCOMMAND</type><devicename>Localhost</devicename><label>custom</label><playCommand>MIXER 4-30 OPACITY 0.25</playCommand></item>${mov('pro', 1)}${mov('a2', 1)}</items>`)
	await p.ev(`vt.call('openPath', ${JSON.stringify(file)}).then(r => { window.__d = r.value; return r.ok })`)
	// Put it into the app the way File > Open does: through the recent list.
	await p.ev(`[...document.querySelectorAll('.rd-head .btn')].find(b=>b.textContent==='File').click()`)
	await sleep(200)
	await p.ev(`[...document.querySelectorAll('.menu button')].find(b=>b.textContent.includes('show')).click()`)
	await sleep(700)
	c.ok('rundown opens with all rows', (await p.ev(`document.querySelectorAll('.rd-row').length`)) === 18, [await p.ev(`[...document.querySelectorAll('.rd-label')].map(x=>x.textContent).join()`), fs.statSync(file).size, p.errors])
	const pick = (label, child = 0) => p.ev(`(()=>{const r=[...document.querySelectorAll('.rd-row')].filter(x=>x.querySelector('.rd-label').textContent===${JSON.stringify(label)})[${child}];r.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));return !!r})()`)
	const badge = (label, n = 0) => p.ev(`[...document.querySelectorAll('.rd-row')].filter(x=>x.querySelector('.rd-label').textContent===${JSON.stringify(label)})[${n}].querySelector('.rd-badge').textContent`)

	// --- playlists and takes by keyboard
	await pick('Loop'); await p.key('F3')
	let s = await until(async () => { const x = await st(); return x.two.name && x })
	c.ok('F3 loads playlist, paused on first frame', s && name(s.two) === 'p1' && s.two.paused && s.two.pos < 0.1 && s.two.deck === 'Loop', s)
	c.ok('row shows CUED', (await until(async () => (await badge('Loop')) === 'CUED')), await badge('Loop'))
	await sleep(800)
	c.ok('stays paused', (await st()).two.pos < 0.1)
	await p.key('F5'); s = await until(async () => { const x = await st(); return name(x.two) === 'p2' && x })
	c.ok('F5 next stays paused', !!s && s.two.paused && s.two.index === 2, s)
	await p.key('F5', { shift: true }); await p.key('F5', { shift: true }); s = await until(async () => { const x = await st(); return name(x.two) === 'p3' && x })
	c.ok('Shift+F5 previous wraps on a loop', !!s && s.two.index === 3, s)
	await take('cutplay'); s = await until(async () => { const x = await st(); return name(x.one) === 'p3' && !x.one.paused && x })
	c.ok('cut and play: playlist moves to channel 1', !!s && s.one.deck === 'Loop', s)
	const seen = []; let t0 = Date.now()
	while (Date.now() - t0 < 14000) { const x = await st(); const n = `${name(x.one)}:${x.one.index}`; if (seen.at(-1)?.split(':')[0] !== name(x.one)) seen.push(n); await sleep(100) }
	c.ok('loops forever after the take', seen.map((x) => x.slice(0, 2)).join().startsWith('p3,p1,p2,p3,p1'), seen)
	await pick('Ends'); await p.key('F3'); await until(async () => name((await st()).two) === 'e1')
	await take('fadeplay'); s = await until(async () => { const x = await st(); return name(x.one) === 'e1' && x.two.name && x }, 3000)
	c.ok('fade and play', !!s && !s.one.paused && s.one.deck === 'Ends' && s.two.deck === 'Loop' && s.two.paused, s)
	s = await until(async () => { const x = await st(); return name(x.one) === 'e3' && x.one.end - x.one.pos < 0.05 && x }, 13000)
	c.ok('stops on the last clip', !!s && s.one.index === 3, s)
	await sleep(2500); c.ok('still held on the last clip', name((await st()).one) === 'e3'); c.ok('row shows END', (await badge('Ends')) === 'END', await badge('Ends'))
	await take('cut'); s = await until(async () => { const x = await st(); return x.one.deck === 'Loop' && x })
	c.ok('cut arrives paused and swaps back', !!s && s.one.paused && s.two.deck === 'Ends', s)
	await take('fade'); s = await until(async () => { const x = await st(); return x.one.deck === 'Ends' && x }, 3000); c.ok('fade', !!s && s.two.deck === 'Loop', s)

	// --- transport in the Channels view
	const tab = (t) => p.ev(`[...document.querySelectorAll('.topbar .segmented button')].find(b=>b.textContent===${JSON.stringify(t)}).click()`)
	await tab('Channels'); await sleep(400)
	const chRow = (ch, layer = 10) => `[...document.querySelectorAll('.ch-card')][${ch - 1}].querySelectorAll('.ch-row')`
	const mon = (ch, title) => p.ev(`[...${chRow(ch)}].find(r=>r.querySelector('.ch-layer').textContent==='10').querySelector('[title^=${JSON.stringify(title)}]').click()`)
	c.ok('Channels lists every channel', (await p.ev(`document.querySelectorAll('.ch-card').length`)) === 4)
	c.ok('and names the playlist', await p.ev(`/Ends\\s+3\\/3/.test([...document.querySelectorAll('.ch-card')][0].textContent)`), await p.ev(`document.querySelector('.ch-body').innerText`))
	await mon(1, 'Stop'); c.ok('stop', await until(async () => (await st()).one.producer === 'empty'))
	c.ok('empty layer leaves the list', await until(() => p.ev(`${chRow(1)}.length===0`)))
	await http('/layer/1-10/play'); s = await until(async () => { const x = await st(); return x.one.producer !== 'empty' && x.one.pos > 0.2 && x }); c.ok('play after stop brings it back', !!s && s.one.deck === 'Ends', s)
	await srv.amcp('LOAD 2-10 a1'); await until(async () => name((await st()).two) === 'a1'); await sleep(400)
	await mon(2, 'Play'); await sleep(1200); await mon(2, 'Forward'); await sleep(600); s = await st(); c.ok('forward 5 s', s.two.pos > 5.5 && s.two.pos < 8, s.two.pos)
	await mon(2, 'Back'); await mon(2, 'Back'); await sleep(600); s = await st(); c.ok('back stops at the start', s.two.pos >= 0 && s.two.pos < 1.6, s.two.pos)
	for (let i = 0; i < 5; i++) { await mon(2, 'Forward'); await sleep(250) } s = await until(async () => { const x = await st(); return x.two.end - x.two.pos <= 0.04 && x }, 3000); await sleep(150); c.ok('forward stops at the end', !!s, (await st()).two)
	await mon(2, 'Play'); s = await until(async () => { const x = await st(); return x.two.pos < 3 && x.two.pos > 0.2 && x }); c.ok('play at the end starts again', !!s, (await st()).two)
	await mon(2, 'Stop'); await until(async () => (await st()).two.producer === 'empty'); await sleep(300)
	const keep = name((await st()).one); const refused = await take('cut'); await sleep(400); s = await st(); c.ok('a take from an empty layer is refused, and says why', name(s.one) === keep && s.one.producer !== 'empty' && /2-10 is empty/.test(refused), refused)

	// --- takes between any two channels
	await srv.amcp('PLAY 4-20 a1'); await srv.amcp('LOAD 3-30 a2'); await sleep(500); await tab('Channels')
	s = await st(); const onAir = name(s.one)
	await p.ev(`[...${chRow(3)}][0].querySelector('.btn').click()`); await sleep(250)
	await p.ev(`(()=>{const n=[...document.querySelectorAll('.tk .field.num')];n[1].value='20';n[1].dispatchEvent(new Event('change'));})()`)
	await p.ev(`(()=>{const s=document.querySelectorAll('.tk .popup select')[1];s.value='4';s.dispatchEvent(new Event('change'))})()`)
	await p.ev(`[...document.querySelectorAll('.tk .btn')].find(b=>b.textContent==='Take').click()`)
	s = await until(async () => { const x = await st(); return name(x.at('4-20')) === 'a2' && name(x.at('3-30')) === 'a1' && x.at('3-30').paused && x.at('4-20').paused && x })
	c.ok('take from the Channels view: 3-30 to 4-20', !!s && name(s.one) === onAir, (await st()).layers)
	c.ok('fade across layers and channels with its own length', /Fade 4-20 to 3-30/.test(await take('fadeplay/10', '4-20', '3-30')) && await until(async () => { const x = await st(); return name(x.at('3-30')) === 'a2' && !x.at('3-30').paused && name(x.at('4-20')) === 'a1' }), (await st()).layers)
	for (const [what, f, t, re] of [['the same layer', '1-10', '1-10', /different layers/], ['a channel that does not exist', '1-10', '9-10', /4 channels/], ['an empty layer', '4-77', '1-10', /empty/]]) { const r = await take('cut', f, t); c.ok('refuses ' + what, re.test(r), r) }
	await srv.amcp('PLAY 3-31 a3'); await sleep(400); const rf = await take('fade', '4-20', '3-30'); c.ok('refuses a fade with no free layer above', /layer 31/.test(rf), rf)
	await srv.amcp('CLEAR 3'); await srv.amcp('CLEAR 4'); await sleep(300)
	await tab('Edit')

	// --- editing a playlist while it plays
	await pick('Loop'); await p.key('F3'); await until(async () => name((await st()).two) === 'p1'); await take('cutplay'); await until(async () => !(await st()).one.paused && name((await st()).one) === 'p1')
	await sleep(600)
	let mk = srv.mark()
	await pick('p2'); await p.key('Delete'); await sleep(900)
	c.ok('removing the next clip re-queues', srv.sent(mk).some((x) => x === 'LOADBG 1-10 "p3" AUTO'), srv.sent(mk))
	s = await until(async () => { const x = await st(); return name(x.one) !== 'p1' && x }, 5000); c.ok('and the removed clip is skipped', name(s.one) === 'p3', s.one.name)
	await p.key('z', { ctrl: true }); await sleep(700); c.ok('undo puts it back', (await p.ev(`[...document.querySelectorAll('.rd-row')].some(r=>r.querySelector('.rd-label').textContent==='p2')`)))

	const flagsOf = (label) => p.ev(`[...[...document.querySelectorAll('.rd-row')].find(r=>r.querySelector('.rd-label').textContent===${JSON.stringify(label)}).querySelectorAll('.rd-flag')].map(f=>f.dataset.flag+['on','hold','off'].filter(x=>f.classList.contains(x)).map(x=>'.'+x).join('')).join()`)
	c.ok('icons on a looping playlist', (await flagsOf('Loop')) === 'autoNext.on,loop.on' && (await flagsOf('p1')) === 'autoNext' && (await flagsOf('p3')) === 'loop.on', [await flagsOf('Loop'), await flagsOf('p1'), await flagsOf('p3')])
	c.ok('icons on one that stops', (await flagsOf('Ends')) === 'autoNext.on,stopEnd', await flagsOf('Ends'))
	c.ok('icons on a group', (await flagsOf('Plain group')) === 'autoNext.on,autoStep.off', await flagsOf('Plain group'))
	// --- a playlist that waits for Next
	const prop = (label) => `[...document.querySelectorAll('.inspector .in-row')].find(x=>x.querySelector('label')?.textContent===${JSON.stringify(label)})`
	const flip = (label) => p.ev(`${prop(label)}.querySelector('.toggle, input, button').click()`)
	const oneOff = async () => (await st()).at('4-10')
	await srv.amcp('CLEAR 4'); await pick('Ends'); await sleep(200)
	const chan = (v) => p.ev(`(()=>{const i=${prop('Channel')}.querySelector('input');i.value='${v}';i.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
	await chan(4); await sleep(300); await flip('Play next automatically'); await sleep(400)
	c.ok('its icons and its clips say it waits', await until(async () => (await flagsOf('Ends')) === 'holdNext.hold,stopEnd' && (await flagsOf('e1')) === 'holdNext.hold' && (await flagsOf('e3')) === 'stopEnd'), [await flagsOf('Ends'), await flagsOf('e1'), await flagsOf('e3')])
	// Ends was still loaded on 2-10 from the tests above: free it, then load it fresh on channel 4.
	await pick('Ends'); await p.key('F1'); await srv.amcp('CLEAR 2'); await sleep(400); mk = srv.mark()
	await http('/playlist/2/load'); await until(async () => name(await oneOff()) === 'e1')
	if (name(await oneOff()) !== 'e1') c.ok('loads on its own channel', false, (await st()).layers)
	await pick('Ends'); await p.key('F2'); await sleep(5200); let w1 = await oneOff()
	c.ok('waits on the last frame of the first clip', name(w1) === 'e1' && w1.end - w1.pos < 0.05, w1)
	c.ok('and queues nothing on the server', !srv.sent(mk).some((x) => /^LOADBG/.test(x) && / 4-10 /.test(x)), srv.sent(mk))
	c.ok('row shows which clip Next will play', (await badge('e2')) === 'NEXT', await badge('e2'))
	await p.key('F5'); w1 = await until(async () => { const x = await oneOff(); return name(x) === 'e2' && x.pos > 0.2 && !x.paused && x }); c.ok('Next plays the next clip', !!w1, await oneOff())
	await sleep(4500); await p.key('F2'); w1 = await until(async () => { const x = await oneOff(); return name(x) === 'e3' && x.pos > 0.2 && x }); c.ok('Play while it waits also goes on to the next clip', !!w1, await oneOff())
	await sleep(4500); await p.key('F5'); await sleep(400); c.ok('and it stops on the last', name(await oneOff()) === 'e3')
	await http('/playlist/2/play'); await until(async () => name(await oneOff()) === 'e1'); await sleep(600); mk = srv.mark(); await flip('Play next automatically'); await sleep(700)
	c.ok('turning it back on while playing queues the next clip', srv.sent(mk).some((x) => x === 'LOADBG 4-10 "e2" AUTO'), srv.sent(mk))
	mk = srv.mark(); await flip('Play next automatically'); await sleep(700); await sleep(4500); w1 = await oneOff(); c.ok('turning it off while playing stops the queued clip', name(w1) === 'e1' && w1.end - w1.pos < 0.05, [w1, srv.sent(mk)])
	await flip('Play next automatically'); await sleep(600); await p.key('F1'); await sleep(300)
	await http('/playlist/2/play'); await until(async () => name(await oneOff()) === 'e1'); await pick('Ends'); await chan(3); await sleep(400); await http('/playlist/2/load'); await until(async () => name((await st()).at('3-10')) === 'e1'); await p.key('F5')
	c.ok('loaded twice: Next acts on the copy loaded last', await until(async () => { const x = await st(); return name(x.at('3-10')) === 'e2' && x.at('3-10').paused && name(x.at('4-10')) === 'e1' }), (await st()).layers)
	await srv.amcp('CLEAR 4'); await p.key('F1'); await srv.amcp('CLEAR 3'); await chan(4); await sleep(2500)

	// --- in and out marks inside a playlist
	await pick('e2', 0); await sleep(200)
	const numProp = (label, v) => p.ev(`(()=>{const i=${prop(label)}.querySelector('input');i.value='${v}';i.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
	await numProp('Seek (frames)', 25); await numProp('Length (frames)', 50); await sleep(400); mk = srv.mark()
	await http('/playlist/2/play'); await until(async () => name(await oneOff()) === 'e1'); await until(async () => name(await oneOff()) === 'e2', 6000); const tA = Date.now(); await until(async () => name(await oneOff()) === 'e3', 4000); const took = Date.now() - tA
	c.ok('a trimmed playlist clip is queued trimmed', srv.sent(mk).some((x) => x === 'LOADBG 4-10 "e2" SEEK 25 LENGTH 50 AUTO'), srv.sent(mk))
	c.ok('and plays for its trimmed length', took > 600 && took < 1600, [took, await oneOff(), srv.sent(mk)])
	await pick('e2', 0); await numProp('Seek (frames)', 0); await numProp('Length (frames)', 0)
	await pick('Ends'); await p.key('F1'); await chan(2); await sleep(400); await srv.amcp('CLEAR 4')

	// --- surviving a restart
	const before = await st()
	await app.kill()
	await sleep(600)
	app = await startApp(ud)
	p = await app.page('index.html')
	await until(async () => { try { return (await st()).connected } catch { return false } }, 12000)
	s = await until(async () => { const x = await st(); return x.one.deck === 'Loop' && x }, 6000)
	c.ok('reopening picks the playlist back up', !!s, [before.one, await st()])
	const after = []; t0 = Date.now()
	while (Date.now() - t0 < 11000) { const n = name((await st()).one); if (after.at(-1) !== n) after.push(n); await sleep(100) }
	c.ok('and it keeps looping', after.length >= 4, after)
	c.ok('rundown is still open after a restart', (await p.ev(`document.querySelectorAll('.rd-row').length`)) === 18)
	await sleep(500)

	// --- ordinary items and groups
	mk = srv.mark(); await pick('Plain group'); await p.key('F2'); await sleep(9800)
	let sent = srv.sent(mk).filter((x) => x.includes('3-10'))
	c.ok('auto play group plays every clip in order', /PLAY 3-10 "e1"/.test(sent[0]) && sent.some((x) => /LOADBG 3-10 "e2".*AUTO/.test(x)) && sent.some((x) => /LOADBG 3-10 "e3".*AUTO/.test(x)), sent)
	mk = srv.mark(); await pick('Half'); await p.key('F2'); await sleep(150); const at420 = () => srv.sent(mk).filter((x) => x.includes('4-20')); const early = at420().length; await sleep(1300); sent = at420()
	c.ok('delay and duration: plays late, stops by itself', early === 0 && sent[0] === 'MIXER 4-20 OPACITY 0.5' && sent[1] === 'MIXER 4-20 OPACITY 1', sent)
	mk = srv.mark(); await pick('custom'); await p.key('F2'); await sleep(400); c.ok('custom command', srv.sent(mk)[0] === 'MIXER 4-30 OPACITY 0.25', srv.sent(mk))
	const got = new Promise((ok) => { const u = dgram.createSocket('udp4').bind(7351, '127.0.0.1'); u.on('message', (b) => { u.close(); ok(b.toString('latin1')) }); setTimeout(() => ok(''), 3000) })
	await sleep(200); await pick('osc'); await p.key('F2'); c.ok('OSC output', (await got).startsWith('/hello'))
	mk = srv.mark(); await pick('a1'); await p.key('F8'); await sleep(500); c.ok('F8 preview uses the preview channel', srv.sent(mk)[0]?.startsWith('LOAD 3-10 "a1"'), srv.sent(mk))
	c.ok('used items are dimmed', await p.ev(`[...document.querySelectorAll('.rd-row')].find(r=>r.querySelector('.rd-label').textContent==='custom').classList.contains('used')`))

	// --- remote control
	mk = srv.mark(); await http('/item/half/playnow').catch(() => ''); await sleep(400); c.ok('HTTP triggers an item by remote ID', srv.sent(mk).some((x) => x.startsWith('MIXER 4-20 OPACITY 0.5')), srv.sent(mk))
	const pad = (x) => { const b = Buffer.from(x + '\0'); return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]) }
	const osc = (a, v = 1) => { const u = dgram.createSocket('udp4'); const i = Buffer.alloc(4); i.writeInt32BE(v); u.send(Buffer.concat([pad(a), pad(',i'), i]), 3351, '127.0.0.1', () => u.close()) }
	osc('/control/ends/load'); c.ok('OSC loads a playlist by remote ID', await until(async () => (await st()).two.deck === 'Ends'), await st())
	const w = (await st()).one.deck; osc('/control/take/2-10/1-10/cut', 0); await sleep(500); c.ok('an OSC button release does nothing', (await st()).one.deck === w)
	osc('/control/take/2-10/1-10/cutplay'); c.ok('OSC take', await until(async () => (await st()).one.deck === 'Ends'))
	c.ok('HTTP playlist by number', /Loop: load/.test(await http('/playlist/1/load')), await http('/playlist/1/load'))
	c.ok('a web page cannot trigger anything', (await fetch('http://127.0.0.1:8131/take/2-10/1-10/cut', { headers: { Origin: 'http://evil.example' } })).status === 403)
	c.ok('earlier controller URLs still work: clip', /PVW/.test(await http('/pvw/load/clip/1')) && !!(await until(async () => name((await st()).two) === 'a1')))
	c.ok('earlier controller URLs still work: playlist', /loop/.test(await http('/pvw/load/playlist/loop/2')) && !!(await until(async () => name((await st()).two) === 'p2')), await st())
	mk = srv.mark(); await http('/gfx/lt/1'); await sleep(400); c.ok('earlier controller URLs still work: graphics', srv.sent(mk).some((x) => x.startsWith('PLAY 4-20')), srv.sent(mk))
	await srv.amcp('PLAY 2-10 a1', 500); c.ok('earlier controller URLs still work: take', /2-10/.test(await http('/take/cutplay')) && !!(await until(async () => name((await st()).one) === 'a1')))
	osc('/control/layer/1-10/pause'); c.ok('OSC layer pause', await until(async () => (await st()).one.paused)); osc('/control/layer/1-10/play'); await until(async () => !(await st()).one.paused)
	const cd = await new Promise((ok) => { const ac = new AbortController(); fetch('http://127.0.0.1:8132/events?ch=1', { signal: ac.signal }).then(async (r) => { const v = new TextDecoder().decode((await r.body.getReader().read()).value); ac.abort(); ok(v) }, () => ok('')) })
	c.ok('countdown feed for the monitor overlays', /"status":"(play|end|cued|pause|loop)"/.test(cd), cd)

	// --- takes under stress, then frame by frame
	await srv.amcp('LOAD 1-10 a1'); await srv.amcp('LOAD 2-10 a2'); await sleep(700)
	const bad = []
	for (let i = 0; i < 24; i++) {
		const kind = ['cut', 'cutplay', 'fade', 'fadeplay'][i % 4]
		await http('/layer/1-10/play'); await http('/layer/1-10/back'); await http('/layer/2-10/back'); await sleep(120)
		const a = await st(); const t1 = Date.now(); await take(kind); const took = Date.now() - t1; await sleep(350); const b = await st()
		if (name(b.one) !== name(a.two) || name(b.two) !== name(a.one) || !b.two.paused || b.one.paused !== !kind.endsWith('play') || took > 1500) bad.push([i, kind, took, name(a.one), name(a.two), name(b.one), b.one.paused, name(b.two), b.two.paused])
	}
	c.ok('24 takes all swap and pause correctly, none slow', !bad.length, bad)
	await http('/layer/1-10/stop'); await http('/layer/2-10/stop'); await srv.amcp('LOAD 1-10 zred', 600); await srv.amcp('LOAD 2-10 zblue', 600)
	fs.rmSync(path.join(media, 'vtrec.mov'), { force: true })
	await srv.amcp('ADD 1 FILE vtrec.mov -codec:a pcm_s16le -codec:v libx264 -preset:v ultrafast -filter:v format=pix_fmts=yuv420p', 1200)
	await take('fadeplay'); await sleep(900); await take('cut'); await sleep(900); await srv.amcp('REMOVE 1 FILE vtrec.mov', 1800)
	const raw = execFileSync(path.join(CG, 'ffmpeg.exe'), ['-v', 'error', '-i', path.join(media, 'vtrec.mov'), '-vf', 'scale=1:1:flags=area,format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1e8 })
	const runs = []
	for (let i = 0; i + 2 < raw.length; i += 3) { const [r, , b] = [raw[i], 0, raw[i + 2]]; const d = r > 200 && b < 40 ? 'R' : b > 200 && r < 40 ? 'B' : r + b > 150 ? 'mix' : 'DARK'; if (runs.at(-1)?.[0] === d) runs.at(-1)[1]++; else runs.push([d, 1]) }
	while (runs[0]?.[0] === 'DARK') runs.shift(); while (runs.at(-1)?.[0] === 'DARK') runs.pop()
	c.ok('fade blends with no flash, then a clean cut', runs.map((x) => x[0]).join() === 'R,mix,B,R', runs)
	fs.rmSync(path.join(media, 'vtrec.mov'), { force: true })

	// --- Channel Take as a rundown item
	await srv.amcp('LOAD 3-10 a3'); await srv.amcp('CLEAR 4'); await sleep(400)
	await p.ev(`document.querySelector('.lib-tabs [title=Tools]').click()`); await sleep(200)
	await p.ev(`[...document.querySelectorAll('.library .lib-row, .library [draggable]')].find(r=>r.textContent.includes('Channel Take')).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`); await sleep(400)
	c.ok('Channel Take can be added from the tools', await p.ev(`[...document.querySelectorAll('.rd-row')].some(r=>/Channel Take/.test(r.textContent))`))
	const setProp = (label, v) => p.ev(`(()=>{const r=[...document.querySelectorAll('.inspector .group-row, .inspector .in-row')].find(x=>x.textContent.trim().startsWith(${JSON.stringify(label)}));const i=r?.querySelector('input');if(!i)return false;i.value=${JSON.stringify(v)};i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));i.blur();return true})()`)
	c.ok('its channels can be set', (await setProp('From channel', '3')) && (await setProp('To channel', '4')), await p.ev(`document.querySelector('.inspector').innerText`))
	await sleep(400); await p.key('F2'); s = await until(async () => { const x = await st(); return name(x.at('4-10')) === 'a3' && x.at('3-10').producer === 'empty' && x }); c.ok('F2 on a Channel Take moves 3-10 to 4-10', !!s, (await st()).layers)
	await srv.amcp('CLEAR 4')

	// --- local preview
	const pv = (x) => p.ev(`(()=>{const v=document.querySelector('video.pv-video');return (${x})})()`)
	await pick('pro'); c.ok('a ProRes clip gets a preview copy and shows a picture', await until(() => pv('!v.hidden&&v.readyState>=2&&v.videoWidth>0'), 20000), await p.ev(`document.querySelector('.preview').innerText`))
	const seekTo = (x) => p.ev(`(()=>{const v=document.querySelector('video.pv-video');return new Promise(r=>{v.onseeked=()=>{v.onseeked=null;r(true)};v.currentTime=${x}})})()`)
	await pick('a2'); await until(() => pv('!v.hidden&&v.readyState>=2&&Math.abs(v.duration-20)<0.5'), 8000)
	mk = srv.mark(); const before2 = JSON.stringify((await st()).layers)
	await p.key(' '); c.ok('Space plays the preview', await until(() => pv('!v.paused&&v.currentTime>0.4')), await pv('[v.paused,v.currentTime]'))
	await p.key(' '); c.ok('Space pauses it', await until(() => pv('v.paused')))
	await seekTo(2); const f0 = await pv('v.currentTime'); await p.ev(`document.querySelector('.preview [title="Forward one frame"]').click()`); await sleep(300); const f1 = await pv('v.currentTime'); c.ok('steps one frame', f1 > f0 && f1 - f0 < 0.05, [f0, f1])
	await seekTo(2); await p.ev(`[...document.querySelectorAll('.pv-marks .btn')].find(b=>b.textContent==='Set in').click()`); await seekTo(5); await p.ev(`[...document.querySelectorAll('.pv-marks .btn')].find(b=>b.textContent==='Set out').click()`); await sleep(700)
	c.ok('previewing sends the server nothing', srv.sent(mk).length === 0, srv.sent(mk))
	mk = srv.mark(); await p.key('F2'); await sleep(500); c.ok('marks are used when it plays on the server', srv.sent(mk).some((x) => /1-10 "a2".*SEEK 100 LENGTH 150/.test(x)), srv.sent(mk))
	await seekTo(4.5); await p.key(' '); c.ok('the preview stops at the out point', await until(() => pv('v.paused&&Math.abs(v.currentTime-5)<0.15')), await pv('[v.paused,v.currentTime]'))
	mk = srv.mark(); await p.ev(`document.querySelector('.lib-tabs [title=Media]').click()`); await sleep(300)
	const libName = await p.ev(`(()=>{const r=document.querySelector('.lib-row[data-name]');r.click();return r.dataset.name.split('/').pop()})()`); await sleep(500)
	c.ok('clicking a library clip previews it', (await p.ev(`document.querySelector('.pv-name').textContent`)) === libName && srv.sent(mk).length === 0, [libName, srv.sent(mk)])

	// --- Activity stays inside its panel
	await tab('Activity'); await p.ev(`vt.call('raw','Localhost','MIXER 1-10 FILL ' + '0.1 '.repeat(300))`); await sleep(500)
	const act = await p.ev(`(()=>{const l=document.querySelector('.s-log-list'),b=document.querySelector('.s-log-bar').getBoundingClientRect(),h=document.querySelector('.tabhost').getBoundingClientRect();return{rows:l.children.length,scrolls:l.scrollHeight>l.clientHeight,wide:l.scrollWidth-l.clientWidth,bar:b.bottom<=h.bottom+1&&b.right<=h.right+1&&b.top>h.top,end:l.scrollTop+l.clientHeight>l.scrollHeight-60}})()`)
	c.ok('Activity scrolls inside its panel with the command bar in view', act.rows > 60 && act.scrolls && act.wide <= 0 && act.bar && act.end, act)
	await tab('Edit')

	// --- saving
	const saved = await p.ev(`(async()=>{const d=JSON.parse(JSON.stringify((await vt.call('init')).value.docs[0]));d.path=${JSON.stringify(path.join(dir, 'saved.xml'))};const r=await vt.call('save',d,false);return r.ok})()`)
	const sx = fs.readFileSync(path.join(dir, 'saved.xml'), 'utf8'); c.ok('saves a file the original client can read', saved && (sx.match(/<type>GROUP<\/type>/g) || []).length === 3 && /<cgtake>true/.test(sx) && !/CGTAKE<\/type>/.test(sx) && (sx.match(/<cgplaylist>true/g) || []).length === 2 && !/PLAYLIST<\/type>/.test(sx))

	// --- server restart
	await srv.stop(); srv = null
	c.ok('notices the server going', await until(async () => !(await st()).connected, 6000))
	c.ok('says so on screen', await until(() => p.ev(`/Not connected/.test(document.querySelector('.statusbar').textContent)`), 8000))
	await pick('pro'); c.ok('preview works with the server off (copy already made)', await until(() => pv('!v.hidden&&v.readyState>=2'), 8000), await p.ev(`document.querySelector('.preview').innerText`))
	await pick('a1'); c.ok('preview works with the server off (plays directly)', await until(() => pv('!v.hidden&&v.readyState>=2&&Math.abs(v.duration-20)<0.5'), 8000)); await p.key(' '); c.ok('and plays', await until(() => pv('!v.paused&&v.currentTime>0.4'))); await p.key(' ')
	srv = await startServer(path.join(dir, 'server'), media)
	c.ok('reconnects by itself', await until(async () => (await st()).connected, 10000))
	c.ok('no errors in the window', p.errors.filter((e) => !/favicon/.test(e)).length === 0, p.errors)

	// --- closing while something plays
	c.ok('no test sent a stream or a screen to the server', !srv.sent(begin).some((x) => /STREAM|^ADD /.test(x) && !/vtrec/.test(x)), srv.sent(begin).filter((x) => /^ADD/.test(x)))
	await http('/playlist/1/play'); await until(async () => (await st()).two.pos > 0.2)
	execFileSync('python', ['-I', '-c', `import ctypes
from ctypes import wintypes as w
u=ctypes.windll.user32
def cb(h,l):
    b=ctypes.create_unicode_buffer(99); u.GetWindowTextW(h,b,99)
    if b.value=='CasparCG Client' and u.IsWindowVisible(h): u.PostMessageW(h,0x10,0,0)
    return True
u.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool,w.HWND,w.LPARAM)(cb),0)`]); await sleep(600)
	c.ok('closing during a playlist asks first', await until(() => p.ev(`/playlist is on air/i.test(document.querySelector('.sheet')?.textContent ?? '')`), 6000), await p.ev(`document.querySelector('.sheet')?.textContent`))
	await p.ev(`[...document.querySelectorAll('.sheet .btn')].find(b=>/Keep running/.test(b.textContent)).click()`); await sleep(500)
	const a0 = name((await st()).two); c.ok('keeps running hidden', !!(await until(async () => name((await st()).two) !== a0, 6000)))
} catch (e) {
	console.log('FAIL stopped early:', e.stack)
	c.fails.push('stopped early')
} finally {
	c.done()
	await app?.kill()
	await srv?.stop()
	await sleep(300)
	process.exit(0)
}
