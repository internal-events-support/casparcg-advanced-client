// Shared test helpers: isolated CasparCG server, the real app, and a DevTools connection to drive it.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const ROOT = path.resolve(import.meta.dirname, '..')
export const CG = (process.env.CASPAR_DIR || path.resolve(ROOT, '../server/build/casparcg_server')).replace(/\\/g, '/')

export async function startServer(dir, media, channels) {
	for (const d of ['log', 'data', 'template', 'cef']) fs.mkdirSync(path.join(dir, d), { recursive: true })
	const p = (d) => path.join(dir, d).replace(/\\/g, '/') + '/'
	const ch = '<channel><video-mode>720p5000</video-mode><consumers></consumers></channel>'
	fs.writeFileSync(path.join(dir, 't.config'), `<?xml version="1.0" encoding="utf-8"?><configuration><paths><media-path>${media.replace(/\\/g, '/')}/</media-path><log-path disable="false">${p('log')}</log-path><data-path>${p('data')}</data-path><template-path>${p('template')}</template-path></paths><lock-clear-phrase>secret</lock-clear-phrase><html><cache-path>${p('cef')}</cache-path></html><channels>${channels ?? ch.repeat(4)}</channels><controllers><tcp><port>5350</port><protocol>AMCP</protocol></tcp></controllers><amcp><media-server><host>localhost</host><port>8000</port></media-server></amcp><osc><default-port>6350</default-port></osc></configuration>`)
	const srv = spawn(path.join(CG, 'casparcg.exe'), [path.join(dir, 't.config')], { cwd: dir, stdio: 'ignore', windowsHide: true })
	let sock
	for (let i = 0; i < 80 && !sock; i++) {
		sock = await new Promise((ok) => { const s = net.connect(5350, '127.0.0.1', () => ok(s)); s.on('error', () => ok(null)) })
		if (!sock) await sleep(400)
	}
	if (!sock) throw new Error('test server did not start')
	let buf = ''
	sock.setEncoding('utf8')
	sock.on('data', (d) => (buf += d))
	sock.on('error', () => {})
	const amcp = async (c, w = 250) => { buf = ''; sock.write(c + '\r\n'); await sleep(w); return buf }
	const logFile = () => { const f = fs.readdirSync(path.join(dir, 'log')).sort().pop(); return path.join(dir, 'log', f) }
	return {
		amcp,
		mark: () => fs.statSync(logFile()).size,
		/** Commands the server received since `pos` (status polling left out). */
		sent: (pos) => fs.readFileSync(logFile()).subarray(pos).toString('utf8').split('\n').filter((l) => /Received message/.test(l)).map((l) => l.replace(/.*Received message from [\d.]+: /, '').replace(/\\r\\n\s*$/, '').replace(/^REQ \S+ /, '').trim()).filter((l) => !/^(INFO|VERSION|CLS|TLS|DATA LIST|OSC SUB|THUMBNAIL)/.test(l)),
		stop: async () => { sock.write('KILL\r\n'); await sleep(2500); if (srv.exitCode === null) spawnSync('taskkill', ['/T', '/F', '/PID', String(srv.pid)], { windowsHide: true }) },
	}
}

export async function startApp(userData, settings, port = 9333) {
	fs.mkdirSync(userData, { recursive: true })
	if (settings) fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ web: { enabled: true, port: 8136, lan: false, code: '246810' }, ...settings }))
	const proc = spawn(path.join(ROOT, 'node_modules/electron/dist/electron.exe'), [ROOT, `--remote-debugging-port=${port}`], { cwd: ROOT, env: { ...process.env, CASPARVT_USERDATA: userData, ELECTRON_RUN_AS_NODE: undefined }, stdio: ['ignore', 'pipe', 'pipe'] })
	let out = ''
	proc.stdout.on('data', (d) => (out += d))
	proc.stderr.on('data', (d) => (out += d))
	const page = async (match) => {
		for (let i = 0; i < 60; i++) {
			try {
				const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
				const t = l.find((x) => x.type === 'page' && x.url.includes(match))
				if (t) return connect(t.webSocketDebuggerUrl)
			} catch {}
			await sleep(300)
		}
		throw new Error('app window not found\n' + out)
	}
	const exited = new Promise((r) => proc.on('exit', r))
	return { proc, page, exited, output: () => out, kill: async () => { proc.kill(); await Promise.race([exited, sleep(4000)]) } }
}

export async function connect(url) {
	const ws = new WebSocket(url)
	await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad })
	let n = 0
	const wait = new Map()
	const errors = []
	ws.onmessage = (e) => {
		const m = JSON.parse(e.data)
		if (m.id) { wait.get(m.id)?.(m); wait.delete(m.id) }
		else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
		else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text)
	}
	const send = (method, params = {}) => new Promise((ok) => { const id = ++n; wait.set(id, ok); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (wait.delete(id)) ok({ error: 'timeout ' + method }) }, 12000) })
	await send('Runtime.enable')
	await send('Log.enable')
	await send('Page.enable')
	const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed'); return r.result?.result?.value }
	const VK = { F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F10: 121, F11: 122, F12: 123, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, ' ': 32, Delete: 46, Enter: 13, Escape: 27, Home: 36, End: 35 }
	const key = async (k, mods = {}) => {
		const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0)
		const code = VK[k] ?? k.toUpperCase().charCodeAt(0)
		const base = { key: k, code: k === ' ' ? 'Space' : VK[k] ? k : /\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`, windowsVirtualKeyCode: code, modifiers }
		await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
		await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
		await sleep(120)
	}
	const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')) }
	return { ev, key, shot, send, errors, close: () => ws.close() }
}

export function checker() {
	const fails = []
	let n = 0
	return { ok: (name, cond, info) => { n++; console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(info ?? '').slice(0, 500)); if (!cond) fails.push(name) }, done: () => { console.log(fails.length ? `FAILED ${fails.length} of ${n}: ${fails.join(' | ')}` : `ALL ${n} PASSED`) }, fails }
}
