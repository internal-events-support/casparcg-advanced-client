// The real app starting with settings from before it was renamed, in a temporary folder. Run through hidden.py.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, checker, connect, sleep } from './lib.mjs'

const [logFile] = process.argv.slice(2)
if (logFile) { const s = fs.createWriteStream(logFile); console.log = (...a) => s.write(a.join(' ') + '\n') }
const c = checker()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'renamed-'))
const from = path.join(tmp, 'Caspar VT'), to = path.join(tmp, 'CasparCG Advanced Client')
fs.mkdirSync(from)
const settings = { devices: [], http: { enabled: true, port: 8131 }, osc: { enabled: false, port: 3351 }, countdown: { enabled: false, port: 8132 }, web: { enabled: true, port: 8136, lan: false, code: '246810' } }
fs.writeFileSync(path.join(from, 'settings.json'), JSON.stringify(settings))
fs.writeFileSync(path.join(from, 'web.key'), 'ab'.repeat(32))
fs.writeFileSync(path.join(from, 'session.json'), JSON.stringify([{ id: 'd1', path: '', name: 'Kept rundown', allowRemote: true, dirty: true, items: [] }]))
// Starts the built app with the folder settings live in moved, and nothing else different.
fs.mkdirSync(path.join(tmp, 'start'))
fs.writeFileSync(path.join(tmp, 'start/package.json'), '{"name":"renamed-test","main":"main.js"}')
fs.writeFileSync(path.join(tmp, 'start/main.js'), `require('electron').app.setPath('appData', ${JSON.stringify(tmp)}); require(${JSON.stringify(path.join(ROOT, 'dist/main/main.js'))})`)
const run = async (f) => {
	const proc = spawn(path.join(ROOT, 'node_modules/electron/dist/electron.exe'), [path.join(tmp, 'start'), '--remote-debugging-port=9333'], { env: { ...process.env, CASPARCG_ADVANCED_USERDATA: undefined, ELECTRON_RUN_AS_NODE: undefined }, stdio: 'ignore' })
	const gone = new Promise((r) => proc.on('exit', r))
	try {
		let t
		for (let i = 0; i < 60 && !t; i++) { try { t = (await (await fetch('http://127.0.0.1:9333/json')).json()).find((x) => x.url.includes('index.html')) } catch {} if (!t) await sleep(300) }
		if (!t) throw new Error('app window not found')
		const p = await connect(t.webSocketDebuggerUrl); await sleep(2500); await f(p); p.close()
	} finally { proc.kill(); await Promise.race([gone, sleep(4000)]) }
}
try {
	const login = async (code) => (await fetch('http://127.0.0.1:8136/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VT': '1' }, body: JSON.stringify({ code }) })).status
	await run(async (p) => {
		c.ok('title', (await p.ev('document.title')) === 'CasparCG Advanced Client' && (await p.ev(`document.querySelector('.app-title').textContent`)) === 'CasparCG Advanced Client')
		c.ok('rundown carried over', await p.ev(`document.body.innerText.includes('Kept rundown')`))
		c.ok('access code carried over', (await login('246810')) === 200)
		c.ok('copied to the new folder', fs.readFileSync(path.join(to, 'web.key'), 'utf8') === 'ab'.repeat(32) && JSON.parse(fs.readFileSync(path.join(to, 'settings.json'), 'utf8')).web.code === '246810')
		c.ok('the old folder has nothing new in it', fs.readdirSync(from).sort().join() === 'session.json,settings.json,web.key', fs.readdirSync(from))
	})
	fs.writeFileSync(path.join(to, 'settings.json'), JSON.stringify({ ...settings, web: { ...settings.web, code: '135790' } }))
	await run(async () => c.ok('not copied again on the next start', (await login('135790')) === 200))
} catch (e) { c.ok(e.stack, false) } finally {
	await sleep(500)
	fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
	c.done()
	await sleep(300)
	process.exit(0)
}
