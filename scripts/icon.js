// Draws static/icon.png (256 px): a dark rounded square with a play mark over a red/green tally bar.
const zlib = require('zlib'); const fs = require('fs'); const path = require('path');
const N = 256, S = 3, px = Buffer.alloc(N * N * 4);
const round = (x, y, l, t, r, b, q) => { const cx = Math.max(l + q, Math.min(r - q, x)), cy = Math.max(t + q, Math.min(b - q, y)); return x >= l && x <= r && y >= t && y <= b && (x - cx) ** 2 + (y - cy) ** 2 <= q * q; };
const col = (x, y) => { if (!round(x, y, 8, 8, 248, 248, 54)) return null; if (round(x, y, 46, 190, 124, 208, 9)) return [38, 133, 67]; if (round(x, y, 132, 190, 210, 208, 9)) return [218, 22, 57]; if (x >= 96 && x <= 178 && Math.abs(y - 108) <= (178 - x) * 0.66) return [255, 255, 255]; const g = 64 - Math.round((y / 256) * 30); return [g, g, g + 2]; };
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let r = 0, g = 0, b = 0, a = 0; for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) { const c = col(x + (i + 0.5) / S, y + (j + 0.5) / S); if (c) { r += c[0]; g += c[1]; b += c[2]; a++; } } const o = (y * N + x) * 4; if (a) { px[o] = r / a; px[o + 1] = g / a; px[o + 2] = b / a; } px[o + 3] = (a / (S * S)) * 255; }
const T = [...Array(256).keys()].map((n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const raw = Buffer.alloc((N * 4 + 1) * N); for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const ih = Buffer.alloc(13); ih.writeUInt32BE(N, 0); ih.writeUInt32BE(N, 4); ih[8] = 8; ih[9] = 6;
fs.writeFileSync(path.join(__dirname, '..', 'static', 'icon.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
