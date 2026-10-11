'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let LOGF = null;
function setLogFile(f) { LOGF = f; }
function log(...a) {
  const line = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log('[autocut] ' + line);
  if (LOGF) try { fs.appendFileSync(LOGF, line + '\n'); } catch {}
}
async function retry(fn, what = 'op', { tries = 10, base = 1500, cap = 60000, giveUp } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); } catch (e) {
      last = e;
      if (giveUp && giveUp(e)) throw e;
      const d = Math.min(cap, base * 1.7 ** i) * (0.7 + Math.random() * 0.6);
      log(`[retry] ${what}: ${String(e.message || e).slice(0, 200)} -> ${(d / 1000).toFixed(1)}s (${i + 1}/${tries})`);
      await sleep(d);
    }
  }
  throw new Error(`${what} failed: ${last && last.message}`);
}
function fmtTs(t, ms = false) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return ms ? base + ',' + String(Math.floor((t % 1) * 1000)).padStart(3, '0') : base;
}
function ytTs(t, total) {
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  if (total >= 3600) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function parseTs(v) {
  if (typeof v === 'number') return v;
  if (v == null) return NaN;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const p = s.split(':').map(Number);
  if (p.some((x) => Number.isNaN(x))) return NaN;
  return p.reduce((a, x) => a * 60 + x, 0);
}
function safeName(s, max = 120) {
  s = String(s || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (s.length > max) s = s.slice(0, max).trim();
  return s || 'video';
}
function rid(n = 8) { return crypto.randomBytes(16).toString('hex').slice(0, n); }
function safeEq(a, b) { a = Buffer.from(String(a || '')); b = Buffer.from(String(b || '')); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function readJson(f, d = null) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function writeJson(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp' + process.pid; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); }
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf, c = 0) { c = ~c; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return ~c >>> 0; }
module.exports = { sleep, log, setLogFile, retry, fmtTs, ytTs, parseTs, safeName, rid, safeEq, readJson, writeJson, crc32 };
