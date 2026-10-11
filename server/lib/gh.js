'use strict';
const { retry, sleep } = require('./util');

class GH {
  constructor({ token, repo, ref = 'main' }) { this.token = token; this.repo = repo; this.ref = ref; }
  async api(path, { method = 'GET', body } = {}) {
    return retry(async () => {
      const r = await fetch(`https://api.github.com/repos/${this.repo}${path}`, { method, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60000),
        headers: { Authorization: 'Bearer ' + this.token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'autocut' } });
      if (r.status >= 500 || r.status === 429) throw new Error('gh ' + r.status);
      const t = await r.text();
      if (r.status >= 400) { const e = new Error(`gh ${method} ${path} ${r.status}: ${t.slice(0, 300)}`); e.fatal = true; throw e; }
      return t ? JSON.parse(t) : {};
    }, 'github ' + path, { tries: 6, giveUp: (e) => e.fatal });
  }
  // dispatch and return the run id (matched by run-name "<wf> <job_id>")
  async dispatch(workflow, inputs, title) {
    const since = Date.now() - 60e3;
    await this.api(`/actions/workflows/${workflow}.yml/dispatches`, { method: 'POST', body: { ref: this.ref, inputs } });
    for (let i = 0; i < 30; i++) {
      await sleep(4000);
      const j = await this.api(`/actions/workflows/${workflow}.yml/runs?per_page=20&event=workflow_dispatch`);
      const run = (j.workflow_runs || []).find((r) => r.display_title === title && Date.parse(r.created_at) >= since);
      if (run) return run.id;
    }
    throw new Error('dispatched run not found: ' + title);
  }
  run(id) { return this.api(`/actions/runs/${id}`); }
  async jobs(id) {
    const out = [];
    for (let p = 1; p < 10; p++) {
      const j = await this.api(`/actions/runs/${id}/jobs?per_page=100&page=${p}&filter=latest`);
      out.push(...(j.jobs || []));
      if (!j.jobs || j.jobs.length < 100) break;
    }
    return out;
  }
  cancel(id) { return this.api(`/actions/runs/${id}/cancel`, { method: 'POST' }).catch(() => {}); }
}
module.exports = { GH };
