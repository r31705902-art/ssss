'use strict';
// autocut web server. Standalone: `node server.js` (PORT / ALWAYSDATA_HTTPD_PORT), or mount: require('./server').mount(cfgPath) -> handle(req,res,path)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { log, setLogFile, safeEq, readJson, fmtTs } = require('./lib/util');
const { Swift } = require('./lib/swift');
const { GH } = require('./lib/gh');
const { Gemini } = require('./lib/gemini');
const { Jobs } = require('./lib/jobs');
const { Media } = require('./lib/media');
const { zipLayout, tarLayout, serveLayout } = require('./lib/archive');

function mount(cfgPath = process.env.AUTOCUT_CONFIG || path.join(process.env.HOME || '.', 'autocut-data', 'config.json')) {
  const cfg = readJson(cfgPath);
  if (!cfg) throw new Error('config not found: ' + cfgPath);
  const dataDir = cfg.data_dir || path.dirname(cfgPath);
  setLogFile(path.join(dataDir, 'autocut.log'));
  const BASE = (cfg.base || '').replace(/\/$/, '');
  const swift = new Swift({ user: cfg.blomp.user, pass: cfg.blomp.pass, authUrl: cfg.blomp.auth_url });
  const gh = new GH({ token: cfg.github.token, repo: cfg.github.repo });
  const gemini = new Gemini(cfg.gemini);
  const jobs = new Jobs({ cfg, swift, gh, gemini, dataDir });
  const UI = path.join(__dirname, 'public', 'index.html');
  const SECRET = crypto.createHash('sha256').update('autocut:' + cfg.password + ':' + cfg.hook_secret).digest('hex');
  const sign = (v) => v + '.' + crypto.createHmac('sha256', SECRET).update(v).digest('hex').slice(0, 32);
  const authed = (req) => {
    if (!cfg.password) return true;
    const c = /(?:^|;\s*)ac_s=([^;]+)/.exec(req.headers.cookie || '');
    if (c) { const [v] = c[1].split('.'); if (safeEq(sign(v), c[1]) && Number(v) > Date.now()) return true; }
    return safeEq(req.headers['x-password'] || '', cfg.password);
  };
  const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  const body = (req, max = 1 << 20) => new Promise((ok, bad) => { const b = []; let n = 0; req.on('data', (d) => { n += d.length; if (n > max) { bad(new Error('too big')); req.destroy(); } else b.push(d); }); req.on('end', () => { try { ok(b.length ? JSON.parse(Buffer.concat(b).toString()) : {}); } catch (e) { bad(e); } }); req.on('error', bad); });
  const pub = (j) => ({ id: j.id, url: j.url, state: j.state, stage: j.stage, created: j.created, updated: j.updated, title: j.result?.stream_title || j.meta?.title, channel: j.meta?.uploader, duration: j.meta?.duration, range: j.range, error: j.error });
  const full = (j) => ({ ...pub(j), opts: j.opts, meta: j.meta && { title: j.meta.title, uploader: j.meta.uploader, duration: j.meta.duration, upload_date: j.meta.upload_date, thumbnail: j.meta.thumbnail, webpage_url: j.meta.webpage_url },
    events: j.events.slice(-150), ingest: j.ingest, render: j.render, analysis: j.analysis && { started: j.analysis.started, done: j.analysis.done, turns: j.analysis.turns, steps: j.analysis.steps.slice(-150) },
    result: j.result, outputs: j.outputs && { videos: j.outputs.videos, files: j.outputs.files.map((f) => ({ name: f.name, video: f.video, size: f.size })), blur: j.outputs.blur, bleeps: j.outputs.bleeps, pieces: j.outputs.pieces, manifest: j.outputs.manifest },
    profanity: j.profanity, speakers: j.speakers, download: j.state === 'done' ? `${BASE}/dl/${j.id}/${j.dl}` : null });

  async function handle(req, res, p) {
    try {
      if (p === '' || p === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(fs.readFileSync(UI, 'utf8').replace(/__BASE__/g, BASE)); }
      if (p === '/api/hook' && req.method === 'POST') {
        if (!safeEq(req.headers['x-hook-secret'] || '', cfg.hook_secret)) return json(res, 403, { error: 'bad secret' });
        jobs.hook(await body(req)); return json(res, 200, { ok: true });
      }
      if (p === '/api/login' && req.method === 'POST') {
        const b = await body(req);
        if (!safeEq(b.password || '', cfg.password)) return json(res, 401, { error: 'неверный пароль' });
        const v = String(Date.now() + 30 * 86400e3);
        res.writeHead(200, { 'Set-Cookie': `ac_s=${sign(v)}; Path=${BASE || '/'}; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax`, 'Content-Type': 'application/json' });
        return res.end('{"ok":true}');
      }
      let m;
      if ((m = /^\/dl\/([\w-]+)\/(\w+)(?:\/(archive\.zip|archive\.tar|f\/(\d+)))?$/.exec(p))) {
        const j = jobs.get(m[1]); if (!j || !safeEq(j.dl, m[2]) || !j.outputs) return json(res, 404, { error: 'нет такой нарезки' });
        if (!m[3]) { res.writeHead(302, { Location: `${BASE}/#job=${j.id}` }); return res.end(); }
        const { folder, entries } = jobs.entries(j);
        if (m[4] != null) {
          const e = entries[Number(m[4])]; if (!e) return json(res, 404, {});
          const L = { segs: [{ blomp: e.blomp, size: e.size }], size: e.size };
          const fn = e.name.split('/').pop();
          return serveLayout(L, swift, req, res, { filename: fn, type: /\.mp4$/.test(fn) ? 'video/mp4' : /\.jpg$/.test(fn) ? 'image/jpeg' : 'text/plain; charset=utf-8' });
        }
        const tar = m[3] === 'archive.tar';
        const L = tar ? tarLayout(entries) : zipLayout(entries);
        log(`download ${j.id} ${m[3]} ${(L.size / 1e6).toFixed(0)}MB range=${req.headers.range || '-'}`);
        return serveLayout(L, swift, req, res, { filename: folder + (tar ? '.tar' : '.zip'), type: tar ? 'application/x-tar' : 'application/zip' });
      }
      if (!authed(req)) return json(res, 401, { error: 'auth' });
      if (p === '/api/me') return json(res, 200, { ok: true, defaults: cfg.defaults, model: cfg.gemini.model });
      if (p === '/api/jobs' && req.method === 'GET') return json(res, 200, jobs.list().map(pub));
      if (p === '/api/jobs' && req.method === 'POST') { const b = await body(req); const j = jobs.create(b.url, b.opts); return json(res, 200, pub(j)); }
      if ((m = /^\/api\/jobs\/([\w-]+)(?:\/(\w+))?$/.exec(p))) {
        const j = jobs.get(m[1]); if (!j) return json(res, 404, { error: 'нет задачи' });
        const a = m[2];
        if (!a && req.method === 'GET') return json(res, 200, full(j));
        if (a === 'entries') return json(res, 200, j.outputs ? jobs.entries(j).entries.map((e, i) => ({ i, name: e.name, size: e.size })) : []);
        if (a === 'frame') {
          const u = new URL(req.url, 'http://x'); const t = Number(u.searchParams.get('t') || 0);
          const tr = j._chunks || (j._chunks = (await swift.getJson(`autocut/jobs/${j.id}/plan.json`))?.chunks?.map((c) => ({ i: c.i, start: c.start, end: c.end })));
          if (!tr) return json(res, 404, {});
          const md = new Media({ swift, ffmpeg: cfg.ffmpeg || 'ffmpeg', tmp: jobs.tmp, jobPrefix: `autocut/jobs/${j.id}`, chunks: tr });
          const jpg = await md.frame(t, { hq: u.searchParams.get('hq') === '1' });
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' }); return res.end(jpg);
        }
        if (a === 'transcript') { const t = await swift.getText(`autocut/jobs/${j.id}/transcript.txt`, ''); res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(t); }
        if (req.method !== 'POST') return json(res, 405, {});
        const b = await body(req).catch(() => ({}));
        if (a === 'cancel') await jobs.cancel(j);
        else if (a === 'retry') jobs.retry(j);
        else if (a === 'reanalyze') jobs.reanalyze(j, b.notes);
        else if (a === 'rerender') { if (b.opts) Object.assign(j.opts, b.opts); await jobs.prepareRender(j); jobs.set(j, 'render_wait', 'перерендер'); }
        else if (a === 'delete') { await jobs.remove(j, b.purge !== false); return json(res, 200, { ok: true }); }
        else return json(res, 404, {});
        return json(res, 200, pub(j));
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      log('http error', p, e.stack || e.message);
      if (!res.headersSent) json(res, 500, { error: e.message }); else res.destroy();
    }
  }
  log(`autocut mounted at ${BASE || '/'} (repo ${cfg.github.repo}, model ${cfg.gemini.model})`);
  return { handle, base: BASE, jobs };
}

module.exports = { mount };

if (require.main === module) {
  const app = mount();
  const port = Number(process.env.PORT || process.env.ALWAYSDATA_HTTPD_PORT || 8100);
  http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0];
    if (app.base && !(p === app.base || p.startsWith(app.base + '/'))) { res.writeHead(302, { Location: app.base + '/' }); return res.end(); }
    app.handle(req, res, p.slice(app.base.length));
  }).listen(port, process.env.ALWAYSDATA_HTTPD_IP || undefined, () => log('listening on', port));
}
