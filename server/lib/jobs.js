'use strict';
// Job state machine: queued -> ingest (GH) -> analyze (Gemini agent, here) -> render_wait -> render (GH) -> done
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { log, rid, readJson, writeJson, crc32, sleep, fmtTs } = require('./util');
const { Agent } = require('./agent');
const { Media } = require('./media');
const outputs = require('./outputs');
const profanity = require('./profanity');

const ACTIVE_GH = ['ingest', 'render'];

class Jobs {
  constructor({ cfg, swift, gh, gemini, dataDir }) {
    this.cfg = cfg; this.sw = swift; this.gh = gh; this.g = gemini; this.dir = path.join(dataDir, 'jobs');
    fs.mkdirSync(this.dir, { recursive: true });
    // media temp files go to tmpfs (home quota on shared hosting is tiny)
    this.tmp = cfg.tmp_dir || path.join(require('node:os').tmpdir(), 'autocut-' + (process.getuid ? process.getuid() : 'u')); fs.mkdirSync(this.tmp, { recursive: true });
    this.mirrorAt = new Map();
    this.jobs = new Map(); this.running = new Set(); this.dirty = new Set();
    for (const f of fs.readdirSync(this.dir)) if (f.endsWith('.json')) { const j = readJson(path.join(this.dir, f)); if (j && j.id) this.jobs.set(j.id, j); }
    log(`jobs loaded: ${this.jobs.size}`);
    this.restore().catch((e) => log('state restore failed', e.message));
    this.timer = setInterval(() => this.tick().catch((e) => log('tick error', e.message)), 15000);
    setInterval(() => this.flush(), 3000);
    setTimeout(() => this.tick().catch(() => {}), 2000);
    setInterval(() => this.cleanup().catch((e) => log('cleanup', e.message)), 6 * 3600e3);
  }
  P(j) { return `autocut/jobs/${j.id}`; }
  save(j, now = false) { j.updated = Date.now(); this.dirty.add(j.id); if (now) this.flush(); }
  flush() {
    for (const id of this.dirty) {
      const j = this.jobs.get(id); if (!j) continue;
      try { writeJson(path.join(this.dir, id + '.json'), j); } catch (e) { if (!this._wErr || Date.now() - this._wErr > 60e3) { this._wErr = Date.now(); log('local state write failed (disk quota?)', e.message); } }
      // mirror job state to Blomp so it survives a full/broken local disk
      const last = this.mirrorAt.get(id) || 0;
      if (Date.now() - last > 30e3 || ['done', 'failed', 'canceled'].includes(j.state)) {
        this.mirrorAt.set(id, Date.now());
        const { _chunks, ...clean } = j;
        this.sw.putJson(`autocut/state/${id}.json`, clean).catch((e) => log('state mirror failed', id, e.message));
      }
    }
    this.dirty.clear();
  }
  async restore() {
    const objs = await this.sw.list('autocut/state/');
    let n = 0;
    for (const o of objs) {
      const id = (o.name || o).split('/').pop().replace(/\.json$/, '');
      if (!id || this.jobs.has(id)) continue;
      const j = await this.sw.getJson(`autocut/state/${id}.json`); if (!j || !j.id || j.deleted) continue;
      this.jobs.set(j.id, j); n++;
    }
    if (n) log(`restored ${n} jobs from Blomp`);
  }
  ev(j, text, extra) {
    j.events = j.events || [];
    j.events.push({ t: Date.now(), text, ...(extra || {}) });
    if (j.events.length > 600) j.events.splice(0, j.events.length - 600);
    this.save(j);
  }
  set(j, state, stage) { j.state = state; if (stage !== undefined) j.stage = stage; this.ev(j, `→ ${state}${stage ? ': ' + stage : ''}`); this.save(j, true); }
  list() { return [...this.jobs.values()].sort((a, b) => b.created - a.created); }
  get(id) { return this.jobs.get(id); }
  create(url, opts) {
    url = String(url || '').trim();
    if (!/^https?:\/\//.test(url)) throw new Error('нужен URL');
    const d = new Date();
    const id = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${rid(6)}`;
    const o = { ...this.cfg.defaults, ...(opts || {}) };
    for (const k of ['workers', 'quality', 'range_start', 'range_end']) if (o[k] != null) o[k] = Number(o[k]) || 0;
    o.workers = Math.min(Math.max(o.workers || 25, 1), 60);
    const j = { id, url, opts: o, created: Date.now(), state: 'queued', stage: 'в очереди', dl: rid(16), events: [], ingest: { chunks: {}, tries: 0 }, render: { pieces: {}, tries: 0 } };
    this.jobs.set(id, j); this.ev(j, 'создано: ' + url); this.save(j, true);
    setTimeout(() => this.tick().catch(() => {}), 100);
    return j;
  }
  async remove(j, purge = true) {
    if (j.ingest?.run && j.state === 'ingest') await this.gh.cancel(j.ingest.run);
    if (j.render?.run && j.state === 'render') await this.gh.cancel(j.render.run);
    this.jobs.delete(j.id); fs.rmSync(path.join(this.dir, j.id + '.json'), { force: true });
    this.sw.del(`autocut/state/${j.id}.json`).catch(() => {});
    if (purge) this.sw.delPrefix(this.P(j) + '/').then((n) => log(`purged ${n} objects of ${j.id}`)).catch(() => {});
  }
  async cancel(j) {
    if (j.ingest?.run && j.state === 'ingest') await this.gh.cancel(j.ingest.run);
    if (j.render?.run && j.state === 'render') await this.gh.cancel(j.render.run);
    this.set(j, 'canceled', 'отменено');
  }
  retry(j) {
    const st = j.failedAt || 'ingest';
    j.error = null;
    if (st === 'ingest') { j.ingest.tries = 0; this.set(j, 'queued', 'повтор: загрузка'); }
    else if (st === 'analyze') this.set(j, 'analyze', 'повтор анализа');
    else { j.render.tries = 0; this.set(j, 'render_wait', 'повтор рендера'); }
  }
  reanalyze(j, notes) { if (notes != null) j.opts.notes = notes; j.analysis = null; this.set(j, 'analyze', 'повторный анализ'); }
  fail(j, where, msg) { j.error = msg; j.failedAt = where; this.set(j, 'error', `${where}: ${String(msg).slice(0, 300)}`); }

  hook(b) {
    const j = this.jobs.get(b.job); if (!j) return;
    if (b.kind === 'chunk') { j.ingest.chunks[b.chunk] = { stage: b.stage, pct: b.pct, t: Date.now(), error: b.error, elapsed: b.elapsed }; if (b.stage === 'error') this.ev(j, `кусок ${b.chunk}: ошибка ${b.error}`); }
    else if (b.kind === 'plan') { if (b.meta) j.meta = b.meta; if (b.chunks) j.ingest.total = b.chunks; j.stage = b.stage === 'planned' ? `загрузка: ${b.chunks} кусков` : 'разбор ссылки'; if (b.range) j.range = b.range; }
    else if (b.kind === 'merge') { j.stage = b.stage === 'done' ? 'транскрипт собран' : 'склейка: ' + (b.error || b.stage); if (b.speakers) j.speakers = b.speakers; }
    else if (b.kind === 'piece') j.render.pieces[b.piece] = { stage: b.stage, t: Date.now(), error: b.error, elapsed: b.elapsed };
    else if (b.kind === 'video') this.ev(j, `видео ${b.video} собрано (${(b.size / 1e6).toFixed(0)} МБ)`);
    this.save(j);
  }

  ghBusy() { return [...this.jobs.values()].filter((j) => ACTIVE_GH.includes(j.state)).length >= (this.cfg.max_gh_jobs || 1); }

  async tick() {
    if (this._ticking) return; this._ticking = true;
    try {
      for (const j of this.list().reverse()) {
        try {
          if (j.state === 'queued' && !this.ghBusy()) await this.startIngest(j);
          else if (j.state === 'ingest') await this.pollIngest(j);
          else if (j.state === 'analyze' && !this.running.has(j.id)) this.analyze(j);
          else if (j.state === 'render_wait' && !this.ghBusy()) await this.startRender(j);
          else if (j.state === 'render') await this.pollRender(j);
        } catch (e) { log(`job ${j.id} tick: ${e.message}`); this.ev(j, 'ошибка шага: ' + e.message.slice(0, 300)); if (e.fatal) this.fail(j, j.state === 'render' || j.state === 'render_wait' ? 'render' : 'ingest', e.message); }
      }
    } finally { this._ticking = false; }
  }

  async startIngest(j, only = '') {
    const o = j.opts;
    const inputs = { job_id: j.id, url: j.url, workers: String(o.workers), quality: String(o.quality || 1080), range_start: String(o.range_start || 0), range_end: String(o.range_end || 0),
      whisper_model: o.whisper_model || 'large-v3-turbo', language: o.language || 'ru', only };
    this.set(j, 'ingest', only ? `перезапуск кусков ${only}` : 'запуск воркеров');
    j.ingest.run = await this.gh.dispatch('ingest', inputs, 'ingest ' + j.id);
    j.ingest.started = j.ingest.started || Date.now();
    this.ev(j, 'GitHub run ' + j.ingest.run, { run: j.ingest.run }); this.save(j, true);
  }
  async pollIngest(j) {
    if (!j.ingest.run) return this.startIngest(j);
    const run = await this.gh.run(j.ingest.run);
    if (run.status !== 'completed') { if (!j.ingest.total || Date.now() - (j.ingest.jt || 0) > 60e3) { j.ingest.jt = Date.now(); this.syncJobs(j, run.id, 'ingest'); } return; }
    const tr = await this.sw.head(this.P(j) + '/transcript.json.gz');
    const missing = await this.sw.getJson(this.P(j) + '/missing.json', null);
    if (tr && run.conclusion === 'success') { j.ingest.done = Date.now(); this.ev(j, `загрузка+транскрипт готовы за ${Math.round((j.ingest.done - j.ingest.started) / 1000)} с`); this.set(j, 'analyze', 'анализ ИИ'); return this.analyze(j); }
    if (run.conclusion === 'cancelled') return this.fail(j, 'ingest', 'GitHub run отменён');
    if (missing && missing.length && j.ingest.tries < 3) {
      j.ingest.tries++; await this.sw.del(this.P(j) + '/missing.json');
      this.ev(j, `не хватает кусков ${missing.join(',')} — перезапуск (${j.ingest.tries}/3)`);
      return this.startIngest(j, missing.join(','));
    }
    if (tr) { this.set(j, 'analyze', 'анализ ИИ (часть воркеров с ошибкой, транскрипт есть)'); return this.analyze(j); }
    if (!(await this.sw.head(this.P(j) + '/plan.json'))) return this.fail(j, 'ingest', 'не удалось разобрать ссылку (plan) — проверь URL');
    if (j.ingest.tries < 2) { j.ingest.tries++; this.ev(j, 'ingest упал, повтор'); return this.startIngest(j); }
    this.fail(j, 'ingest', 'ingest завершился с ошибкой: ' + run.conclusion);
  }
  async syncJobs(j, runId, kind) {
    try {
      const js = await this.gh.jobs(runId);
      const st = {}; for (const x of js) st[x.status + (x.conclusion ? '/' + x.conclusion : '')] = (st[x.status + (x.conclusion ? '/' + x.conclusion : '')] || 0) + 1;
      j[kind].gh = st; this.save(j);
    } catch {}
  }

  async loadTranscript(j) {
    const b = await this.sw.get(this.P(j) + '/transcript.json.gz');
    return JSON.parse(zlib.gunzipSync(b).toString('utf8'));
  }
  async analyze(j) {
    if (this.running.has(j.id)) return; this.running.add(j.id);
    try {
      const tr = await this.loadTranscript(j);
      j.meta = j.meta || tr.meta; j.range = tr.range; j.speakers = tr.speakers;
      j.analysis = { started: Date.now(), steps: [] };
      const media = new Media({ swift: this.sw, ffmpeg: this.cfg.ffmpeg || 'ffmpeg', tmp: this.tmp, jobPrefix: this.P(j), chunks: tr.chunks });
      const step = (e) => {
        const s = e.type === 'model' ? { k: 'model', t: Date.now(), text: e.text, calls: e.calls, ms: e.ms, tokens: e.tokens } : { k: e.type, t: Date.now(), name: e.name, text: e.text };
        j.analysis.steps.push(s); if (j.analysis.steps.length > 400) j.analysis.steps.shift();
        if (e.type === 'model') j.stage = `анализ ИИ: шаг ${e.turn + 1}` + (e.calls && e.calls.length ? ' (' + e.calls.map((c) => c.name).join(', ') + ')' : '');
        this.save(j);
      };
      const profP = j.opts.bleep ? profanity.detect(tr.utts, this.cfg.nvidia || {}).catch((e) => ({ intervals: [], error: e.message })) : Promise.resolve(null);
      const agent = new Agent({ gemini: this.g, media, tr, opts: j.opts, onEvent: step, maxTurns: this.cfg.max_turns || 70 });
      const [res, prof] = await Promise.all([agent.run(), profP]);
      if (prof) { j.profanity = { count: prof.intervals.length, words: prof.words, model: prof.model, error: prof.error }; this.ev(j, `маты: ${prof.intervals.length} мест` + (prof.error ? ' (LLM: ' + prof.error.slice(0, 100) + ', сработал словарь)' : ` (модель ${prof.model})`)); }
      j.result = res.result; j.analysis.turns = res.turns; j.analysis.done = Date.now();
      this.ev(j, `анализ готов: ${res.turns} шагов, ${res.toolCalls} вызовов инструментов, ${Math.round((j.analysis.done - j.analysis.started) / 1000)} с`);
      await this.prepareRender(j, tr, prof);
      this.set(j, 'render_wait', 'ожидание рендера');
      this.tick().catch(() => {});
    } catch (e) {
      log('analyze failed', j.id, e.stack || e.message);
      this.fail(j, 'analyze', e.message);
    } finally { this.running.delete(j.id); }
  }
  async prepareRender(j, tr, prof) {
    if (!tr) tr = await this.loadTranscript(j);
    if (prof === undefined && j.opts.bleep) prof = await profanity.detect(tr.utts, this.cfg.nvidia || {});
    const b = outputs.build(j.result, { tr, opts: j.opts, job: j, profanity: prof });
    const enc = { crf: j.opts.crf || 21, preset: j.opts.preset || 'veryfast', height: j.opts.out_height || 0, fps: j.opts.out_fps || 60 };
    const pieces = outputs.pieces(b.videos, { pieceSec: j.opts.piece_sec || 600 });
    const render = { job: j.id, chunks: tr.chunks, videos: b.videos.map((v) => ({ id: v.id, file: v.file, title: v.title, description: v.description, chapters: v.chapters, thumb_t: v.thumb_t })),
      pieces, blur: b.blur, bleep: b.bleep, bleep_mode: j.opts.bleep_mode || 'beep', encode: enc };
    await this.sw.putJson(this.P(j) + '/render.json', render);
    // text files -> Blomp
    const files = [];
    const txt = tr.utts.map((u) => `[${fmtTs(u.s)}] [${u.spk}] ${u.text}`).join('\n') + '\n';
    const all = [...b.files, { name: 'transcript.txt', text: (j.result.speakers ? 'Спикеры: ' + Object.entries(j.result.speakers).map(([k, v]) => `[${k}] ${v}`).join(', ') + '\n\n' : '') + txt }];
    for (const [k, f] of all.entries()) {
      const buf = Buffer.from(f.text, 'utf8'); const name = `${this.P(j)}/out/text/${String(k).padStart(3, '0')}`;
      await this.sw.put(name, buf, 'text/plain; charset=utf-8');
      files.push({ name: f.name, video: f.video, blomp: name, size: buf.length, crc: crc32(buf) });
    }
    j.outputs = { videos: render.videos.map((v) => ({ ...v, duration: b.videos.find((x) => x.id === v.id).duration, kind: b.videos.find((x) => x.id === v.id).kind })), files, blur: b.blur, bleeps: b.bleep.length, pieces: pieces.length };
    j.render = { pieces: {}, tries: 0 };
    this.ev(j, `план рендера: ${render.videos.length} видео, ${pieces.length} кусков, блюр ${b.blur.length}, бипов ${b.bleep.length}`);
    this.save(j, true);
  }
  async startRender(j, list) {
    const n = j.outputs.pieces;
    const idx = list || Array.from({ length: n }, (_, i) => i);
    this.set(j, 'render', list ? `перерендер кусков ${list.join(',')}` : `рендер ${n} кусков`);
    j.render.run = await this.gh.dispatch('render', { job_id: j.id, pieces: JSON.stringify(idx) }, 'render ' + j.id);
    j.render.started = j.render.started || Date.now();
    this.ev(j, 'GitHub run ' + j.render.run, { run: j.render.run }); this.save(j, true);
  }
  async pollRender(j) {
    if (!j.render.run) return this.startRender(j);
    const run = await this.gh.run(j.render.run);
    if (run.status !== 'completed') { if (Date.now() - (j.render.jt || 0) > 60e3) { j.render.jt = Date.now(); this.syncJobs(j, run.id, 'render'); } return; }
    const man = (await this.sw.getJson(this.P(j) + '/out/manifest.json', {})) || {};
    const missing = j.outputs.videos.filter((v) => !man[v.id]);
    if (!missing.length) {
      j.outputs.manifest = man; j.render.done = Date.now();
      this.ev(j, `рендер готов за ${Math.round((j.render.done - j.render.started) / 1000)} с`);
      this.set(j, 'done', 'готово');
      this.sw.delPrefix(this.P(j) + '/render/').catch(() => {});
      return;
    }
    if (run.conclusion === 'cancelled') return this.fail(j, 'render', 'GitHub run отменён');
    if (j.render.tries < 2) {
      j.render.tries++;
      const rp = await this.sw.getJson(this.P(j) + '/render.json');
      const need = [];
      for (const p of rp.pieces) if (missing.some((v) => v.id === p.video) && !(await this.sw.head(`${this.P(j)}/render/${p.video}/${String(p.idx).padStart(4, '0')}.mp4`))) need.push(p.p);
      this.ev(j, `не собраны видео ${missing.map((v) => v.id).join(',')}, перерендер кусков [${need.join(',')}] (${j.render.tries}/2)`);
      return this.startRender(j, need.length ? need : [0]);
    }
    this.fail(j, 'render', 'рендер не удался: ' + missing.map((v) => v.id).join(','));
  }
  // zip/tar entries
  entries(j) {
    const man = j.outputs?.manifest || {};
    const out = [];
    const folder = (j.result?.stream_title ? require('./util').safeName(j.result.stream_title, 80) : j.id);
    for (const f of j.outputs.files.filter((f) => !f.video)) out.push({ name: `${folder}/${f.name}`, blomp: f.blomp, size: f.size, crc: f.crc });
    for (const v of j.outputs.videos) {
      const m = man[v.id]; const base = v.file.replace(/\.mp4$/, '');
      if (m) out.push({ name: `${folder}/${v.file}`, blomp: `${this.P(j)}/out/${v.id}.mp4`, size: m.size, crc: m.crc });
      if (m && m.thumb) out.push({ name: `${folder}/${base}.jpg`, blomp: `${this.P(j)}/out/${v.id}.jpg`, size: m.thumb.size, crc: m.thumb.crc });
      for (const f of j.outputs.files.filter((f) => f.video === v.id)) out.push({ name: `${folder}/${f.name}`, blomp: f.blomp, size: f.size, crc: f.crc });
    }
    return { folder, entries: out };
  }
  async cleanup() {
    const days = this.cfg.keep_source_days ?? 7;
    for (const j of this.jobs.values()) {
      if (j.state === 'done' && !j.sourcePurged && Date.now() - (j.render?.done || j.updated) > days * 86400e3) {
        const n = await this.sw.delPrefix(this.P(j) + '/chunks/'); j.sourcePurged = Date.now(); this.ev(j, `исходники удалены из Blomp (${n} объектов)`);
      }
    }
  }
}
module.exports = { Jobs };
