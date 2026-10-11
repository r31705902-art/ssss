'use strict';
// Russian mat detection: NVIDIA-hosted LLM returns the list of profane word forms found in the transcript vocabulary,
// merged with a root-regex safety net. Result -> bleep intervals from word timestamps.
const { retry, log } = require('./util');

const ROOTS = /(^|[^а-яё])(х[уy][йеёяюиль]|хуе|хуё|п[иеi]зд|[её]б[аеиуоыё]|[её]бл|еб[её]|ёб|въеб|выеб|заеб|наеб|отъеб|поеб|переёб|разъеб|уеб|долбо[её]б|бл[яэ][дтх]?|бляд|мудак|муди[лх]|пид[оаеи]р|пидр|залуп|г[ао]ндон|манд[аы])/i;
const SAFE = new Set(['хлеб', 'колебаться', 'ребята', 'требовать', 'гребля', 'себя', 'тебя', 'небо', 'учеба', 'сука']);

function norm(w) { return String(w).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9*-]/gi, ''); }
const PREF = /^(на|ни|по|за|от|до|о|а|вы|при|рас|рас|под|недо|пере)?(х[уy][йеёяюил]|п[иi]зд|[её]б[ауон])/i;
function regexHit(w) { const n = norm(w); if (!n || SAFE.has(n) || /^(худ|хули[гг]ан|страху|застрах|ебол)/.test(n)) return false; return ROOTS.test(' ' + n) || PREF.test(n); }

async function nvidiaList(vocab, { key, model, fallbackModels = [], baseUrl = 'https://integrate.api.nvidia.com/v1' }) {
  const words = new Set();
  const batches = [];
  for (let i = 0; i < vocab.length; i += 300) batches.push(vocab.slice(i, i + 300));
  const ask = async (batch, m, ms) => {
    const r = await fetch(baseUrl + '/chat/completions', { method: 'POST', signal: AbortSignal.timeout(ms), headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, temperature: 0.2, top_p: 0.95, max_tokens: 8192, stream: false, ...(/gpt-oss/.test(m) ? { reasoning_effort: 'low' } : {}), messages: [
        { role: 'system', content: 'Ты модератор русской речи. Из списка слов (транскрипт стрима) выбери ВСЕ нецензурные (русский мат и его производные, эвфемизмы-замены вроде "бля", "пздц", искажённые/слитные формы, англ. fuck/shit тоже). Не включай обычную грубость без мата (дурак, тупой). Ответ строго JSON: {"words":["...", ...]} — слова в точности как в списке.' },
        { role: 'user', content: batch.join(' ') }] }) });
    if (!r.ok) throw new Error('nvidia ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    const txt = (j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '');
    const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
    return JSON.parse(txt.slice(a, b + 1)).words || [];
  };
  let i = 0, used = model; const dead = new Set();
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < batches.length) {
      const batch = batches[i++];
      let got = null;
      for (const [k, m] of [model, ...fallbackModels].filter(Boolean).entries()) {
        if (dead.has(m)) continue;
        // primary gets one short attempt (deepseek on NVIDIA often hangs) and is skipped afterwards; fallbacks get retries
        try { got = await retry(() => ask(batch, m, k ? 120000 : 75000), 'nvidia ' + m, { tries: k ? 2 : 1, base: 3000 }); used = m; break; } catch (e) { log('profanity model failed', m, e.message); dead.add(m); }
      }
      for (const w of got || []) words.add(norm(w));
    }
  }));
  return { words, model: used };
}

async function detect(utts, cfg) {
  const vocab = new Map();
  for (const u of utts) for (const w of u.words || []) { const n = norm(w[2]); if (n.length > 1) vocab.set(n, (vocab.get(n) || 0) + 1); }
  const list = [...vocab.keys()];
  let llm = { words: new Set(), model: null }, err = null;
  if (cfg.key) { try { llm = await nvidiaList(list, cfg); } catch (e) { err = e.message; } }
  const hits = [], found = new Map();
  for (const u of utts) for (const w of u.words || []) {
    const n = norm(w[2]);
    if (n && (llm.words.has(n) || regexHit(n))) { hits.push([Math.max(0, w[0] - 0.05), w[1] + 0.05]); found.set(n, (found.get(n) || 0) + 1); }
  }
  hits.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const h of hits) { const l = merged[merged.length - 1]; if (l && h[0] <= l[1] + 0.15) l[1] = Math.max(l[1], h[1]); else merged.push([...h]); }
  return { intervals: merged.map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)]), words: Object.fromEntries([...found.entries()].sort((a, b) => b[1] - a[1])), llmWords: llm.words.size, model: llm.model, error: err, vocab: list.length };
}
module.exports = { detect, regexHit };
