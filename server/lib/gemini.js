'use strict';
// Gemini native API (generateContent) through the custom AI-Studio proxy. Supports function calling + inline media.
const { retry, log, sleep } = require('./util');

class Gemini {
  constructor({ baseUrl, key, model }) {
    this.base = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, ''); this.key = key; this.model = model;
  }
  async generate({ contents, system, tools, json = false, temperature = 0.7, maxTokens = 65536, thinking = 'high', model }) {
    const body = { contents, generationConfig: { temperature, maxOutputTokens: maxTokens } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools) body.tools = [{ functionDeclarations: tools }];
    if (json) body.generationConfig.responseMimeType = 'application/json';
    if (thinking) body.generationConfig.thinkingConfig = { thinkingLevel: thinking };
    const m = model || this.model;
    return retry(async (i) => {
      const r = await fetch(`${this.base}/v1beta/models/${m}:generateContent`, { method: 'POST', signal: AbortSignal.timeout(15 * 60e3),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.key }, body: JSON.stringify(body) });
      const t = await r.text();
      if (r.status === 400 && i < 2 && /thinking/i.test(t)) { delete body.generationConfig.thinkingConfig; throw new Error('400 thinking unsupported, retry without'); }
      if (!r.ok) { const e = new Error(`gemini ${r.status}: ${t.slice(0, 400)}`); if (r.status === 400 && (i >= 2 || /Unable to process|INVALID_ARGUMENT/.test(t))) e.fatal = true; throw e; }
      const j = JSON.parse(t);
      const c = j.candidates && j.candidates[0];
      if (!c || !c.content || !c.content.parts) throw new Error('gemini empty response: ' + t.slice(0, 300));
      return { content: c.content, finish: c.finishReason, usage: j.usageMetadata || {} };
    }, 'gemini', { tries: 8, base: 4000, giveUp: (e) => e.fatal });
  }
  static text(content) { return (content.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join(''); }
  static calls(content) { return (content.parts || []).filter((p) => p.functionCall).map((p) => p.functionCall); }
}
function parseJsonLoose(s) {
  s = String(s || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error('no JSON');
}
module.exports = { Gemini, parseJsonLoose };
