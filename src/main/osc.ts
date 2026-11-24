// Minimal OSC 1.0 encode/decode.
export type OscArg = string | number | boolean;

function str(b: Buffer, i: number): [string, number] {
  const e = b.indexOf(0, i);
  if (e < 0) throw new Error('bad OSC string');
  return [b.toString('utf8', i, e), (e + 4) & ~3];
}

export function decode(b: Buffer, emit: (address: string, args: OscArg[]) => void): void {
  if (b.length >= 8 && b.toString('latin1', 0, 7) === '#bundle') {
    let i = 16;
    while (i + 4 <= b.length) {
      const n = b.readInt32BE(i);
      if (n <= 0 || i + 4 + n > b.length) return;
      decode(b.subarray(i + 4, i + 4 + n), emit);
      i += 4 + n;
    }
    return;
  }
  let [addr, i] = str(b, 0);
  let tags: string;
  [tags, i] = str(b, i);
  const args: OscArg[] = [];
  for (const t of tags.slice(1)) {
    if (t === 'i') { args.push(b.readInt32BE(i)); i += 4; }
    else if (t === 'f') { args.push(b.readFloatBE(i)); i += 4; }
    else if (t === 'd') { args.push(b.readDoubleBE(i)); i += 8; }
    else if (t === 'h') { args.push(Number(b.readBigInt64BE(i))); i += 8; }
    else if (t === 's' || t === 'S') { let v: string; [v, i] = str(b, i); args.push(v); }
    else if (t === 'T') args.push(true);
    else if (t === 'F') args.push(false);
    else return;
  }
  emit(addr, args);
}

function pad(s: string): Buffer {
  const b = Buffer.from(s + '\0', 'utf8');
  return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
}

/** type: String | Bool | Int32 | Float | Double | Int64 (names from the original client). */
export function encode(address: string, value: string, type: string, bundle: boolean): Buffer {
  let tag = 's';
  let body: Buffer = pad(value);
  const n = Number(value) || 0;
  if (type === 'Bool') { tag = /^(true|1|yes)$/i.test(value) ? 'T' : 'F'; body = Buffer.alloc(0); }
  else if (type === 'Int32') { tag = 'i'; body = Buffer.alloc(4); body.writeInt32BE(Math.trunc(n) | 0); }
  else if (type === 'Float') { tag = 'f'; body = Buffer.alloc(4); body.writeFloatBE(n); }
  else if (type === 'Double') { tag = 'd'; body = Buffer.alloc(8); body.writeDoubleBE(n); }
  else if (type === 'Int64') { tag = 'h'; body = Buffer.alloc(8); body.writeBigInt64BE(BigInt(Math.trunc(n))); }
  const msg = Buffer.concat([pad(address), pad(',' + tag), body]);
  if (!bundle) return msg;
  const size = Buffer.alloc(4);
  size.writeInt32BE(msg.length);
  return Buffer.concat([pad('#bundle'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), size, msg]);
}
