'use strict';
// Turn the agent's editorial decisions into render instructions + YouTube-ready text files.
const { fmtTs, ytTs, parseTs, safeName } = require('./util');

function mergeIv(iv) {
  iv = iv.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  const o = [];
  for (const x of iv) { const l = o[o.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else o.push([...x]); }
  return o;
}
function subtract(range, cuts) {
  let keep = [[range[0], range[1]]];
  for (const [a, b] of mergeIv(cuts)) {
    const n = [];
    for (const [s, e] of keep) { if (b <= s || a >= e) n.push([s, e]); else { if (a > s) n.push([s, a]); if (b < e) n.push([b, e]); } }
    keep = n;
  }
  return keep.filter(([s, e]) => e - s >= 1);
}
// original stream time -> output time (null if inside a cut; snapped forward when snap=true)
function mapper(keep) {
  return (t, snap = true) => {
    let acc = 0;
    for (const [s, e] of keep) {
      if (t < s) return snap ? acc : null;
      if (t <= e) return acc + (t - s);
      acc += e - s;
    }
    return snap ? acc : null;
  };
}
function chaptersFor(keep, chapters, total) {
  const map = mapper(keep);
  let ch = (chapters || []).map((c) => ({ t: map(parseTs(c.t)), title: String(c.title || '').trim() })).filter((c) => c.title && c.t != null && c.t < total - 5);
  ch.sort((a, b) => a.t - b.t);
  if (!ch.length || ch[0].t > 0.5) ch.unshift({ t: 0, title: (ch.length && ch[0].t < 10) ? ch.shift().title : 'Начало' });
  ch[0].t = 0;
  const out = [];
  for (const c of ch) { const l = out[out.length - 1]; if (l && c.t - l.t < 10) continue; out.push(c); } // YouTube: >= 10 s per chapter
  return out;
}
function srtFor(keep, utts) {
  const map = mapper(keep); const lines = []; let n = 1;
  for (const u of utts) {
    const ws = (u.words && u.words.length ? u.words : [[u.s, u.e, u.text]]);
    // split long utterances into ~7s cues
    let cue = [];
    const flush = () => {
      if (!cue.length) return;
      const s0 = cue[0][0], e0 = cue[cue.length - 1][1];
      const a = map(s0, false), b = map(e0, false);
      if (a != null && b != null && b > a) lines.push(`${n++}\n${fmtTs(a, true)} --> ${fmtTs(b, true)}\n${cue.map((w) => w[2]).join(' ').replace(/\s+/g, ' ').trim()}\n`);
      cue = [];
    };
    for (const w of ws) { if (cue.length && (w[1] - cue[0][0] > 7 || cue.length >= 14)) flush(); cue.push(w); }
    flush();
  }
  return lines.join('\n');
}

function build(result, { tr, opts, job, profanity }) {
  const range = tr.range; const meta = tr.meta || {};
  const clampT = (t) => Math.min(Math.max(t, range[0]), range[1]);
  const globalCuts = (opts.cut_boring !== false ? (result.boring_cuts || []) : []).map((c) => [clampT(parseTs(c.start)), clampT(parseTs(c.end))]).filter((c) => c[1] > c[0]);
  let vids = [];
  for (const v of result.videos || []) {
    const kind = v.kind || 'part';
    if (kind === 'part' && opts.parts === false) continue;
    if (kind === 'highlight' && !opts.highlights) continue;
    if (kind === 'full') continue;
    vids.push(v);
  }
  if (opts.full) vids.unshift({ kind: 'full', title: result.stream_title, description: result.stream_description, tags: result.tags, start: range[0], end: range[1], chapters: result.timecodes, cuts: [], thumbnail_t: result.thumbnail_t });
  const files = [], videos = [];
  vids.forEach((v, k) => {
    const s = clampT(parseTs(v.start)), e = clampT(parseTs(v.end));
    if (!(e - s >= 5)) return;
    const own = (v.cuts || []).map((c) => [parseTs(c.start), parseTs(c.end)]).filter((c) => c[1] > c[0]);
    const keep = subtract([s, e], [...(v.kind === 'highlight' ? [] : globalCuts), ...own]);
    const total = keep.reduce((a, [x, y]) => a + y - x, 0);
    if (total < 5) return;
    const chapters = chaptersFor(keep, v.chapters, total);
    const id = 'v' + String(k + 1).padStart(2, '0');
    const base = `${String(k + 1).padStart(2, '0')} - ${safeName(v.title, 110)}`;
    const tt = v.thumbnail_t != null ? mapper(keep)(parseTs(v.thumbnail_t)) : null;
    const tags = (v.tags || result.tags || []).map(String).slice(0, 30);
    const tc = chapters.map((c) => `${ytTs(c.t, total)} ${c.title}`).join('\n');
    const desc = [v.title, '', String(v.description || '').trim(), '', 'Таймкоды:', tc, '',
      `Оригинал стрима: ${meta.webpage_url || job.url}${meta.upload_date ? ' (' + meta.upload_date.replace(/(\d{4})(\d\d)(\d\d)/, '$3.$2.$1') + ')' : ''}`,
      `Фрагмент стрима: ${fmtTs(s)} – ${fmtTs(e)}${own.length || (v.kind !== 'highlight' && globalCuts.some((c) => c[0] < e && c[1] > s)) ? ' (скучные моменты вырезаны)' : ''}`,
      tags.length ? '\n' + tags.map((t) => '#' + t.replace(/\s+/g, '')).join(' ') : ''].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    const utts = tr.utts.filter((u) => u.e > s && u.s < e);
    videos.push({ id, kind: v.kind || 'part', title: v.title, file: base + '.mp4', keep, chapters, thumb_t: tt, duration: total, description: v.description || '', tags, src_range: [s, e] });
    files.push({ video: id, name: base + '.txt', text: desc });
    files.push({ video: id, name: base + '.srt', text: srtFor(keep, utts) });
    files.push({ video: id, name: base + '.json', text: JSON.stringify({ title: v.title, kind: v.kind, description: v.description, tags, duration: +total.toFixed(2), chapters: chapters.map((c) => ({ t: +c.t.toFixed(2), ts: ytTs(c.t, total), title: c.title })), source: { url: meta.webpage_url || job.url, range: [s, e], keep } }, null, 2) });
  });
  // stream-level text
  const st = [result.stream_title || meta.title || 'Стрим', '', String(result.stream_description || '').trim(), '', 'Таймкоды стрима (время оригинальной записи):',
    ...(result.timecodes || []).map((c) => `${ytTs(parseTs(c.t), range[1])} ${c.title}`), '',
    result.speakers ? 'Спикеры: ' + Object.entries(result.speakers).map(([k, v]) => `[${k}] ${v}`).join(', ') : ''].join('\n').trim() + '\n';
  files.push({ name: '00 - ' + safeName(result.stream_title || meta.title || 'Стрим', 110) + ' (таймкоды стрима).txt', text: st });
  const blur = opts.blur_ads === false ? [] : (result.blur || []).map((b) => ({ box: (b.box_2d || b.box).map(Number), s: clampT(parseTs(b.start)), e: clampT(parseTs(b.end)), mode: b.mode || 'blur', label: b.label || '' })).filter((b) => b.box.length === 4 && b.e > b.s);
  return { videos, files, blur, bleep: profanity ? profanity.intervals : [] };
}

function pieces(videos, { pieceSec = 600, maxPieces = 250 } = {}) {
  const total = videos.reduce((a, v) => a + v.duration, 0);
  pieceSec = Math.max(pieceSec, Math.ceil(total / maxPieces));
  const out = [];
  for (const v of videos) {
    let cur = [], acc = 0, idx = 0;
    for (let [s, e] of v.keep) {
      while (e > s) {
        const take = Math.min(e - s, pieceSec - acc);
        cur.push([+s.toFixed(3), +(s + take).toFixed(3)]); acc += take; s += take;
        if (acc >= pieceSec - 0.5) { out.push({ video: v.id, idx: idx++, keep: cur }); cur = []; acc = 0; }
      }
    }
    if (cur.length) {
      if (acc < 20 && idx > 0) out[out.length - 1].keep.push(...cur); // avoid tiny tail pieces
      else out.push({ video: v.id, idx: idx++, keep: cur });
    }
  }
  return out.map((p, i) => ({ p: i, ...p }));
}
module.exports = { build, pieces, subtract, mapper, mergeIv };
