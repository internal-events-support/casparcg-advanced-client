// Screenshots of the app with real media on an isolated server. Run through hidden.py.
import fs from 'node:fs'
import path from 'node:path'
import { sleep, startApp, startServer, CG } from './lib.mjs'

const [dir, out] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })
const log = fs.createWriteStream(path.join(out, 'log.txt'))
const ud = path.join(dir, 'shots-' + process.pid)
fs.mkdirSync(ud, { recursive: true })
let id = 0
const base = (type, label, o = {}) => ({ id: 'x' + ++id, type, label, name: label, device: 'Localhost', channel: 1, layer: 10, delay: 0, duration: 0, allowGpi: false, allowRemote: false, remoteId: '', storyId: '', props: {}, ...o })
const mv = (n, ch = 2, o = {}) => base('MOVIE', n.split('/').pop(), { name: n, channel: ch, props: { transition: 'CUT', transitionDuration: 0, tween: 'Linear', direction: 'RIGHT', seek: 0, length: 0, loop: false, freezeonload: true, autoplay: false, triggeronnext: false }, ...o })
const pl = (label, clips, loop) => base('PLAYLIST', label, { channel: 2, expanded: true, items: clips.map((c) => mv(c)), props: { cgloop: loop ? 'Loop forever' : 'Stop on last', cgtransition: 'CUT', cgtransitionframes: 12, notes: '' } })
const items = [base('SEPARATOR', 'OPENING'), pl('Holding loop', ['CITY1', 'FILLER1', 'FILLER2', 'CITY2'], true), mv('QUESTION2', 2), mv('TECH1', 2), base('SEPARATOR', 'SESSION 1'), pl('Session VTs', ['MID1', 'MID2', 'WEBCAM1', 'WIDE1', 'QUESTION1'], false), Object.assign(pl('Panel VTs', ['TECH1', 'TECH2'], false), { props: { cgauto: false, cgloop: 'Stop on last', cgtransition: 'CUT', cgtransitionframes: 12, notes: '' } }),
	mv('LOWER THIRDS/LT001', 4, { label: 'LT Speaker one', layer: 20, allowRemote: true, remoteId: 'lt-1' }), mv('LOWER THIRDS/LT002', 4, { label: 'LT Speaker two', layer: 20, allowRemote: true, remoteId: 'lt-2' }), mv('RETENTION CUES/RQ001', 4, { label: 'Up next: Opening remarks', layer: 30 }),
	base('GROUP', 'Squeeze back', { expanded: true, props: { notes: '', autostep: false, autoplay: false }, items: [base('FILL', 'Shrink', { channel: 1, props: { positionx: 0.02, positiony: 0.02, scalex: 0.6, scaley: 0.6, transitionDuration: 25, tween: 'EaseOutCubic' } }), base('OPACITY', 'Dim', { channel: 1, props: { opacity: 0.6, transitionDuration: 25, tween: 'Linear' } })] }), base('FADETOBLACK', 'Fade Out', { channel: 1 }), base('CGTAKE', 'Take walk-in to programme', { props: { cgtfromchannel: 2, cgtfromlayer: 10, cgttochannel: 1, cgttolayer: 10, cgtmode: 'Fade', cgtframes: 25, cgtroll: true, cgthold: true } })]
