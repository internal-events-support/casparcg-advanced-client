// The client in a browser, next to the app: node test/web.mjs <dir> <chrome.exe> <rundown.xml>
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { CG, checker, connect, sleep, startApp, startServer } from './lib.mjs'

const [dir, chrome, rundown] = process.argv.slice(2)
fs.mkdirSync(dir, { recursive: true })
const log = fs.createWriteStream(path.join(dir, 'log.txt'))
console.log = (...a) => log.write(a.join(' ') + '\n')
const c = checker()
const W = 'http://127.0.0.1:8136'
let srv, app, br
try {
	const home = path.join(dir, 'show' + process.pid); fs.mkdirSync(home, { recursive: true })
	const file = path.join(home, 'summit.xml'); fs.copyFileSync(rundown, file)
	const ch = '<channel><video-mode>720p5000</video-mode><consumers></consumers></channel>'
	srv = await startServer(path.join(dir, 'server'), path.join(CG, 'media'), ch.repeat(8))
	const ud = path.join(dir, 'ud' + process.pid)
	app = await startApp(ud, { devices: [{ name: 'Localhost', host: '127.0.0.1', port: 5350, preview: 0, shadow: false, media: path.join(CG, 'media') }], http: { enabled: true, port: 8131 }, osc: { enabled: true, port: 3351 }, countdown: { enabled: false, port: 8132, layer: 10, caution: 30, warn: 10, flash: 5 }, recent: [file] })
	const pc = await app.page('index.html')
	await pc.send('Emulation.setDeviceMetricsOverride', { width: 1560, height: 960, deviceScaleFactor: 1, mobile: false }); await sleep(4500)
	br = spawn(chrome, ['--headless=new', '--remote-debugging-port=9444', `--user-data-dir=${path.join(dir, 'chrome' + process.pid)}`, '--no-first-run', '--mute-audio', 'about:blank'], { stdio: 'ignore' })
	const tabs = async () => (await fetch('http://127.0.0.1:9444/json')).json()
	for (let i = 0; i < 40; i++) { try { await tabs(); break } catch { await sleep(300) } }
	const open = async (w = 1560, h = 960, mobile = false) => {
		const t = await (await fetch('http://127.0.0.1:9444/json/new?about:blank', { method: 'PUT' })).json()
		const p = await connect(t.webSocketDebuggerUrl)
		await p.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile })
		if (mobile) await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
		p.id = t.id
		return p
	}
	const go = async (p, u) => { await p.send('Page.navigate', { url: u }); await sleep(1500) }
	const until = async (f, t = 6000) => { const s = Date.now(); let v; while (Date.now() - s < t) { try { v = await f(); if (v) return v } catch {} await sleep(80) } return v }
	const front = (p) => p.send('Page.bringToFront') // a hidden tab puts off loading video
	const vis = (p, s) => p.ev(`[...document.querySelectorAll(${JSON.stringify(s)})].some(e=>e.offsetParent!==null)`)
	const click = (p, s, t) => p.ev(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(s)})].find(x=>x.offsetParent!==null&&(${JSON.stringify(t ?? null)}===null||x.textContent.trim()===${JSON.stringify(t ?? null)}));e?.click();return !!e})()`)
	const pick = (p, l) => p.ev(`(()=>{const r=[...document.querySelectorAll('.rd-row')].filter(x=>x.offsetParent!==null).find(x=>x.querySelector('.rd-label').textContent===${JSON.stringify(l)});r?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));return !!r})()`)
	const labels = (p) => p.ev(`[...document.querySelectorAll('.rundown.edit .rd-label')].map(e=>e.textContent)`)
	const setLabel = (p, v) => p.ev(`(()=>{const r=[...document.querySelectorAll('.inspector:not(.info) .in-row')].find(x=>x.querySelector('label')?.textContent==='Label');const i=r.querySelector('input');i.value=${JSON.stringify(v)};i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
	const tab = (p, t) => click(p, '.topbar .segmented button', t)
	const menu = async (p, t) => { await sleep(200); return click(p, '.menu button', t) }
	const raw = (body, o = {}) => fetch(W + '/call', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VT': '1', ...o }, body: JSON.stringify(body) })

	// --- signing in
	const a = await open(); await go(a, W)
	c.ok('asks for the code', await until(() => vis(a, '.login input')))
	c.ok('nothing without it', (await raw({ client: 'abcdefgh12', name: 'init', args: [] })).status === 401 && (await fetch(W + '/me')).status === 401 && (await fetch(W + '/events?c=abcdefgh12')).status === 401 && (await fetch(W + '/media/x')).status === 401)
	await a.ev(`(()=>{const i=document.querySelector('.login input');i.value='111111';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))})()`); c.ok('wrong code is refused', await until(() => a.ev(`document.querySelector('.login .bad').textContent==='Wrong code'`)))
	await a.ev(`(()=>{const i=document.querySelector('.login input');i.value='246810';document.querySelector('.login button').click()})()`); c.ok('right code opens the client', await until(() => vis(a, '.rundown.edit')))
	await sleep(800); c.ok('same tabs as the app', (await a.ev(`[...document.querySelectorAll('.topbar .segmented button')].map(b=>b.textContent).join()`)) === 'Edit,Show,Channels,Activity')
	const cookie = (await (await fetch(W + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VT': '1' }, body: '{"code":"246810"}' })).headers.get('set-cookie')).split(';')[0]
	c.ok('another site cannot use it', (await raw({ client: 'abcdefgh12', name: 'init', args: [] }, { Cookie: cookie, Origin: 'http://evil.example' })).status === 403)
	c.ok('only listed files are served', (await Promise.all(['/../package.json', '/..%2fpackage.json', '/dist/main/main.js', '/constructor', '/__proto__'].map((x) => fetch(W + x, { headers: { Cookie: cookie } })))).every((r) => r.status === 404))
	const call = async (name, ...args) => (await raw({ client: 'abcdefgh12', name, args }, { Cookie: cookie })).json()
	for (const n of ['quit', 'hide', 'open', 'browseFolder', 'browseExe', 'webOpen', 'webNewCode', 'nope', 'constructor', '__proto__']) { const r = await call(n); c.ok(`a browser cannot ${n}`, r.ok === false && !!r.error, r) }

	// --- open, edit, both ways
	await click(a, '.rd-head .btn', 'File'); await menu(a, 'Open…'); c.ok('lists rundowns on the show PC', await until(() => a.ev(`[...document.querySelectorAll('.files-row')].some(b=>b.textContent.includes('summit.xml'))`))); await a.shot(path.join(dir, 'open.png'))
	await click(a, '.files-row', 'summit.xml'); c.ok('opens one', await until(async () => (await labels(a)).includes('CITY1')))
	c.ok('it opens in the app too', await until(() => pc.ev(`[...document.querySelectorAll('.rd-tab')].some(t=>t.textContent.includes('summit'))`)))
	await pc.ev(`[...document.querySelectorAll('.rd-tab')].find(t=>t.offsetParent&&t.textContent.includes('summit')).click()`); await sleep(400)
	c.ok('the empty tab it replaced is gone from both', (await a.ev(`document.querySelectorAll('.rundown.edit .rd-tab').length`)) === 1 && (await pc.ev(`document.querySelectorAll('.rundown.edit .rd-tab').length`)) === 1)
	await pick(a, 'TECH1'); await sleep(900); await setLabel(a, 'TECH browser'); c.ok('an edit in the browser shows in the app', await until(async () => (await labels(pc)).includes('TECH browser')))
	await pick(pc, 'WIDE1'); await sleep(400); await setLabel(pc, 'WIDE app'); c.ok('and the other way', await until(async () => (await labels(a)).includes('WIDE app')))
	c.ok('the browser keeps its own selection', (await a.ev(`document.querySelector('.rundown.edit .rd-row.sel .rd-label').textContent`)) === 'TECH browser')
	await a.ev(`document.activeElement.blur()`); await a.key('z', { ctrl: true }); c.ok('undo takes back my change only', await until(async () => { const l = await labels(pc); return l.includes('TECH1') && l.includes('WIDE app') }), await labels(pc)); await a.key('y', { ctrl: true }); c.ok('redo too', await until(async () => { const l = await labels(pc); return l.includes('TECH browser') && l.includes('WIDE app') }))
	// both at once, many times
	const b = await open(1180, 760); await go(b, W); await until(() => vis(b, '.rundown.edit')); await sleep(800)
	const names = ['CITY1', 'WEBCAM1', 'MID1']
	await Promise.all([[a, 'CITY1'], [b, 'WEBCAM1'], [pc, 'MID1']].map(async ([p, l]) => { await pick(p, l); await sleep(700); for (let k = 1; k <= 25; k++) { await setLabel(p, `${l}-${k}`); await sleep(20) } }))
	const end = names.map((n) => `${n}-25`); const all3 = await until(async () => { const r = await Promise.all([a, b, pc].map(labels)); return r.every((l) => end.every((e) => l.includes(e))) && r }, 8000)
	c.ok('three screens editing at once: all three edits are on all three', !!all3, await Promise.all([a, b, pc].map(async (p) => (await labels(p)).filter((l) => /-\d+$/.test(l)))))
	await Promise.all([a, b, pc].map(async (p, n) => { await p.ev(`document.querySelector('.library .lib-tabs [title=Tools]').click()`); await sleep(300); for (let k = 0; k < 4; k++) { await p.ev(`[...document.querySelectorAll('.library .lib-row')].find(x=>x.textContent.trim()==='${['Commit', 'Grid', 'Reset'][n]}').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`); await sleep(15) } }))
	const cnt = async (p) => { const l = await labels(p); return ['Commit', 'Grid', 'Reset'].map((x) => l.filter((y) => y === x).length).join() }
	c.ok('and adding entries at once: every one is kept', await until(async () => (await Promise.all([a, b, pc].map(cnt))).every((x) => x === '4,4,4'), 8000), await Promise.all([a, b, pc].map(cnt)))
	await sleep(600); const l3 = await Promise.all([a, b, pc].map(labels)); c.ok('in the same order everywhere', JSON.stringify(l3[0]) === JSON.stringify(l3[1]) && JSON.stringify(l3[1]) === JSON.stringify(l3[2]))
	const disk = JSON.parse(fs.readFileSync(path.join(ud, 'session.json'), 'utf8')); const fl = (x) => x.flatMap((i) => [i.label, ...fl(i.items ?? [])]); c.ok('and in what is kept for next time', end.every((e) => fl(disk[0].items).includes(e)))

	// --- playing
	const at = async (k) => JSON.parse(await (await fetch('http://127.0.0.1:8131/status')).text()).layers[k]
	await tab(a, 'Show'); await sleep(500); await pick(a, 'Holding loop'); await a.key('F2'); c.ok('F2 plays a playlist', await until(async () => (await at('2-10'))?.playlist === 'Holding loop'))
	c.ok('the browser follows it live', await until(() => a.ev(`[...document.querySelectorAll('.rundown.show .rd-badge')].some(b=>b.textContent==='PLAY')&&/^00:\\d\\d$/.test(document.querySelector('.rd-big').textContent)`))); await a.shot(path.join(dir, 'show.png'))
	const n0 = (await at('2-10')).index; await a.key('F5'); c.ok('F5 is Next, not reload', await until(async () => (await at('2-10')).index === n0 + 1))
	await tab(a, 'Channels'); await sleep(600); c.ok('channels work', await vis(a, '.channels')); await a.shot(path.join(dir, 'channels.png'))
	await tab(a, 'Activity'); await a.ev(`(()=>{const i=document.querySelector('.s-log-bar .cmd');i.value='VERSION';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`); c.ok('commands can be sent', await until(() => a.ev(`[...document.querySelectorAll('.s-log-row')].some(r=>/^2\\.\\d/.test(r.querySelector('.m').textContent))`)))
	await tab(a, 'Show'); await pick(a, 'Holding loop'); await a.key('F1'); await sleep(400)

	// --- preview and trimming in the browser
	await front(a); await tab(a, 'Edit'); await pick(a, 'CITY1-25'); const V = (k) => a.ev(`document.querySelector('video.pv-video').${k}`)
	c.ok('the preview loads over the network', await until(() => a.ev(`(()=>{const v=document.querySelector('video.pv-video');return v.readyState>=2&&v.videoWidth>0&&v.src.includes('/media/')})()`), 15000), await V('src'))
	await a.ev(`document.activeElement.blur()`); await a.key(' '); c.ok('it plays', await until(async () => (await V('currentTime')) > 0.5)); await a.key(' ')
	await a.ev(`(()=>{const v=document.querySelector('video.pv-video');return new Promise(r=>{v.onseeked=()=>r(1);v.currentTime=2.01})})()`); await sleep(200); await a.key('i'); c.ok('I trims, and the app sees it', await until(async () => JSON.parse(fs.readFileSync(path.join(ud, 'session.json'), 'utf8'))[0].items.some((i) => i.label === 'CITY1-25' && i.props.seek === 100)))
	c.ok('thumbnails show', await until(async () => { await a.ev(`document.querySelector('.library .lib-tabs [title=Media]').click()`); return a.ev(`document.querySelectorAll('.library .lib-row').length>5`) }))
	// one screen's preview never stops another's
	await front(b); await Promise.all([pick(pc, 'TECH browser'), pick(b, 'WIDE app')]); await sleep(300); const [r1, r2] = await Promise.all([until(() => pc.ev(`document.querySelector('video.pv-video').readyState>=2`), 9000), until(() => b.ev(`document.querySelector('video.pv-video').readyState>=2`), 9000)]); c.ok('two screens preview at once', r1 && r2, [r1, r2]); await front(a)

	// --- saving
	await a.key('s', { ctrl: true }); c.ok('Ctrl+S saves on the show PC', await until(() => fs.readFileSync(file, 'utf8').includes('CITY1-25'))); c.ok('saved everywhere', await until(() => pc.ev(`!document.querySelector('.rundown.edit .rd-tab.active .dirty')`)))
	await a.key('s', { ctrl: true, shift: true }); c.ok('Save as asks for a name and folder', await until(() => vis(a, '.files input.field'))); await a.ev(`(()=>{const i=document.querySelector('.files input.field');i.value='copy';i.dispatchEvent(new Event('input'))})()`); await a.shot(path.join(dir, 'saveas.png')); await click(a, '.files .btn', 'Save'); c.ok('and saves there', await until(() => fs.existsSync(path.join(home, 'copy.xml'))))
	const D = (await call('init')).value.docs[0].doc
	for (const [d, n] of [['C:\\Windows\\Temp', 'x'], [home, '..\\x'], [home, 'a:b'], [home, 'con'], ['\\\\evil\\share', 'x']]) { const r = await call('saveTo', D, d, n); c.ok(`cannot save to ${d} ${n}`, !r.ok, r) }
	for (const f of ['C:\\Windows\\win.ini', path.join(ud, 'settings.json'), 'C:\\Windows\\x.xml']) c.ok(`cannot open ${path.basename(f)}`, !(await call('openPath', f)).ok)
	c.ok('cannot point a rundown somewhere else', await (async () => { const n = (await call('init')).value.docs[0]; const r = await call('docs', [{ doc: { ...n.doc, path: 'C:\\Windows\\Temp\\evil.xml' }, base: n.rev }], []); const p = (await call('init')).value.docs[0].doc.path; return r.ok && p === n.doc.path })())
	const x = await call('openText', 'mine.xml', fs.readFileSync(file, 'utf8')); c.ok('a file from the device opens', x.ok && x.value.items.length > 50 && x.value.name === 'mine'); c.ok('downloads', (await call('xml', D)).value.startsWith('<?xml'))

	// --- settings
	await click(a, '.settings-btn'); await sleep(1500); const fr = (await (await fetch('http://127.0.0.1:9444/json')).json()); c.ok('settings open over the page', await a.ev(`!!document.querySelector('.web-settings iframe').contentDocument.querySelector('.s-sidebar')`), fr.length); await a.shot(path.join(dir, 'settings.png'))
	const F = (e) => a.ev(`(()=>{const d=document.querySelector('.web-settings iframe').contentDocument;return ${e}})()`)
	await F(`[...d.querySelectorAll('.s-tab')].find(b=>b.textContent==='Rundown').click()`); await sleep(400); await F(`d.querySelector('.s-row input[type=checkbox], .s-row .toggle input')?.click()`); c.ok('a setting changes for everyone', await until(() => JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8')).compact === true), await F(`d.querySelector('.s-pane').innerHTML.slice(0,400)`))
	await click(a, '.web-settings .icon-btn'); c.ok('and closes', !(await vis(a, '.web-settings')))

	// --- another device: the same, except for what could run programs on the show PC (127.0.0.2 stands in for one)
	const far = (name, ...args) => new Promise((ok) => { const q = http.request({ host: '127.0.0.1', port: 8136, path: '/call', method: 'POST', localAddress: '127.0.0.2', headers: { 'Content-Type': 'application/json', 'X-VT': '1', Cookie: cookie } }, (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => ok(JSON.parse(s))) }); q.end(JSON.stringify({ client: 'faraway1234', name, args })) })
	const now = async () => (await far('init')).value.docs[0]
	const shell = (cmd) => ({ id: 'sh' + cmd.length, type: 'SHELL', label: 'S', name: 'S', device: '', channel: 1, layer: 10, delay: 0, duration: 0, allowGpi: false, allowRemote: false, remoteId: '', storyId: '', props: { cgshell: cmd, cgshellstop: '', cgshelldir: '' } })
	let nd = await now(); let rr = await far('docs', [{ doc: { ...nd.doc, name: nd.doc.name, items: [...nd.doc.items, { ...shell(''), type: 'SEPARATOR', label: 'From far', props: {} }] }, base: nd.rev }], []); c.ok('another device edits', rr.ok && (await until(async () => (await labels(pc)).includes('From far'))), rr)
	nd = await now(); rr = await far('docs', [{ doc: { ...nd.doc, items: [...nd.doc.items, shell('calc.exe')] }, base: nd.rev }], []); c.ok('but cannot write a shell command', !rr.ok && !JSON.stringify((await now()).doc).includes('calc.exe'), rr)
	nd = await now(); const inGroup = { ...shell(''), id: 'gg', type: 'GROUP', props: {}, items: [shell('calc.exe')] }; c.ok('nor inside a group', !(await far('docs', [{ doc: { ...nd.doc, items: [...nd.doc.items, inGroup] }, base: nd.rev }], [])).ok)
	c.ok('nor in a preset', !(await far('presetSave', 'p', [shell('calc.exe')])).ok); c.ok('nor in a saved file', !(await far('saveTo', { ...nd.doc, items: [shell('calc.exe')] }, home, 'evil')).ok && !fs.existsSync(path.join(home, 'evil.xml'))); c.ok('nor over an open file', !(await far('save', { ...nd.doc, items: [shell('calc.exe')] }, false)).ok)
	c.ok('nor in a file from the device', !(await far('openText', 'e.xml', (await call('xml', { ...nd.doc, items: [shell('calc.exe')] })).value)).ok)
	for (const [n, p] of [['allowShell', { allowShell: true }], ['ffmpeg', { ffmpeg: 'C:\\x.exe' }], ['web', { web: { enabled: true, port: 8136, lan: true, code: '1' } }], ['legacyConfig', { legacyConfig: 'C:\\x' }], ['media folder', { devices: [{ name: 'Localhost', host: '127.0.0.1', port: 5350, preview: 0, shadow: false, media: 'C:\\' }] }]]) c.ok(`cannot set ${n}`, !(await far('setSettings', p)).ok)
	c.ok('can change other settings', (await far('setSettings', { skipSeconds: 7 })).ok && JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8')).skipSeconds === 7); await far('setSettings', { recent: ['C:\\Windows\\a.xml'] }); c.ok('cannot add folders by the back door', !JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8')).recent.some((f) => /Windows/.test(f)))
	nd = await now(); rr = await call('docs', [{ doc: { ...nd.doc, items: [...nd.doc.items, shell('rem hello')] }, base: nd.rev }], []); c.ok('a browser on this PC can write one', rr.ok, rr); nd = await now(); nd.doc.items.unshift(nd.doc.items.pop()); rr = await far('docs', [{ doc: nd.doc, base: nd.rev }], []); c.ok('and another device can then move it', rr.ok, rr); rr = await far('docs', [{ doc: nd.doc, base: nd.rev }], []); c.ok('an out of date change comes back', rr.ok && rr.value.conflicts.length === 1)

	// --- a lost connection
	await a.send('Network.enable'); await a.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
	await a.ev(`1`); await pick(pc, 'LT001 Jon Seager'); await sleep(300); await setLabel(pc, 'LT while away'); await pick(a, 'LT002 Peter Pihlmann Pedersen'); await sleep(500); await setLabel(a, 'LT offline edit'); await sleep(1000)
	await a.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
	c.ok('a lost connection: both sides catch up', await until(async () => { const [x1, x2] = await Promise.all([labels(a), labels(pc)]); return x1.includes('LT while away') && x1.includes('LT offline edit') && x2.includes('LT offline edit') }, 15000), [(await labels(a)).filter((l) => /LT (w|o)/.test(l)), (await labels(pc)).filter((l) => /LT (w|o)/.test(l))])

	// --- small screens
	const m = await open(390, 844, true); await go(m, W); await until(() => vis(m, '.rundown')); await sleep(1000); await tab(m, 'Edit'); await sleep(300)
	c.ok('phone: one panel at a time', (await vis(m, '.vt-center')) && !(await vis(m, '.library')) && !(await vis(m, '.vt-right')) && (await vis(m, '.panels'))); await m.shot(path.join(dir, 'phone_edit.png'))
	c.ok('phone: nothing sticks out', await m.ev(`document.documentElement.scrollWidth<=390&&[...document.querySelectorAll('.rd-bar,.rd-head,.topbar')].filter(e=>e.offsetParent!==null).every(e=>e.scrollWidth<=e.clientWidth+1)`), await m.ev(`[...document.querySelectorAll('.rd-bar,.rd-head,.topbar')].map(e=>[e.className,e.scrollWidth,e.clientWidth])`))
	await click(m, '.panels button', 'Library'); await sleep(500); c.ok('phone: library', await vis(m, '.library')); await m.shot(path.join(dir, 'phone_lib.png')); await m.ev(`document.querySelector('.library .lib-tabs [title=Tools]').click()`); await sleep(300); await m.ev(`[...document.querySelectorAll('.library .lib-row')].find(x=>x.textContent.trim()==='Separator').querySelector('.lib-add').click()`); await sleep(500); await click(m, '.panels button', 'Rundown'); c.ok('phone: + adds an entry', await until(async () => (await labels(pc)).includes('Separator')))
	await m.ev(`[...document.querySelectorAll('.rundown.edit .rd-row')].find(x=>x.querySelector('.rd-label').textContent==='TECH browser').querySelector('.rd-more').click()`); await sleep(300); await m.shot(path.join(dir, 'phone_menu.png')); const before = (await labels(pc)).indexOf('TECH browser'); await menu(m, 'Move down'); c.ok('phone: move down', await until(async () => (await labels(pc)).indexOf('TECH browser') === before + 1), [before, (await labels(pc)).indexOf('TECH browser')]); await m.ev(`[...document.querySelectorAll('.rundown.edit .rd-row')].find(x=>x.querySelector('.rd-label').textContent==='TECH browser').querySelector('.rd-more').click()`); await menu(m, 'Move up'); c.ok('phone: move up', await until(async () => (await labels(pc)).indexOf('TECH browser') === before))
	await pick(m, 'CITY1-25'); await m.ev(`[...document.querySelectorAll('.rundown.edit .rd-row')].find(x=>x.querySelector('.rd-label').textContent==='MID1-25').querySelector('.rd-ico').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`); await sleep(200); c.ok('phone: tap an icon to select more', (await m.ev(`document.querySelectorAll('.rundown.edit .rd-row.sel').length`)) === 2)
	await pick(m, 'WIDE app'); await pick(m, 'CITY1-25'); await click(m, '.panels button', 'Details'); await sleep(2500); await m.shot(path.join(dir, 'phone_details.png')); c.ok('phone: details and preview', (await vis(m, '.preview')) && (await vis(m, '.inspector:not(.info)')), [await vis(m, '.preview'), await vis(m, '.inspector:not(.info)'), await m.ev(`document.querySelector('.vt-body').className+document.querySelector('.vt-body').dataset.panel`)])
	await tab(m, 'Show'); await click(m, '.panels button', 'Rundown'); await sleep(500); await m.shot(path.join(dir, 'phone_show.png')); c.ok('phone: show fits', await m.ev(`document.documentElement.scrollWidth<=390&&[...document.querySelectorAll('.rd-bar,.rd-head,.topbar')].filter(e=>e.offsetParent!==null).every(e=>e.scrollWidth<=e.clientWidth+1)`))
	await m.ev(`[...document.querySelectorAll('.rundown.show .rd-row')].find(x=>x.querySelector('.rd-label').textContent==='WIDE app').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`); await sleep(200); await click(m, '.rundown.show .btn.tb.go'); c.ok('phone: plays', await until(async () => /wide1/i.test((await at('2-10'))?.name ?? '')))
	await tab(m, 'Channels'); await sleep(600); c.ok('phone: channels fit', await m.ev(`[...document.querySelectorAll('.ch-row')].every(e=>e.scrollWidth<=e.clientWidth+1)`)); await m.shot(path.join(dir, 'phone_ch.png')); await click(m, '.settings-btn'); await sleep(1500); await m.shot(path.join(dir, 'phone_set.png')); await click(m, '.web-settings .icon-btn')
	await m.send('Emulation.setDeviceMetricsOverride', { width: 820, height: 1180, deviceScaleFactor: 1, mobile: true }); await tab(m, 'Show'); await sleep(500); await m.shot(path.join(dir, 'tablet_show.png')); c.ok('tablet: toolbar fits', await m.ev(`[...document.querySelectorAll('.rundown.show .rd-bar')].every(e=>e.scrollWidth<=e.clientWidth+1)`)); c.ok('tablet: rundown and details side by side', (await vis(m, '.vt-center')) && (await vis(m, '.vt-right'))); await tab(m, 'Edit'); await sleep(300); await m.shot(path.join(dir, 'tablet_edit.png'))

	c.ok('the app itself looks as before', !(await vis(pc, '.panels')) && !(await vis(pc, '.rd-more'))); await pc.shot(path.join(dir, 'pc.png'))

	// --- choosing the access code, in the app's own settings
	await pc.ev(`vt.call('openSettings')`); const sw = await app.page('settings.html'); await sleep(900); const pane = () => sw.ev(`[...document.querySelectorAll('.s-tab')].find(b=>b.textContent==='Web Interface').click()`); await pane(); await sleep(500)
	const type = (v) => sw.ev(`(()=>{const i=document.querySelector('input.s-code');i.value=${JSON.stringify(v)};i.dispatchEvent(new Event('change'));return true})()`); const codeNow = () => JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8')).web.code
	await type('abc'); await sleep(500); c.ok('a short code is refused', codeNow() === '246810' && (await sw.ev(`document.querySelector('input.s-code').value`)) === '246810'); c.ok('also when sent directly', !(await sw.ev(`vt.call('setSettings',{web:{enabled:true,port:8136,lan:false,code:'  12345 '}})`)).ok)
	await sw.shot(path.join(dir, 'code.png')); await type('Stage left & 100%'); await sleep(1500); c.ok('a chosen code is kept', codeNow() === 'Stage left & 100%', codeNow()); c.ok('it signs everyone out', (await raw({ client: 'abcdefgh12', name: 'init', args: [] }, { Cookie: cookie })).status === 401 && (await until(() => vis(a, '.login input'), 9000)))
	const log_ = (code) => fetch(W + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VT': '1' }, body: JSON.stringify({ code }) }); c.ok('the old code stops working, the new one works', (await log_('246810')).status === 401 && (await log_('Stage left & 100%')).status === 200)
	await front(a); await a.ev(`(()=>{const i=document.querySelector('.login input');i.value='Stage left & 100%';document.querySelector('.login button').click()})()`); c.ok('a browser signs back in with it', await until(() => vis(a, '.rundown')))
	const o = await open(); await go(o, W + '/#' + encodeURIComponent('Stage left & 100%')); c.ok('Open here works with it', await until(() => vis(o, '.rundown'))); c.ok('and the code is out of the address', (await o.ev('location.hash')) === '')
	await app.kill(); await sleep(1500); app = await startApp(ud); await app.page('index.html'); await sleep(3000); c.ok('it lasts through a restart', (await log_('Stage left & 100%')).status === 200)

	const errs = [a, b, m, pc].flatMap((p) => p.errors).filter((e) => !/ERR_INTERNET_DISCONNECTED|401|Failed to load resource/.test(String(e))); c.ok('no errors', errs.length === 0, errs)
} catch (e) { console.log('FAIL', e.stack) } finally { c.done(); br?.kill(); await app?.kill(); await srv?.stop(); await sleep(300); process.exit(0) }
