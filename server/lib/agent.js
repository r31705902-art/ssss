'use strict';
// Gemini editor agent: reads transcript + stats, inspects media through tools, returns the editorial plan.
const fs = require('node:fs');
const path = require('node:path');
const { Gemini, parseJsonLoose } = require('./gemini');
const { fmtTs, parseTs, log } = require('./util');

const PROMPTS = path.join(__dirname, '..', 'prompts');

function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }
function iou(a, b) {
  const [ay0, ax0, ay1, ax1] = a, [by0, bx0, by1, bx1] = b;
  const i = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0)) * Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0));
  const u = (ay1 - ay0) * (ax1 - ax0) + (by1 - by0) * (bx1 - bx0) - i;
  return u > 0 ? i / u : 0;
}

function activity(tr) {
  const r0 = tr.range[0], r1 = tr.range[1];
  const speech = new Float32Array(Math.ceil((r1 - r0) / 60) + 1);
  for (const u of tr.utts) for (let t = Math.floor(u.s); t < u.e; t++) { const m = Math.floor((t - r0) / 60); if (m >= 0 && m < speech.length) speech[m] += 1; }
  const lines = [];
  for (let m = 0; m < speech.length - 1; m++) {
    const sl = tr.loud.slice(Math.round(tr.loud_start - r0) + m * 60, Math.round(tr.loud_start - r0) + m * 60 + 60).slice().sort((a, b) => a - b);
    const med = sl.length ? sl[Math.floor(sl.length / 2)] : -90;
    lines.push(`${fmtTs(r0 + m * 60).slice(0, 5)} громк${med}dB речь${Math.min(60, Math.round(speech[m]))}с`);
  }
  const gaps = []; let last = r0;
  for (const u of tr.utts) { if (u.s - last >= 45) gaps.push(`${fmtTs(last)}–${fmtTs(u.s)} (${Math.round(u.s - last)}с)`); last = Math.max(last, u.e); }
  if (r1 - last >= 45) gaps.push(`${fmtTs(last)}–${fmtTs(r1)} (${Math.round(r1 - last)}с)`);
  const fr = (tr.freeze || []).filter((f) => f[1] - f[0] >= 30).map((f) => `${fmtTs(f[0])}–${fmtTs(f[1])}`);
  return { perMin: lines.join('\n'), gaps, freeze: fr };
}

const TOOLS = [
  { name: 'get_frames', description: 'Кадры видео (JPEG). Либо список times, либо диапазон start/end с частотой fps (кадров в секунду, 0.01–24). Максимум 24 кадра за вызов. hq=true — высокое разрешение (1280px) для мелких деталей/рекламы, иначе 640px.',
    parameters: { type: 'object', properties: { times: { type: 'array', items: { type: 'string' }, description: 'моменты "HH:MM:SS" или секунды' }, start: { type: 'string' }, end: { type: 'string' }, fps: { type: 'number' }, hq: { type: 'boolean' } } } },
  { name: 'get_video', description: 'Видео-фрагмент (360p) для просмотра движения и/или звука. fps от 1 до 24, audio=true чтобы слышать звук. Длина до 300 с; fps*длина ≤ 600 кадров (иначе fps снизится).',
    parameters: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' }, fps: { type: 'number' }, audio: { type: 'boolean' } }, required: ['start', 'end'] } },
  { name: 'get_audio', description: 'Аудио-фрагмент (до 900 с) — послушать, что реально происходит: речь, музыка, тишина, игра.',
    parameters: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } }, required: ['start', 'end'] } },
  { name: 'get_transcript', description: 'Подробный транскрипт диапазона (с пословными таймкодами, если words=true).',
    parameters: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' }, words: { type: 'boolean' } }, required: ['start', 'end'] } },
  { name: 'preview_blur', description: 'Показать кадры с применённым блюром (как в финальном рендере; красная рамка = граница блюра) в указанные моменты, чтобы проверить точность. regions — те же объекты, что пойдут в blur.',
    parameters: { type: 'object', properties: { regions: { type: 'array', items: { type: 'object', properties: { box_2d: { type: 'array', items: { type: 'number' } }, start: { type: 'string' }, end: { type: 'string' }, mode: { type: 'string', enum: ['blur', 'pixelate', 'box'] }, label: { type: 'string' } }, required: ['box_2d', 'start', 'end'] } }, times: { type: 'array', items: { type: 'string' } } }, required: ['regions', 'times'] } },
  { name: 'submit_result', description: 'Сдать итог. result_json — JSON-строка: {"stream_title","stream_description","tags":[],"speakers":{"1":"..."},"timecodes":[{"t","title"}],"thumbnail_t","videos":[{"kind":"part|highlight","title","description","tags":[],"start","end","cuts":[{"start","end","reason"}],"chapters":[{"t","title"}],"thumbnail_t"}],"boring_cuts":[{"start","end","reason"}],"blur":[{"box_2d":[ymin,xmin,ymax,xmax],"start","end","label","mode"}],"notes"}',
    parameters: { type: 'object', properties: { result_json: { type: 'string' } }, required: ['result_json'] } },
];

