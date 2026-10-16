// agentlens dashboard. Vanilla JS, no build step; every number comes from the local /api.
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTok = (n) => { n = n ?? 0; return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)); };
const fmtUsd = (n) => `$${(n ?? 0).toFixed(2)}`;
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const AGENTS = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' };
// Categorical hues, validated with the dataviz palette validator in light and dark (claude orange nudged from #d97757 to pass the dark lightness band).
const COLORS = { claude: '#d4724f', codex: '#4f7cff', opencode: '#2fa37a', antigravity: '#a35fd6' };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
// Unpriced tokens are never shown as $0: all-unpriced says so, partly-unpriced gets an asterisk.
const cost = (t) => (t.cost === 0 && t.unpricedTokens > 0 ? 'unpriced' : fmtUsd(t.cost) + (t.unpricedTokens > 0 ? '*' : ''));

const state = { range: 30, agent: '', project: '' };
let charts = [];

async function api(path, extra = {}) {
  const p = new URLSearchParams(extra);
  if (state.range) p.set('from', String(Date.now() - state.range * 864e5));
  if (state.agent) p.set('agent', state.agent);
  if (state.project) p.set('project', state.project);
  const r = await fetch(`/api/${path}?${p}`);
  if (!r.ok) throw new Error(`/api/${path} returned ${r.status}`);
  return r.json();
}

const tile = (label, value, note = '') =>
  `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="note">${esc(note)}</div></div>`;

