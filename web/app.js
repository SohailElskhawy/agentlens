// agentlens dashboard. Vanilla JS, no build step; every number comes from the local /api.
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTok = (n) => { n = n ?? 0; return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)); };
const fmtInt = (n) => (n ?? 0).toLocaleString();
const fmtUsd = (n) => `$${(n ?? 0).toFixed(2)}`;
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtDelta = (n) => ((n ?? 0) > 0 ? `+${n}%` : `${n ?? 0}%`);
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
    cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.html ? c.get(r) : esc(c.get(r))}</td>`).join('')}</tr>`).join('');
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
               html: true,
               get: (r) =>
                 r.warning
                   ? '<span style="color:#ef4444;font-weight:600">Drift &gt; 5%</span>'
                   : '<span style="color:#22c55e;font-weight:500">OK</span>',
             },
           ],
           h.crossCheck,
         )}`
      : `<h2>ccusage Cross-Check</h2>
         <p class="hint">${h.ccusageAvailable === false ? 'ccusage binary was not detected in PATH. Install ccusage (<code>npm i -g ccusage</code>) to enable automatic daily cross-checking.' : 'No cross-check data available for the last 7 days.'}</p>`;

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

async function recommendationsPage() {
  const [recData, findData, trackData] = await Promise.all([
    api('recommendations'),
    api('findings'),
    api('tracking'),
  ]);

  const recs = recData.recommendations || [];
  const findings = findData.findings || [];
  const savings = findData.totalEstWeeklySavings || 0;
  const trackedItems = trackData.items || [];

  const openRecs = recs.filter((r) => r.status === 'open');
  const acceptedRecs = recs.filter((r) => r.status === 'accepted' || r.status === 'measuring');

  const ACTION_COLORS = {
    add: '#22c55e',
    remove: '#ef4444',
    replace: '#f59e0b',
    improve: '#3b82f6',
  };

  const CONF_COLORS = {
    high: '#22c55e',
    medium: '#f59e0b',
    low: '#6b7280',
  };

  const tiles = `
    <div class="tiles">
      <div class="tile">
        <div class="label">Est. Weekly Potential Savings</div>
        <div class="value">${fmtTok(savings)}</div>
        <div class="note">Measured token waste across patterns</div>
      </div>
      <div class="tile">
        <div class="label">Open Recommendations</div>
        <div class="value">${openRecs.length}</div>
        <div class="note">${acceptedRecs.length} tracking / accepted</div>
      </div>
      <div class="tile">
        <div class="label">Flagged Findings</div>
        <div class="value">${findings.length}</div>
        <div class="note">Across 10 workflow detectors</div>
      </div>
    </div>
  `;

  const trackedSection = trackedItems.length > 0 ? `
    <h2>Tracked Improvements (${trackedItems.length})</h2>
    <p class="hint">14-day pre- vs post-adoption verification with quality guardrails (tool errors, corrections, turns/session).</p>
    <div class="rec-grid">
      ${trackedItems.map((r) => {
        const res = r.result;
        const delta = res ? (res.deltaPct <= 0 ? `${res.deltaPct}%` : `+${res.deltaPct}%`) : '0%';
        const isBetter = res && res.deltaPct <= -10;
        const isWorse = res && res.deltaPct >= 10;
        const deltaClass = isBetter ? 'positive' : (isWorse ? 'negative' : '');
        return `
          <div class="rec-card">
            <div class="rec-header">
              <span class="pill pill-${esc(r.status)}">${esc(r.status.toUpperCase())}</span>
              <span class="badge" style="border:1px solid #e5e7eb;color:var(--text)">${esc(r.findingRule.replace(/_/g, ' '))}</span>
              <span class="track-delta ${deltaClass}" style="margin-left:auto">${esc(delta)}</span>
            </div>
            <h3 style="margin:8px 0 4px;font-size:15px">${esc(r.title)}</h3>
            ${res ? `
              <div class="track-metric">Target: <strong>${esc(res.metricName)}</strong> (${fmtTok(res.baselineVal)} &rarr; ${fmtTok(res.currentVal)})</div>
              <div class="track-metric">Samples: ${res.sampleBefore} sessions before &middot; ${res.sampleAfter} after (min 5)</div>
              <div class="track-metric">Guardrails: <span style="font-weight:600;color:${res.guardrails?.passed ? '#15803d' : '#b91c1c'}">${res.guardrails?.passed ? 'PASSED' : 'REGRESSED'}</span></div>
            ` : `<p style="color:var(--muted);font-size:12px">Tracking initialized &middot; gathering sessions...</p>`}
          </div>
        `;
      }).join('')}
    </div>
  ` : '';

  const recList = openRecs.length === 0
    ? '<p class="empty">No open recommendations! All active patterns resolved or dismissed.</p>'
    : `<div class="rec-grid">
        ${openRecs.map((r) => `
          <div class="rec-card" data-rec-id="${esc(r.id)}">
            <div class="rec-header">
              <span class="badge" style="background:${ACTION_COLORS[r.action] || '#3b82f6'};color:#fff">${esc(r.action.toUpperCase())}</span>
              <span class="badge" style="border:1px solid #e5e7eb;color:var(--text)">${esc(r.findingRule.replace(/_/g, ' '))}</span>
              <span style="margin-left:auto;font-weight:600;color:#10b981">${r.score ? `+${fmtTok(r.score)} tokens/wk` : ''}</span>
            </div>
            <h3 style="margin:8px 0 4px;font-size:15px">${esc(r.title)}</h3>
            <p style="margin:0 0 12px;color:var(--muted);font-size:13px">${esc(r.body)}</p>
            ${r.actionSnippet ? `<div><code class="action-snippet">${esc(r.actionSnippet)}</code></div>` : ''}
            <div class="rec-actions">
              <button class="btn btn-sm btn-accept" data-id="${esc(r.id)}">Accept & Track</button>
              <button class="btn btn-sm btn-outline btn-dismiss" data-id="${esc(r.id)}">Dismiss</button>
            </div>
          </div>
        `).join('')}
      </div>`;

  const findingsTable = table(
    [
      { label: 'Rule', get: (f) => f.rule.replace(/_/g, ' ') },
      { label: 'Confidence', html: true, get: (f) => `<span style="color:${CONF_COLORS[f.confidence] || 'inherit'};font-weight:600">${esc(f.confidence)}</span>` },
      { label: 'Reason', get: (f) => f.confidenceReason },
      { label: 'Est. Waste/Wk', num: true, get: (f) => f.estTokensWeek ? fmtTok(f.estTokensWeek) : 'diagnostic' },
      { label: 'Last Seen', get: (f) => fmtTime(f.lastSeen) },
    ],
    findings,
    (f) => f.sessionId ? `#/session/${f.sessionId}` : undefined,
  );

  return {
    html: `
      <h1>Recommendations & Findings</h1>
      <p class="hint">Deterministic workflow waste detection, potential savings, and actionable configuration suggestions.</p>
      ${tiles}
      ${trackedSection}
      <h2>Active Recommendations</h2>
      ${recList}
      <h2>Workflow Findings (${findings.length})</h2>
      <p class="hint">Click any row with a session link to drill into per-turn context growth and tool calls.</p>
      ${findingsTable}
    `,
    after: () => {
      document.querySelectorAll('.btn-accept').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const id = e.currentTarget.dataset.id;
          await fetch(`/api/recommendations/${encodeURIComponent(id)}/accept`, {
            method: 'POST',
          });
          render();
        });
      });
      document.querySelectorAll('.btn-dismiss').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const id = e.currentTarget.dataset.id;
          await fetch(`/api/recommendations/${encodeURIComponent(id)}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'dismissed' }),
          });
          render();
        });
      });
    },
  };
}

async function auditPage() {
  const data = await api('audit');
  const items = data.items || [];
  const summary = data.summary || {
    totalItems: 0,
    totalFixedTokens: 0,
    unusedCount: 0,
    duplicateCount: 0,
    conflictCount: 0,
  };

  const statusPill = (status) => `<span class="pill pill-${esc(status)}">${esc(status)}</span>`;

  const instructions = items.filter((i) => i.kind === 'instruction');
  const toolsAndMcps = items.filter((i) => i.kind === 'mcp' || i.kind === 'plugin');
  const skills = items.filter((i) => i.kind === 'skill');
  const issues = items.filter((i) => i.status === 'duplicate' || i.status === 'conflict');

  const tiles = `
    <div class="tiles">
      <div class="tile">
        <div class="label">Per-Session Fixed Overhead</div>
        <div class="value">${fmtTok(summary.totalFixedTokens)}</div>
        <div class="note">Estimated instruction tokens per turn/session</div>
      </div>
      <div class="tile">
        <div class="label">Configured Items</div>
        <div class="value">${summary.totalItems}</div>
        <div class="note">${items.filter((i) => i.status === 'active').length} active in last 30d</div>
      </div>
      <div class="tile">
        <div class="label">Unused in 30 Days</div>
        <div class="value" style="${summary.unusedCount > 0 ? 'color:var(--error)' : ''}">${summary.unusedCount}</div>
        <div class="note">Stale MCPs, skills, or plugins</div>
      </div>
      <div class="tile">
        <div class="label">Duplicates & Conflicts</div>
        <div class="value" style="${summary.duplicateCount + summary.conflictCount > 0 ? 'color:#f59e0b' : ''}">${summary.duplicateCount + summary.conflictCount}</div>
        <div class="note">${summary.duplicateCount} duplicates, ${summary.conflictCount} conflicts</div>
      </div>
    </div>
  `;

  const instructionsTable = table(
    [
      agentCol,
      { label: 'Name', get: (r) => r.name },
      { label: 'Tokens', num: true, get: (r) => fmtTok(r.tokens) },
      { label: 'Chars', num: true, get: (r) => fmtInt(r.details?.chars) },
      { label: 'Source Path', get: (r) => r.sourcePath },
    ],
    instructions,
  );

  const toolsTable = table(
    [
      agentCol,
      { label: 'Type', get: (r) => r.kind.toUpperCase() },
      { label: 'Name', get: (r) => r.name },
      { label: 'Status', html: true, get: (r) => statusPill(r.status) },
      { label: '30d Calls', num: true, get: (r) => r.invocations30d > 0 ? fmtInt(r.invocations30d) : 'none' },
      { label: 'Source Path', get: (r) => r.sourcePath },
    ],
    toolsAndMcps,
  );

  const skillsTable = table(
    [
      agentCol,
      { label: 'Skill Name', get: (r) => r.name },
      { label: 'Status', html: true, get: (r) => statusPill(r.status) },
      { label: '30d Calls', num: true, get: (r) => r.invocations30d > 0 ? fmtInt(r.invocations30d) : 'none' },
      { label: 'Description', get: (r) => r.details?.description || '—' },
      { label: 'Tokens', num: true, get: (r) => fmtTok(r.tokens) },
    ],
    skills,
  );

  const issuesTable = issues.length === 0
    ? '<p class="empty">No duplicates or conflicts detected across agents or projects.</p>'
    : table(
        [
          agentCol,
          { label: 'Issue', html: true, get: (r) => statusPill(r.status) },
          { label: 'Type', get: (r) => r.kind.toUpperCase() },
          { label: 'Name', get: (r) => r.name },
          { label: 'Source Path', get: (r) => r.sourcePath },
        ],
        issues,
      );

  return {
    html: `
      <h1>Configuration Audit</h1>
      <p class="hint">Read-only audit of always-loaded instruction overhead, MCPs, skills, plugins, duplicates, and conflicts across all 4 agents.</p>
      ${tiles}
      <h2>Instruction Files (${instructions.length})</h2>
      <p class="hint">Always-loaded context injected on session start and turns. Estimated as chars/4.</p>
      ${instructionsTable}
      <h2>MCP Servers & Plugins (${toolsAndMcps.length})</h2>
      <p class="hint">Tools registered via configuration files or directories, correlated with 30-day tool call history.</p>
      ${toolsTable}
      <h2>Skills (${skills.length})</h2>
      <p class="hint">Skills available in global or project repositories.</p>
      ${skillsTable}
      <h2>Flagged Duplicates & Conflicts (${issues.length})</h2>
      <p class="hint">Configurations declared in multiple places or specifying conflicting developer commands.</p>
      ${issuesTable}
    `,
  };
}

async function reportsPage() {
  const reportsList = await api('reports');
  const reports = reportsList.reports || [];

  let selectedWeek = state.reportWeek || (reports[0]?.week);
  let reportDetail = null;

  if (selectedWeek) {
    try {
      const r = await fetch(`/api/reports/${encodeURIComponent(selectedWeek)}`);
      if (r.ok) reportDetail = await r.json();
    } catch {}
  }

  const selector = `
    <div class="report-bar">
      <div style="display:flex;align-items:center;gap:10px">
        <label for="rep-select" style="font-weight:600;font-size:14px">Select Report:</label>
        <select id="rep-select" style="max-width:300px">
          ${reports.length === 0 ? '<option value="">No reports yet</option>' : ''}
          ${reports.map((r) => `<option value="${esc(r.week)}" ${r.week === selectedWeek ? 'selected' : ''}>${esc(r.week)} (${fmtTime(r.generatedAt)})</option>`).join('')}
        </select>
      </div>
      <button class="btn btn-sm" id="btn-gen-report">Generate Current Report</button>
    </div>
  `;

  if (!reportDetail) {
    return {
      html: `
        <h1>Weekly Usage Reports</h1>
        <p class="hint">Automated weekly usage, cost trends, quota peaks, token-wasting patterns, and action items.</p>
        ${selector}
        <div class="card" style="margin-top:20px;text-align:center;padding:40px">
          <p class="empty">No weekly report available yet.</p>
          <button class="btn" id="btn-gen-first" style="margin-top:12px">Generate Report Now</button>
        </div>
      `,
      after: () => {
        const genBtn = $('#btn-gen-report') || $('#btn-gen-first');
        if (genBtn) {
          genBtn.addEventListener('click', async () => {
            genBtn.disabled = true;
            genBtn.textContent = 'Generating...';
            await fetch('/api/reports/generate', { method: 'POST' });
            render();
          });
        }
      },
    };
  }

  const d = reportDetail.data;
  const tiles = `
    <div class="tiles" style="margin-bottom:20px">
      <div class="tile">
        <div class="label">Tokens (measured)</div>
        <div class="value">${fmtTok(d.summary.totalTokens)}</div>
        <div class="note">${fmtDelta(d.summary.tokensDeltaPct)} vs prev week</div>
      </div>
      <div class="tile">
        <div class="label">API Cost (estimated)</div>
        <div class="value">${fmtUsd(d.summary.totalCost)}</div>
        <div class="note">${fmtDelta(d.summary.costDeltaPct)} vs prev week</div>
      </div>
      <div class="tile">
        <div class="label">Active Sessions</div>
        <div class="value">${d.summary.activeSessions}</div>
        <div class="note">${fmtDelta(d.summary.sessionsDeltaPct)} vs prev week</div>
      </div>
      <div class="tile">
        <div class="label">5h Window Peak Quota</div>
        <div class="value">${d.quotaInsights.fiveHourPeakPct}%</div>
        <div class="note">${d.quotaInsights.limitHits} limit hits recorded</div>
      </div>
    </div>
  `;

  const mode = state.reportMode || 'preview';
  return {
    html: `
      <h1>Weekly Usage Reports</h1>
      <p class="hint">Automated weekly usage, cost trends, quota peaks, token-wasting patterns, and action items.</p>
      ${selector}
      ${tiles}
      <div class="report-viewer">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <h2 style="margin:0">Report: ${esc(d.week)} (${esc(d.startDate)} to ${esc(d.endDate)})</h2>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button id="btn-toggle-mode" class="btn btn-sm btn-outline">${mode === 'preview' ? 'View Markdown' : 'View Rendered HTML'}</button>
            <button id="btn-copy-md" class="btn btn-sm btn-outline">Copy Markdown</button>
            <a href="data:text/html;charset=utf-8,${encodeURIComponent(reportDetail.html)}" download="${esc(d.week)}.html" class="btn btn-sm btn-outline">Download HTML</a>
            <a href="/api/reports/${encodeURIComponent(d.week)}" target="_blank" class="btn btn-sm btn-outline">View Raw JSON</a>
          </div>
        </div>
        ${mode === 'preview'
          ? `<iframe srcdoc="${esc(reportDetail.html)}" style="width:100%;min-height:600px;border:1px solid var(--border);border-radius:6px;background:var(--bg)"></iframe>`
          : `<pre><code>${esc(reportDetail.markdown)}</code></pre>`
        }
      </div>
    `,
    after: () => {
      $('#rep-select')?.addEventListener('change', (e) => {
        state.reportWeek = e.target.value;
        render();
      });
      $('#btn-gen-report')?.addEventListener('click', async (e) => {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = 'Generating...';
        await fetch('/api/reports/generate', { method: 'POST' });
        render();
      });
      $('#btn-toggle-mode')?.addEventListener('click', () => {
        state.reportMode = mode === 'preview' ? 'markdown' : 'preview';
        render();
      });
      $('#btn-copy-md')?.addEventListener('click', async (e) => {
        const btn = e.target;
        try {
          await navigator.clipboard.writeText(reportDetail.markdown);
          const orig = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = orig; }, 2000);
        } catch {}
      });
    },
  };
}

const routes = { overview, projects: projectsPage, sessions: sessionsPage, session: sessionPage, quota: quotaPage, recommendations: recommendationsPage, audit: auditPage, reports: reportsPage, health: healthPage };

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
