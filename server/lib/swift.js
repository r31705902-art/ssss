'use strict';
// Blomp (OpenStack Swift) client. Blomp regularly answers 503, so everything retries.
const { retry, log, sleep } = require('./util');

class Swift {
  constructor({ user, pass, authUrl = 'https://authenticate.ain.net', container }) {
    this.user = user; this.pass = pass; this.authUrl = authUrl.replace(/\/$/, ''); this.container = container || user;
    this.token = null; this.url = null; this.exp = 0; this._authP = null;
  }
  async auth(force = false) {
    if (!force && this.token && Date.now() < this.exp) return;
    if (this._authP) return this._authP;
    this._authP = retry(async () => {
      const r = await fetch(this.authUrl + '/v2.0/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000),
        body: JSON.stringify({ auth: { tenantName: 'storage', passwordCredentials: { username: this.user, password: this.pass } } }) });
      if (!r.ok) throw new Error('blomp auth ' + r.status);
      const a = (await r.json()).access;
      this.token = a.token.id;
      this.url = a.serviceCatalog.find((s) => s.type === 'object-store').endpoints[0].publicURL;
      this.exp = Date.now() + 45 * 60e3;
    }, 'blomp auth', { tries: 8 }).finally(() => { this._authP = null; });
    return this._authP;
  }
  objUrl(name) { return `${this.url}/${encodeURIComponent(this.container)}/${name.split('/').map(encodeURIComponent).join('/')}`; }
  async signed(name) { await this.auth(); return { url: this.objUrl(name), token: this.token }; }
  async req(method, name, { body, headers = {}, ok = [200, 201, 202, 204, 206], tries = 10, timeout = 300000 } = {}) {
    return retry(async () => {
      await this.auth();
      const r = await fetch(this.objUrl(name), { method, body, headers: { ...headers, 'X-Auth-Token': this.token }, signal: AbortSignal.timeout(timeout) });
      if (r.status === 401) { await this.auth(true); throw new Error('401'); }
      if (r.status === 404 && method !== 'PUT') { const e = new Error('404 ' + name); e.notFound = true; throw e; }
      if (!ok.includes(r.status)) { const t = await r.text().catch(() => ''); throw new Error(`${method} ${name} -> ${r.status} ${t.slice(0, 100)}`); }
      return r;
    }, `${method} ${name}`, { tries, giveUp: (e) => e.notFound });
  }
  async get(name, opts) { const r = await this.req('GET', name, opts); return Buffer.from(await r.arrayBuffer()); }
  async getJson(name, d = null) { try { return JSON.parse((await this.get(name)).toString('utf8')); } catch (e) { if (e.notFound) return d; throw e; } }
  async getText(name, d = null) { try { return (await this.get(name)).toString('utf8'); } catch (e) { if (e.notFound) return d; throw e; } }
  async put(name, buf, type = 'application/octet-stream') { await this.req('PUT', name, { body: buf, headers: { 'Content-Type': type } }); }
  async putJson(name, o) { return this.put(name, Buffer.from(JSON.stringify(o)), 'application/json'); }
  async head(name) {
    try { const r = await this.req('HEAD', name, { tries: 6 }); return { size: Number(r.headers.get('content-length') || 0) }; }
    catch (e) { if (e.notFound) return null; throw e; }
  }
  async del(name) { try { await this.req('DELETE', name, { tries: 6 }); } catch (e) { if (!e.notFound) log('del failed', name, e.message); } }
  async list(prefix) {
    const out = []; let marker = '';
    for (;;) {
      const page = await retry(async () => {
        await this.auth();
        const u = `${this.url}/${encodeURIComponent(this.container)}?format=json&limit=10000&prefix=${encodeURIComponent(prefix)}&marker=${encodeURIComponent(marker)}`;
        const r = await fetch(u, { headers: { 'X-Auth-Token': this.token }, signal: AbortSignal.timeout(120000) });
        if (r.status === 401) { await this.auth(true); throw new Error('401'); }
        if (r.status === 204) return [];
        if (!r.ok) throw new Error('list ' + r.status);
        return r.json();
      }, 'list ' + prefix);
      out.push(...page);
      if (page.length < 10000) break;
      marker = page[page.length - 1].name;
    }
    return out;
  }
  async delPrefix(prefix) {
    const items = await this.list(prefix); let i = 0;
    await Promise.all(Array.from({ length: 8 }, async () => { while (i < items.length) { const it = items[i++]; await this.del(it.name); } }));
    return items.length;
  }
  // Stream object bytes [start, size) to write(chunk) with resume-on-failure (Range).
  async pipeTo(name, size, write, start = 0) {
    let pos = start, fails = 0;
    while (pos < size) {
      try {
        await this.auth();
        const r = await fetch(this.objUrl(name), { headers: { 'X-Auth-Token': this.token, Range: `bytes=${pos}-${size - 1}` }, signal: AbortSignal.timeout(6 * 3600e3) });
        if (r.status === 401) { await this.auth(true); throw new Error('401'); }
        if (r.status !== 206 && r.status !== 200) throw new Error('GET ' + r.status);
        if (r.status === 200 && pos > 0) throw new Error('range ignored');
        for await (const chunk of r.body) { await write(chunk); pos += chunk.length; fails = 0; }
      } catch (e) {
        if (e.clientGone) throw e;
        if (++fails > 15) throw e;
        log(`pipe ${name} @${pos}: ${e.message} retry ${fails}`);
        await sleep(Math.min(30000, 1000 * 1.6 ** fails));
      }
    }
    return pos - start;
  }
}
module.exports = { Swift };