function table(cols, rows, href) {
  if (!rows.length) return '<p class="empty">Nothing in this range. Widen the range above, or open Health if you expected data.</p>';
  const head = cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('');
  const body = rows.map((r) => `<tr${href ? ` data-href="${esc(href(r))}" tabindex="0"` : ''}>${
    cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${esc(c.get(r))}</td>`).join('')}</tr>`).join('');
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function chart(id, x, series, { time = true, fmt = fmtTok } = {}) {
  const el = document.getElementById(id);
  const axis = { stroke: css('--muted'), grid: { stroke: css('--grid') }, ticks: { stroke: css('--grid') } };
  charts.push(new uPlot({
    width: el.clientWidth - 16, height: 260, scales: { x: { time } },
    series: [{}, ...series.map((s) => ({ label: s.label, stroke: s.color, dash: s.dash, width: 2, spanGaps: true, value: (u, v) => (v == null ? '—' : fmt(v)) }))],
    axes: [axis, { ...axis, size: 64, values: (u, vals) => vals.map(fmt) }],
  }, [x, ...series.map((s) => s.data)], el));
}

const agentCol = { label: 'Agent', get: (r) => AGENTS[r.agent] ?? r.agent };
const tokCols = [
  { label: 'Tokens (measured)', num: true, get: (r) => fmtTok(r.tokens) },
  { label: 'Cache read', num: true, get: (r) => fmtTok(r.cacheRead) },
  { label: 'API-equivalent cost (estimated)', num: true, get: cost },
];
const projectCols = [
  { label: 'Project', get: (r) => r.name },
  { label: 'Agents', get: (r) => (r.agents ?? '').split(',').filter(Boolean).map((a) => AGENTS[a] ?? a).join(', ') },
  { label: 'Sessions', num: true, get: (r) => r.sessions },
  ...tokCols,
  { label: 'Last active', get: (r) => fmtTime(r.lastActive) },
];

function quotaTiles(latest) {
  return ['claude', 'codex'].flatMap((agent) => ['5h', '7d'].map((win) => {
    const q = latest.find((l) => l.agent === agent && l.win === win);
    const name = `${AGENTS[agent]} ${win}`;
    if (state.agent && state.agent !== agent) return tile('Quota used (reported by agent)', 'n/a', `${name}: hidden by the Agent filter`);
    if (!q) return tile('Quota used (reported by agent)', 'n/a', `${name}: not reported yet`);
    if (q.resetsAt < Date.now()) return tile('Quota used (reported by agent)', 'n/a', `${name}: window reset since the last report`);
    return tile('Quota used (reported by agent)', `${Math.round(q.usedPct)}%`, `${name} · resets ${fmtTime(q.resetsAt)}`);
  })).join('');
}

async function overview() {
  const [s, daily, models, projects, quota] = await Promise.all([api('summary'), api('daily'), api('models'), api('projects'), api('quota')]);
  const t = s.totals;
  const days = [...new Set(daily.map((d) => d.day))];
  const agents = [...new Set(daily.map((d) => d.agent))];
  return {
    html: `
      <section class="tiles">
        ${tile('Tokens (measured)', fmtTok(t.tokens), `${fmtTok(t.input)} input · ${fmtTok(t.output)} output · ${fmtTok(t.cacheRead)} cache read · ${fmtTok(t.cacheWrite)} cache write`)}
        ${tile('API-equivalent cost (estimated)', cost(t), t.unpricedTokens ? `${fmtTok(t.unpricedTokens)} tokens from unpriced models not included` : `List prices as of ${s.pricesAsOf}; not what your plan bills`)}
        ${tile('Sessions', String(s.sessions), t.tokens ? `${Math.round((t.cacheRead / t.tokens) * 100)}% of tokens were cache reads` : '')}
        ${quotaTiles(quota.latest)}
      </section>
      <h2>Tokens per day</h2>
      <div id="c-daily" class="chart"></div>
      <div class="cols">
        <section><h2>By agent</h2>${table([agentCol, ...tokCols], s.byAgent)}</section>
        <section><h2>By model</h2>${table([{ label: 'Model', get: (r) => r.name ?? 'unknown' }, agentCol, ...tokCols], models)}</section>
      </div>
      <h2>Top projects</h2>
      ${table(projectCols, projects.slice(0, 10), (r) => `#/project/${r.projectId}`)}`,
    after: () => days.length && chart('c-daily', days.map((d) => Date.parse(`${d}T00:00:00`) / 1000),
      agents.map((a) => ({ label: AGENTS[a] ?? a, color: COLORS[a], data: days.map((d) => daily.find((x) => x.day === d && x.agent === a)?.tokens ?? 0) }))),
  };
}

async function projectsPage() {
  const rows = await api('projects');
  return {
    html: `<h1>Projects</h1>
      <p class="hint">Grouped by git repository; worktrees count toward their main repo. Select a row to filter the overview to that project.</p>
      ${table([...projectCols, { label: 'Path', get: (r) => r.root }], rows, (r) => `#/project/${r.projectId}`)}`,
  };
}

async function sessionsPage() {
  const rows = await api('sessions', { limit: '300' });
  return {
    html: `<h1>Sessions</h1>${table([
      { label: 'Last activity', get: (r) => fmtTime(r.ended) }, agentCol, { label: 'Project', get: (r) => r.project ?? '—' },
      { label: 'Kind', get: (r) => (r.parentId ? 'subagent' : 'main') },
      { label: 'Turns', num: true, get: (r) => r.turns }, { label: 'Tool calls', num: true, get: (r) => r.toolCalls }, ...tokCols,
    ], rows, (r) => `#/session/${encodeURIComponent(r.id)}`)}`,
  };
}

async function sessionPage(id) {
  const d = await api('session', { id: decodeURIComponent(id) });
  if (!d) return { html: '<p class="empty">Session not found. It may not have been ingested yet; check Health.</p>' };
  return {
    html: `<h1>${esc(AGENTS[d.agent] ?? d.agent)} session</h1>
      <p class="hint">${esc(d.project ?? d.cwd ?? '')} · ${esc(d.id)}${d.parentId ? ` · subagent of <a href="#/session/${encodeURIComponent(d.parentId)}">${esc(d.parentId)}</a>` : ''}</p>
      <section class="tiles">${tile('Tokens (measured)', fmtTok(d.totals.tokens))}${tile('API-equivalent cost (estimated)', cost(d.totals))}${tile('Turns', String(d.turns.length))}</section>
      <h2>Context size per turn</h2>
      <p class="hint">Input plus cache tokens sent on each turn. Steady growth with no drop means the context was never compacted.</p>
      <div id="c-ctx" class="chart"></div>
      <h2>Tools</h2>
      ${table([{ label: 'Tool', get: (r) => r.tool }, { label: 'Calls', num: true, get: (r) => r.calls }, { label: 'Result size', num: true, get: (r) => `${fmtTok(r.resultBytes)}B` }, { label: 'Errors', num: true, get: (r) => r.errors }], d.tools)}
      ${d.children.length ? `<h2>Subagents</h2>${table([{ label: 'Session', get: (r) => r.id }, agentCol], d.children, (r) => `#/session/${encodeURIComponent(r.id)}`)}` : ''}`,
    after: () => d.turns.length && chart('c-ctx', d.turns.map((_, i) => i + 1),
      [{ label: 'Context tokens', color: COLORS[d.agent], data: d.turns.map((t) => t.context) }], { time: false }),
  };
}

async function quotaPage() {
  const q = await api('quota');
  const keys = [...new Set(q.timeline.map((p) => `${p.agent}|${p.win}`))];
  const xs = [...new Set(q.timeline.map((p) => p.ts))].sort((a, b) => a - b);
  const idx = new Map(xs.map((x, i) => [x, i]));
  return {
    html: `<h1>Quota</h1>
      <p class="hint">Percentages exactly as each agent reports them. Agents that don't report quota show n/a, never an estimate.</p>
      <section class="tiles">${quotaTiles(q.latest)}</section>
      <h2>Usage over time</h2>
      <div id="c-quota" class="chart"></div>
      <h2>Limit hits</h2>
      ${table([agentCol, { label: 'Window', get: (r) => r.win }, { label: 'First hit', get: (r) => fmtTime(r.firstHit) }, { label: 'Window reset', get: (r) => fmtTime(r.resetsAt) }], q.limitHits)}`,
    after: () => xs.length && chart('c-quota', xs.map((x) => x / 1000), keys.map((k) => {
      const [agent, win] = k.split('|');
      const data = new Array(xs.length).fill(null);
      for (const p of q.timeline) if (p.agent === agent && p.win === win) data[idx.get(p.ts)] = p.usedPct;
      return { label: `${AGENTS[agent] ?? agent} ${win}`, color: COLORS[agent], dash: win === '7d' ? [6, 4] : undefined, data };
    }), { fmt: (v) => `${Math.round(v)}%` }),
  };
}

