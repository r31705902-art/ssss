'use strict';
// On-demand media extraction for the agent: ffmpeg reads the chunk files straight from Blomp over HTTP (Range seeks).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { retry, rid } = require('./util');

class Media {
  constructor({ swift, ffmpeg = 'ffmpeg', tmp, jobPrefix, chunks }) {
    this.sw = swift; this.ff = ffmpeg; this.tmp = tmp; this.P = jobPrefix; this.chunks = chunks;
    fs.mkdirSync(tmp, { recursive: true });
  }
  chunkAt(t) {
    const c = this.chunks;
    return c.find((x) => t >= x.start && t < x.end) || (t < c[0].start ? c[0] : c[c.length - 1]);
  }
  clampT(t) { const c = this.chunks; return Math.min(Math.max(t, c[0].start), c[c.length - 1].end - 0.05); }
  async exists(ci, kind) {
    this._ex = this._ex || new Map(); const k = ci + kind;
    if (!this._ex.has(k)) this._ex.set(k, !!(await this.sw.head(`${this.P}/chunks/${String(ci).padStart(3, '0')}/${kind}.mp4`)));
    return this._ex.get(k);
  }
  async input(ci, kind, ss, to) {
    if (!(await this.exists(ci, kind))) { const alt = kind === 'proxy' ? 'src' : 'proxy'; if (await this.exists(ci, alt)) kind = alt; else throw new Error(`chunk ${ci} missing in storage`); }
    const { url, token } = await this.sw.signed(`${this.P}/chunks/${String(ci).padStart(3, '0')}/${kind}.mp4`);
    const a = ['-headers', `X-Auth-Token: ${token}\r\n`, '-reconnect', '1', '-reconnect_on_http_error', '5xx', '-reconnect_delay_max', '8', '-rw_timeout', '60000000'];
    if (ss > 0) a.push('-ss', ss.toFixed(3));
    if (to != null) a.push('-to', to.toFixed(3));
    return [...a, '-i', url];
  }
  run(args, timeout = 240000) {
    return new Promise((res, rej) => {
      const p = spawn(this.ff, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      const out = [], err = [];
      p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => err.push(d));
      const k = setTimeout(() => p.kill('SIGKILL'), timeout);
      p.on('error', rej);
      p.on('close', (code) => { clearTimeout(k); code === 0 ? res(Buffer.concat(out)) : rej(new Error('ffmpeg ' + code + ': ' + Buffer.concat(err).toString().slice(-400))); });
    });
  }
  // segments of [s,e) split at chunk borders
  spans(s, e) {
    const r = [];
    for (const c of this.chunks) { const a = Math.max(s, c.start), b = Math.min(e, c.end); if (b - a > 0.05) r.push({ c: c.i, a: a - c.start, b: b - c.start }); }
    return r;
  }
  async frame(t, { hq = false, width, vf = '' } = {}) {
    t = this.clampT(t); const c = this.chunkAt(t);
    const w = width || (hq ? 1280 : 640);
    return retry(async () => {
      const b = await this.run([...(await this.input(c.i, hq ? 'src' : 'proxy', Math.max(0, t - c.start))), '-frames:v', '1', '-vf', (vf ? vf + ',' : '') + `scale=${w}:-2`, '-q:v', hq ? '3' : '5', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1']);
      if (b.length < 800 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error('bad jpeg (' + b.length + ' bytes)');
      return b;
    }, 'frame ' + t.toFixed(1), { tries: 4, giveUp: (e) => /missing in storage/.test(e.message) });
  }
  async frames(times, opts = {}) {
    const out = []; let i = 0;
    await Promise.all(Array.from({ length: 4 }, async () => { while (i < times.length) { const k = i++; try { out[k] = { t: times[k], jpg: await this.frame(times[k], opts) }; } catch (e) { out[k] = { t: times[k], error: e.message }; } } }));
    return out;
  }
  async clip(s, e, { fps = 2, audio = true, height = 360 } = {}) {
    const sp = this.spans(s, e); if (!sp.length) throw new Error('range outside stream');
    const f = path.join(this.tmp, 'clip_' + rid() + '.mp4');
    const args = []; for (const x of sp) args.push(...(await this.input(x.c, 'proxy', x.a, x.b)));
    let fc = sp.map((_, k) => `[${k}:v:0]setpts=PTS-STARTPTS,fps=${fps},scale=-2:${height}[v${k}]` + (audio ? `;[${k}:a:0]asetpts=PTS-STARTPTS[a${k}]` : '')).join(';');
    fc += ';' + sp.map((_, k) => `[v${k}]` + (audio ? `[a${k}]` : '')).join('') + `concat=n=${sp.length}:v=1:a=${audio ? 1 : 0}[v]` + (audio ? '[a]' : '');
    try {
      await retry(() => this.run([...args, '-filter_complex', fc, '-map', '[v]', ...(audio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '64k', '-ac', '1'] : ['-an']),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', f], 600000), 'clip', { tries: 3 });
      return fs.readFileSync(f);
    } finally { fs.rmSync(f, { force: true }); }
  }
  async audio(s, e) {
    const sp = this.spans(s, e); if (!sp.length) throw new Error('range outside stream');
    const args = []; for (const x of sp) args.push(...(await this.input(x.c, 'proxy', x.a, x.b)));
    const fc = sp.map((_, k) => `[${k}:a:0]asetpts=PTS-STARTPTS[a${k}]`).join(';') + ';' + sp.map((_, k) => `[a${k}]`).join('') + `concat=n=${sp.length}:v=0:a=1[a]`;
    return retry(() => this.run([...args, '-filter_complex', fc, '-map', '[a]', '-ac', '1', '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3', 'pipe:1'], 300000), 'audio', { tries: 3 });
  }
  // the same blur the renderer applies (+ thin outline so the model can judge coverage)
  blurFilter(boxes, W, H, outline = true) {
    const ev = (x) => Math.floor(x / 2) * 2; let fc = '', cur = '0:v:0';
    boxes.forEach((b, k) => {
      const [y0, x0, y1, x1] = b.box;
      const X = ev(x0 / 1000 * W), Y = ev(y0 / 1000 * H);
      const BW = Math.min(Math.max(8, ev((x1 - x0) / 1000 * W)), W - X), BH = Math.min(Math.max(8, ev((y1 - y0) / 1000 * H)), H - Y);
      const r = Math.max(2, Math.min(Math.floor(Math.min(BW, BH) / 6), Math.floor(BW / 2) - 1, Math.floor(BH / 2) - 1));
      const eff = b.mode === 'pixelate' ? `scale=${Math.max(2, Math.floor(BW / 16))}:${Math.max(2, Math.floor(BH / 16))},scale=${BW}:${BH}:flags=neighbor` : b.mode === 'box' ? `drawbox=0:0:${BW}:${BH}:black:fill` : `boxblur=${r}:3`;
      fc += `[${cur}]split[m${k}][c${k}];[c${k}]crop=${BW}:${BH}:${X}:${Y},${eff}[b${k}];[m${k}][b${k}]overlay=${X}:${Y}` + (outline ? `,drawbox=${X - 2}:${Y - 2}:${BW + 4}:${BH + 4}:red@0.9:2` : '') + `[o${k}];`;
      cur = `o${k}`;
    });
    return { fc: fc.replace(/;$/, ''), out: `[${cur}]` };
  }
  async blurPreview(boxes, t, { W, H }) {
    t = this.clampT(t); const c = this.chunkAt(t);
    const active = boxes.filter((b) => t >= b.s - 0.01 && t <= b.e + 0.01);
    const { fc, out } = active.length ? this.blurFilter(active, W, H) : { fc: '[0:v:0]null[o]', out: '[o]' };
    return retry(async () => {
      const b = await this.run([...(await this.input(c.i, 'src', Math.max(0, t - c.start))), '-frames:v', '1', '-filter_complex', fc + `;${out}scale=1280:-2[z]`, '-map', '[z]', '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1']);
      if (b.length < 800 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error('bad jpeg');
      return b;
    }, 'blur preview', { tries: 4 });
  }
  async probe() {
    const c = this.chunks[0];
    const { url, token } = await this.sw.signed(`${this.P}/chunks/${String(c.i).padStart(3, '0')}/src.mp4`);
    const ffprobe = this.ff.replace(/ffmpeg$/, 'ffprobe');
    const out = await new Promise((res, rej) => {
      const p = spawn(ffprobe, ['-v', 'error', '-headers', `X-Auth-Token: ${token}\r\n`, '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', url]);
      const o = []; p.stdout.on('data', (d) => o.push(d)); p.on('error', rej); p.on('close', (code) => code === 0 ? res(Buffer.concat(o).toString()) : rej(new Error('ffprobe ' + code)));
    });
    const s = JSON.parse(out).streams[0]; const [n, d] = s.r_frame_rate.split('/').map(Number);
    return { W: s.width, H: s.height, fps: d ? n / d : 30 };
  }
}
module.exports = { Media };