fs.writeFileSync(path.join(ud, 'session.json'), JSON.stringify([{ id: 'd1', path: 'C:/Shows/Plenary day 1.xml', name: 'Plenary day 1', allowRemote: true, dirty: true, items }, { id: 'd2', path: 'C:/Shows/Backup.xml', name: 'Backup', allowRemote: true, dirty: false, items: [] }]))
let srv, app
try {
	srv = await startServer(path.join(dir, 'server2'), path.join(CG, 'media'))
	app = await startApp(ud, { devices: [{ name: 'Localhost', host: '127.0.0.1', port: 5350, preview: 0, shadow: false }], http: { enabled: true, port: 8131 }, osc: { enabled: true, port: 3351 }, countdown: { enabled: true, port: 8132, layer: 10, caution: 30, warn: 10, flash: 5 } })
	const p = await app.page('index.html')
	await p.send('Emulation.setDeviceMetricsOverride', { width: 1560, height: 960, deviceScaleFactor: 1, mobile: false })
	await sleep(5000)
	const http = async (u) => (await fetch('http://127.0.0.1:8131' + u)).text()
	const pick = (l) => p.ev(`(()=>{const r=[...document.querySelectorAll('.rd-row')].find(x=>x.querySelector('.rd-label').textContent===${JSON.stringify(l)});r.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))})()`)
	await p.shot(path.join(out, '0_idle.png'))
	log.write(await http('/playlist/2/load') + '\n'); await sleep(1500); log.write(await http('/take/2-10/1-10/cutplay') + '\n'); await sleep(700)
	log.write(await http('/playlist/1/load') + '\n'); await sleep(1500); await http('/item/lt-1/play'); await pick('MID1'); await sleep(3500); await p.key(' '); await sleep(1500)
	await p.shot(path.join(out, '1_rundown.png'))
	await pick('Session VTs'); await sleep(400); await p.shot(path.join(out, '2_playlist_selected.png')); await pick('MID1')
	await p.ev(`[...document.querySelectorAll('.topbar .segmented button')].find(b=>b.textContent==='Channels').click()`); await sleep(500)
	await p.shot(path.join(out, '8_channels.png'))
	await p.ev(`[...document.querySelectorAll('.ch-row .btn')].find(b=>b.textContent==='Take to…').click()`); await sleep(300)
	await p.shot(path.join(out, '9_take.png'))
	await p.ev(`document.querySelector('.popover-layer').dispatchEvent(new MouseEvent('mousedown'))`)
	await p.ev(`[...document.querySelectorAll('.topbar .segmented button')].find(b=>b.textContent==='Activity').click()`); for (let i = 0; i < 40; i++) await http('/layer/1-10/forward'); await p.ev(`vt.call('raw','Localhost','MIXER 1-10 FILL ' + '0.1 '.repeat(200))`); await sleep(600)
	await p.shot(path.join(out, '3_activity.png'))
	await p.ev(`[...document.querySelectorAll('.topbar .segmented button')].find(b=>b.textContent==='Rundown').click()`)
	await p.ev(`document.querySelector('.lib-tabs [title=Tools]').click()`); await pick('Shrink'); await sleep(500)
	await p.ev(`document.querySelector('.conn').click()`); await sleep(300)
	await p.shot(path.join(out, '4_tools.png'))
	await p.ev(`document.querySelector('.popover-layer').dispatchEvent(new MouseEvent('mousedown'))`)
	await p.ev(`vt.call('openSettings')`)
	const s = await app.page('settings.html'); await sleep(800)
	await s.shot(path.join(out, '5_settings.png'))
	await s.ev(`[...document.querySelectorAll('.s-tab')].find(b=>b.textContent==='Remote Control').click()`); await sleep(500)
	await s.shot(path.join(out, '6_remote.png'))
	await p.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 700, deviceScaleFactor: 1, mobile: false }); await sleep(600)
	await p.shot(path.join(out, '7_small.png'))
	log.write('errors ' + JSON.stringify([p.errors, s.errors]) + '\n')
	const ov = await p.ev(`[...document.querySelectorAll('*')].filter(e=>e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX==='visible'&&e.clientWidth>0&&!['HTML','BODY'].includes(e.tagName)).slice(0,12).map(e=>e.className+' '+e.scrollWidth+'>'+e.clientWidth)`)
	log.write('overflow at 1180: ' + JSON.stringify(ov) + '\n')
} catch (e) { log.write(e.stack + '\n') } finally { await app?.kill(); await srv?.stop(); log.end(); await sleep(300); process.exit(0) }