class Agent {
  constructor({ gemini, media, tr, opts, onEvent = () => {}, maxTurns = 70 }) {
    this.g = gemini; this.m = media; this.tr = tr; this.opts = opts; this.ev = onEvent; this.maxTurns = maxTurns;
    this.seen = []; this.frames = []; this.previews = []; this.geo = null; this.calls = 0;
  }
  T(v) { const t = parseTs(v); if (!Number.isFinite(t)) throw new Error('bad time: ' + v); return Math.min(Math.max(t, this.tr.range[0]), this.tr.range[1]); }
  transcriptText(s = -1, e = 1e12, words = false) {
    return this.tr.utts.filter((u) => u.e >= s && u.s <= e).map((u) => `[${fmtTs(u.s)}] [${u.spk}] ${u.text}` +
      (words ? '\n   ' + (u.words || []).map((w) => `${w[2]}@${w[0].toFixed(1)}`).join(' ') : '')).join('\n');
  }
  intro() {
    const tr = this.tr, m = tr.meta || {}, o = this.opts, a = activity(tr);
    const want = [o.parts !== false && 'смысловые части стрима (kind=part)', o.highlights && 'хайлайты (kind=highlight)', o.full && 'полная запись (её соберёт система из всего стрима минус boring_cuts, с твоими timecodes)'].filter(Boolean).join('; ');
    return [
      `# Стрим`, `Канал: ${m.uploader || m.channel || '?'}; название на Twitch: «${m.title || ''}»; дата: ${m.upload_date || '?'}; длительность записи: ${fmtTs(m.duration || 0)}.`,
      `Обрабатываемый диапазон: ${fmtTs(tr.range[0])}–${fmtTs(tr.range[1])}.`,
      m.chapters && m.chapters.length ? 'Категории Twitch: ' + m.chapters.map((c) => `${fmtTs(c.start_time)} ${c.title}`).join('; ') : '',
      `Спикеры по времени речи (сек): ${JSON.stringify(tr.speakers)}.`,
      `\n# Что нужно сдать\n${want}. Вырезать скучное: ${o.cut_boring !== false ? 'да' : 'нет'}. Блюр рекламы: ${o.blur_ads !== false ? 'да' : 'нет'}.` + (o.notes ? `\nПожелания пользователя: ${o.notes}` : ''),
      `\n# Активность по минутам (медианная громкость, секунд речи)\n${a.perMin}`,
      `\n# Долгие паузы без речи\n${a.gaps.join('; ') || 'нет'}`,
      `\n# Статичная картинка (freeze ≥30с)\n${a.freeze.join('; ') || 'нет'}`,
      `\n# Транскрипт\n${this.transcriptText()}`,
    ].filter(Boolean).join('\n');
  }
  examples() { try { return fs.readFileSync(path.join(PROMPTS, 'title_examples.txt'), 'utf8').split('\n').filter(Boolean).slice(0, 120).join('\n'); } catch { return ''; } }
  imgParts(list, label = 'кадр') {
    const parts = [];
    for (const f of list) {
      if (f.error) { parts.push({ text: `[${label} ${fmtTs(f.t)}: ошибка ${f.error.slice(0, 120)}]` }); continue; }
      parts.push({ text: `[${label} ${fmtTs(f.t)}]` }, { inlineData: { mimeType: 'image/jpeg', data: f.jpg.toString('base64') } });
    }
    return parts;
  }
  async tool(name, a) {
    this.calls++;
    if (name === 'get_frames') {
      let times = (a.times || []).map((x) => this.T(x));
      if (!times.length && a.start != null) {
        const s = this.T(a.start), e = this.T(a.end ?? a.start); const fps = Math.min(24, Math.max(0.001, Number(a.fps) || 1));
        for (let t = s; t <= e + 1e-6 && times.length < 24; t += 1 / fps) times.push(t);
      }
      times = times.slice(0, 24);
      const fr = await this.m.frames(times, { hq: !!a.hq });
      this.frames.push(...times);
      return { text: `Кадры: ${times.map((t) => fmtTs(t)).join(', ')}`, parts: this.imgParts(fr) };
    }
    if (name === 'get_video') {
      const s = this.T(a.start); let e = Math.min(this.T(a.end), s + 300); if (e - s < 1) e = s + 1;
      let fps = Math.min(24, Math.max(1, Math.round(Number(a.fps) || 2)));
      while (fps > 1 && fps * (e - s) > 600) fps--;
      const audio = a.audio !== false;
      const buf = await this.m.clip(s, e, { fps, audio });
      this.seen.push({ s, e, kind: 'video' });
      return { text: `Видео ${fmtTs(s)}–${fmtTs(e)} (${fps} fps, ${audio ? 'со звуком' : 'без звука'}), время в ролике 0 = ${fmtTs(s)}.`, parts: [{ inlineData: { mimeType: 'video/mp4', data: buf.toString('base64') }, videoMetadata: { fps } }] };
    }
    if (name === 'get_audio') {
      const s = this.T(a.start); const e = Math.min(this.T(a.end), s + 900);
      const buf = await this.m.audio(s, e);
      this.seen.push({ s, e, kind: 'audio' });
      return { text: `Аудио ${fmtTs(s)}–${fmtTs(e)} (0 = ${fmtTs(s)}).`, parts: [{ inlineData: { mimeType: 'audio/mp3', data: buf.toString('base64') } }] };
    }
    if (name === 'get_transcript') {
      const s = this.T(a.start), e = this.T(a.end);
      return { text: this.transcriptText(s, e, !!a.words).slice(0, 60000) || '(речи нет)' };
    }
    if (name === 'preview_blur') {
      if (!this.geo) this.geo = await this.m.probe();
      const regions = (a.regions || []).map((r) => ({ box: (r.box_2d || []).map(Number), s: this.T(r.start), e: this.T(r.end), mode: r.mode || 'blur' })).filter((r) => r.box.length === 4);
      const times = (a.times || []).slice(0, 8).map((x) => this.T(x));
      const out = [];
      for (const t of times) {
        try { out.push({ t, jpg: await this.m.blurPreview(regions, t, this.geo) }); this.previews.push({ t, regions }); } catch (e) { out.push({ t, error: e.message }); }
      }
      return { text: `Превью блюра (${regions.length} обл.) в ${times.map(fmtTs).join(', ')}. Проверь: баннер полностью закрыт? лишнее не задето?`, parts: this.imgParts(out, 'превью блюра') };
    }
    if (name === 'submit_result') {
      let r;
      try { r = parseJsonLoose(a.result_json); } catch (e) { return { text: 'Ошибка: result_json не парсится как JSON: ' + e.message }; }
      const errs = this.validate(r);
      if (errs.length) return { text: 'Результат отклонён, исправь и вызови submit_result снова:\n- ' + errs.join('\n- ') };
      this.result = r;
      return { text: 'Принято.' };
    }
    return { text: 'Неизвестный инструмент ' + name };
  }
  validate(r) {
    const errs = []; const R = this.tr.range;
    const t = (v, what) => { const x = parseTs(v); if (!Number.isFinite(x)) { errs.push(`${what}: неверное время "${v}"`); return null; } if (x < R[0] - 5 || x > R[1] + 5) errs.push(`${what}: время ${v} вне записи`); return x; };
    if (!r.stream_title) errs.push('нет stream_title');
    if (!Array.isArray(r.timecodes) || r.timecodes.length < 2) errs.push('нужны timecodes (минимум несколько)');
    const wantVideos = this.opts.parts !== false || this.opts.highlights;
    if (wantVideos && (!Array.isArray(r.videos) || !r.videos.length)) errs.push('нет videos');
    for (const [i, v] of (r.videos || []).entries()) {
      const s = t(v.start, `videos[${i}].start`), e = t(v.end, `videos[${i}].end`);
      if (s != null && e != null && e - s < 5) errs.push(`videos[${i}]: слишком короткое`);
      if (!v.title) errs.push(`videos[${i}]: нет title`);
      for (const c of v.cuts || []) this.checkCut(c, `videos[${i}].cuts`, errs);
    }
    if (this.opts.cut_boring !== false) for (const c of r.boring_cuts || []) this.checkCut(c, 'boring_cuts', errs);
    if (this.opts.blur_ads !== false) for (const [i, b] of (r.blur || []).entries()) {
      const box = (b.box_2d || []).map(Number);
      if (box.length !== 4 || box.some((x) => !(x >= 0 && x <= 1000)) || box[2] <= box[0] || box[3] <= box[1]) { errs.push(`blur[${i}]: box_2d должен быть [ymin,xmin,ymax,xmax] 0–1000`); continue; }
      if ((box[2] - box[0]) * (box[3] - box[1]) > 0.35 * 1e6) errs.push(`blur[${i}] "${b.label || ''}": слишком большая область (>35% кадра) — блюрь только баннер`);
      const s = t(b.start, `blur[${i}].start`), e = t(b.end, `blur[${i}].end`);
      const ok = this.previews.some((p) => p.regions.some((q) => iou(q.box, box) > 0.85) && p.t >= (s ?? 0) - 1 && p.t <= (e ?? 0) + 1);
      if (!ok) errs.push(`blur[${i}] "${b.label || ''}": эта рамка не проверялась через preview_blur внутри её интервала`);
    }
    return errs;
  }
  checkCut(c, what, errs) {
    const s = parseTs(c.start), e = parseTs(c.end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) { errs.push(`${what}: неверный интервал ${c.start}–${c.end}`); return; }
    const d = e - s;
    const cov = this.seen.reduce((a, x) => a + overlap(s, e, x.s, x.e), 0);
    const fr = this.frames.filter((x) => x >= s && x <= e).length;
    if (cov < Math.min(15, d * 0.3) && fr < 3) errs.push(`${what} ${fmtTs(s)}–${fmtTs(e)} (${c.reason || ''}): не проверено — посмотри get_video/get_audio по этому месту (или ≥3 кадра внутри)`);
  }
  stripOld(contents) {
    // keep media only in the last 4 tool turns to keep requests light
    let n = 0;
    for (let i = contents.length - 1; i >= 1; i--) {
      const c = contents[i];
      if (c.role !== 'user' || !c.parts.some((p) => p.inlineData)) continue;
      if (++n <= 4) continue;
      c.parts = c.parts.map((p) => (p.inlineData ? { text: '[медиа скрыто из истории; запроси заново при необходимости]' } : p));
    }
  }
  async run() {
    const R = this.tr.range, d = R[1] - R[0];
    const ts = [0.02, 0.15, 0.33, 0.5, 0.66, 0.85, 0.98].map((k) => R[0] + d * k);
    this.ev({ type: 'step', text: 'Кадры начала/середины/конца стрима' });
    const fr = await this.m.frames(ts, { hq: true }); this.frames.push(...ts);
    const system = fs.readFileSync(path.join(PROMPTS, 'system.md'), 'utf8') + '\n\n## Примеры названий популярных нарезчиков (стиль)\n' + this.examples();
    const contents = [{ role: 'user', parts: [{ text: this.intro() }, { text: '\n# Кадры (начало → середина → конец), высокое разрешение — ищи рекламные баннеры/оверлеи:' }, ...this.imgParts(fr)] }];
    for (let turn = 0; turn < this.maxTurns; turn++) {
      if (turn === this.maxTurns - 8) contents.push({ role: 'user', parts: [{ text: 'Осталось мало шагов: заверши проверки и вызови submit_result.' }] });
      this.stripOld(contents);
      const t0 = Date.now();
      let r;
      try { r = await this.g.generate({ contents, system, tools: TOOLS, temperature: 0.6 }); } catch (e) {
        if (!/image|media|video|audio|INVALID_ARGUMENT/i.test(e.message)) throw e;
        // a media part was rejected: drop media from the last turn and tell the model
        const last = contents[contents.length - 1];
        last.parts = last.parts.map((p) => (p.inlineData ? { text: '[медиа не принято моделью — запроси заново, другим способом/моментом]' } : p));
        this.ev({ type: 'step', text: 'Модель не приняла медиа, повтор без него' });
        r = await this.g.generate({ contents, system, tools: TOOLS, temperature: 0.6 });
      }
      contents.push(r.content);
      const say = Gemini.text(r.content).trim();
      const calls = Gemini.calls(r.content);
      this.ev({ type: 'model', turn, ms: Date.now() - t0, text: say.slice(0, 2000), calls: calls.map((c) => ({ name: c.name, args: c.name === 'submit_result' ? '(result)' : c.args })), tokens: r.usage.totalTokenCount });
      if (!calls.length) {
        contents.push({ role: 'user', parts: [{ text: 'Используй инструменты; когда готов — вызови submit_result с result_json.' }] });
        continue;
      }
      const resp = [], media = [];
      for (const c of calls) {
        let out;
        try { out = await this.tool(c.name, c.args || {}); } catch (e) { out = { text: 'Ошибка инструмента: ' + e.message }; }
        resp.push({ functionResponse: { name: c.name, id: c.id, response: { result: out.text } } });
        if (out.parts) media.push(...out.parts);
        this.ev({ type: 'tool', name: c.name, text: out.text.slice(0, 600) });
      }
      contents.push({ role: 'user', parts: [...resp, ...media] });
      if (this.result) return { result: this.result, turns: turn + 1, toolCalls: this.calls };
    }
    throw new Error('агент не сдал результат за ' + this.maxTurns + ' шагов');
  }
}
module.exports = { Agent };
