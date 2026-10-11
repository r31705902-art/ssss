'use strict';
// Deterministic streaming ZIP (store, ZIP64-aware) / TAR (PAX) builder with exact Content-Length and Range support.
// Entries: { name, size, crc, buf? , blomp? (object name) , mtime? }
const { crc32 } = require('./util');

function dosTime(d) {
  const t = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [t, dt];
}
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

function zipLayout(entries) {
  const segs = []; const cd = []; let off = 0; const M = 0xffffffff;
  const [tm, dt] = dosTime(new Date());
  for (const e of entries) {
    if (e.buf) { e.size = e.buf.length; e.crc = crc32(e.buf); }
    const name = Buffer.from(e.name, 'utf8');
    const big = e.size >= M, bigOff = off >= M;
    const lext = big ? Buffer.concat([u16(1), u16(16), u64(e.size), u64(e.size)]) : Buffer.alloc(0);
    const lh = Buffer.concat([u32(0x04034b50), u16(big ? 45 : 20), u16(0x0800), u16(0), u16(tm), u16(dt), u32(e.crc),
      u32(big ? M : e.size), u32(big ? M : e.size), u16(name.length), u16(lext.length), name, lext]);
    const localOff = off;
    segs.push({ buf: lh }); off += lh.length;
    segs.push(e.buf ? { buf: e.buf } : { blomp: e.blomp, size: e.size }); off += e.size;
    const z = []; if (big) z.push(u64(e.size), u64(e.size)); if (bigOff) z.push(u64(localOff));
    const cext = z.length ? Buffer.concat([u16(1), u16(z.reduce((a, b) => a + b.length, 0)), ...z]) : Buffer.alloc(0);
    cd.push(Buffer.concat([u32(0x02014b50), u16(45), u16(big || bigOff ? 45 : 20), u16(0x0800), u16(0), u16(tm), u16(dt), u32(e.crc),
      u32(big ? M : e.size), u32(big ? M : e.size), u16(name.length), u16(cext.length), u16(0), u16(0), u16(0), u32(0), u32(bigOff ? M : localOff), name, cext]));
  }
  const cdBuf = Buffer.concat(cd); const cdOff = off;
  segs.push({ buf: cdBuf }); off += cdBuf.length;
  const need64 = cdOff >= M || entries.length >= 0xffff || off >= M;
  const tail = [];
  if (need64) {
    const z64Off = off;
    tail.push(Buffer.concat([u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(entries.length), u64(entries.length), u64(cdBuf.length), u64(cdOff)]));
    tail.push(Buffer.concat([u32(0x07064b50), u32(0), u64(z64Off), u32(1)]));
  }
  tail.push(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(Math.min(entries.length, 0xffff)), u16(Math.min(entries.length, 0xffff)),
    u32(Math.min(cdBuf.length, M)), u32(need64 ? M : cdOff), u16(0)]));
  const t = Buffer.concat(tail); segs.push({ buf: t }); off += t.length;
  return { segs, size: off };
}

function paxRecord(k, v) {
  const body = ` ${k}=${v}\n`; let len = Buffer.byteLength(body) + 1;
  for (;;) { const s = `${len}${body}`; const l = Buffer.byteLength(s); if (l === len) return s; len = l; }
}
function tarHeader(name, size, type = '0', mtime = Math.floor(Date.now() / 1000)) {
  const h = Buffer.alloc(512);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').slice(-99);
  h.write(ascii, 0, 100, 'ascii');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write((size < 8589934591 ? size.toString(8).padStart(11, '0') : '77777777777') + '\0', 124);
  h.write(mtime.toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
function tarLayout(entries) {
  const segs = []; let off = 0;
  const pad = (n) => (512 - (n % 512)) % 512;
  for (const e of entries) {
    if (e.buf) e.size = e.buf.length;
    const pax = Buffer.from(paxRecord('path', e.name) + (e.size >= 8589934591 ? paxRecord('size', String(e.size)) : ''), 'utf8');
    const ph = Buffer.concat([tarHeader('PaxHeaders/' + e.name, pax.length, 'x'), pax, Buffer.alloc(pad(pax.length))]);
    const hdr = tarHeader(e.name, e.size);
    segs.push({ buf: Buffer.concat([ph, hdr]) }); off += ph.length + 512;
    segs.push(e.buf ? { buf: e.buf } : { blomp: e.blomp, size: e.size }); off += e.size;
    const p = pad(e.size); if (p) { segs.push({ buf: Buffer.alloc(p) }); off += p; }
  }
  segs.push({ buf: Buffer.alloc(1024) }); off += 1024;
  return { segs, size: off };
}

// Serve layout with optional Range (single range). write(chunk) must return a promise respecting backpressure.
async function serveLayout(layout, swift, req, res, { filename, type }) {
  let start = 0, end = layout.size - 1, status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m) {
    if (m[1] === '') { start = Math.max(0, layout.size - Number(m[2])); } else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
    if (start > end || start >= layout.size) { res.writeHead(416, { 'Content-Range': `bytes */${layout.size}` }); return res.end(); }
    status = 206;
  }
  const h = { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}` };
  if (status === 206) h['Content-Range'] = `bytes ${start}-${end}/${layout.size}`;
  res.writeHead(status, h);
  let gone = false; res.on('close', () => { gone = true; });
  const write = (c) => new Promise((ok, bad) => {
    if (gone) { const e = new Error('client gone'); e.clientGone = true; return bad(e); }
    if (res.write(c)) ok(); else res.once('drain', ok);
  });
  let pos = 0;
  for (const s of layout.segs) {
    const len = s.buf ? s.buf.length : s.size;
    const a = Math.max(start, pos), b = Math.min(end + 1, pos + len);
    if (a < b) {
      if (s.buf) await write(s.buf.subarray(a - pos, b - pos));
      else await swift.pipeTo(s.blomp, b - pos, write, a - pos);
    }
    pos += len; if (pos > end) break;
  }
  res.end();
}
module.exports = { zipLayout, tarLayout, serveLayout };