async function healthPage() {
  const h = await api('health');
  const badgeColor = h.status === 'healthy' ? '#22c55e' : h.status === 'warning' ? '#eab308' : '#ef4444';
  const badgeLabel = h.status ? h.status.charAt(0).toUpperCase() + h.status.slice(1) : 'Healthy';
  const statusBadge = `<span style="font-size:0.875rem;padding:0.2rem 0.6rem;border-radius:9999px;background:${badgeColor};color:#fff;font-weight:600;vertical-align:middle;margin-left:0.5rem">${badgeLabel}</span>`;

  const warningsHtml =
    h.warnings && h.warnings.length > 0
      ? `<div style="margin:1rem 0;padding:1rem;background:rgba(234,179,8,0.1);border-left:4px solid #eab308;border-radius:4px">
          <strong style="color:#ca8a04">Warnings (${h.warnings.length})</strong>
          <ul style="margin:0.5rem 0 0 1.25rem;padding:0">
            ${h.warnings.map((w) => `<li style="margin:0.25rem 0">${esc(w)}</li>`).join('')}
          </ul>
        </div>`
      : '';

  const crossCheckHtml =
    h.crossCheck && h.crossCheck.length > 0
      ? `<h2>ccusage Cross-Check</h2>
         <p class="hint">Daily token comparison against ccusage. Drift &gt; 5% triggers a warning.</p>
         ${table(
           [
             agentCol,
             { label: 'Date', get: (r) => r.date },
             { label: 'agentlens tokens', num: true, get: (r) => fmtInt(r.agentlensTokens) },
             { label: 'ccusage tokens', num: true, get: (r) => fmtInt(r.ccusageTokens) },
             { label: 'Variance', num: true, get: (r) => `${r.diffPct}%` },
             {
               label: 'Status',
               get: (r) =>
                 r.warning
                   ? '<span style="color:#ef4444;font-weight:600">Drift &gt; 5%</span>'
                   : '<span style="color:#22c55e;font-weight:500">OK</span>',
             },
           ],
           h.crossCheck,
         )}`
      : '';

  return {
    html: `<h1>Health ${statusBadge}</h1>
      <p class="hint">Ingestion status, parser integrity, and ccusage cross-check.</p>
      ${warningsHtml}
      ${table([agentCol, { label: 'Files tracked', num: true, get: (r) => r.files }, { label: 'Bad lines', num: true, get: (r) => r.badLines }, { label: 'Last ingest', get: (r) => fmtTime(r.lastIngest) }], h.sources)}
      <h2>Events</h2>
      ${table([agentCol, { label: 'Events', num: true, get: (r) => r.events }, { label: 'Latest event', get: (r) => fmtTime(r.latestEvent) }], h.events)}
      ${crossCheckHtml}`,
  };
}

const routes = { overview, projects: projectsPage, sessions: sessionsPage, session: sessionPage, quota: quotaPage, health: healthPage };

async function render() {
  const [, name = 'overview', arg = ''] = location.hash.split('/');
  if (name === 'project') {
    state.project = arg;
    $('#f-project').value = arg;
    location.replace('#/overview'); // replace, not assign: assigning would leave #/project/<id> in history and trap the Back button
    return;
  }
  document.querySelectorAll('nav a').forEach((a) => {
    if (a.getAttribute('href') === `#/${name}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const main = $('#main');
  main.setAttribute('aria-busy', 'true');
  try {
    const { html, after } = await (routes[name] ?? overview)(arg);
    charts.forEach((c) => c.destroy());
    charts = [];
    main.innerHTML = html;
    after?.();
  } catch (e) {
    main.innerHTML = `<p class="error">Couldn't load this page (${esc(e.message)}). Check that the agentlens service is running, then reload.</p>`;
  }
  main.removeAttribute('aria-busy');
}

for (const [id, key] of [['f-range', 'range'], ['f-agent', 'agent'], ['f-project', 'project']]) {
  $(`#${id}`).addEventListener('change', (e) => { state[key] = key === 'range' ? Number(e.target.value) : e.target.value; render(); });
}
document.addEventListener('click', (e) => { const tr = e.target.closest?.('tr[data-href]'); if (tr) location.hash = tr.dataset.href; });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches?.('tr[data-href]')) location.hash = e.target.dataset.href; });
window.addEventListener('hashchange', render);
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 250); });
setInterval(() => { if (!document.hidden) render(); }, 60_000);

fetch('/api/projects').then((r) => r.json()).then((ps) => {
  $('#f-project').insertAdjacentHTML('beforeend', ps.map((p) => `<option value="${p.projectId}">${esc(p.name)}</option>`).join(''));
  if (state.project) $('#f-project').value = state.project;
});
render();
