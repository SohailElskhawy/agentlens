// agentlens dashboard. Vanilla JS, no build step; every number comes from the local /api.
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTok = (n) => { n = n ?? 0; return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)); };
const fmtInt = (n) => (n ?? 0).toLocaleString();
const fmtUsd = (n) => `$${(n ?? 0).toFixed(2)}`;
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtDelta = (n) => ((n ?? 0) > 0 ? `+${n}%` : `${n ?? 0}%`);
const AGENTS = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' };

// Theme-tested hues
const COLORS = { claude: '#e07a5f', codex: '#4f86f7', opencode: '#2ea073', antigravity: '#a35fd6' };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
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

function tile(label, value, note = '') {
  return `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="note">${esc(note)}</div></div>`;
}

function emptyState(title, desc = '', actionHtml = '') {
  return `
    <div class="empty-state">
      <div class="empty-state-icon">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>
      </div>
      <div class="empty-state-title">${esc(title)}</div>
      ${desc ? `<div class="empty-state-desc">${esc(desc)}</div>` : ''}
      ${actionHtml ? `<div class="empty-state-actions">${actionHtml}</div>` : ''}
    </div>
  `;
}

function table(cols, rows, href) {
  if (!rows || !rows.length) {
    return emptyState('Nothing in this range', 'Widen the range above, or open Health if you expected data.');
  }
  const head = cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('');
  const body = rows.map((r) => `<tr${href ? ` data-href="${esc(href(r))}" tabindex="0"` : ''}>${
    cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.html ? c.get(r) : esc(c.get(r))}</td>`).join('')}</tr>`).join('');
  return `<div class="table-card-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function chart(id, x, series, { time = true, fmt = fmtTok } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
    (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const textColor = css('--text-muted') || (isDark ? '#8b949e' : '#656d76');
  const gridColor = css('--grid') || (isDark ? '#21262d' : '#e8ecf0');
  const axis = {
    stroke: textColor,
    grid: { stroke: gridColor, width: 1 },
    ticks: { stroke: gridColor, width: 1 },
    font: '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  };
  const u = new uPlot({
    width: Math.max(el.clientWidth - 16, 320),
    height: 240,
    scales: { x: { time } },
    series: [
      {},
      ...series.map((s) => ({
        label: s.label,
        stroke: s.color,
        dash: s.dash,
        width: 2,
        spanGaps: true,
        value: (uPlotInstance, v) => (v == null ? '—' : fmt(v)),
      })),
    ],
    axes: [axis, { ...axis, size: 64, values: (uPlotInstance, vals) => vals.map(fmt) }],
  }, [x, ...series.map((s) => s.data)], el);
  charts.push(u);
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
  {
    label: 'Weekly Budget',
    get: (r) => {
      if (!r.budgetTokens) return '<span style="color:var(--text-muted)">—</span>';
      const pct = r.budgetPct ?? Math.round((r.tokens / r.budgetTokens) * 100);
      const color = pct >= 100 ? 'var(--danger)' : pct >= 80 ? 'var(--warn)' : 'var(--success)';
      const clamped = Math.min(pct, 100);
      return `
        <div style="min-width:110px">
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px">
            <span style="font-weight:600;color:${color}">${pct}%</span>
            <span style="color:var(--text-muted)">${fmtTok(r.tokens)} / ${fmtTok(r.budgetTokens)}</span>
          </div>
          <div style="width:100%;height:6px;background:var(--surface-subtle);border-radius:3px;overflow:hidden">
            <div style="width:${clamped}%;height:100%;background:${color};border-radius:3px"></div>
          </div>
        </div>
      `;
    },
  },
  { label: 'Last active', get: (r) => fmtTime(r.lastActive) },
];

function quotaTiles(latest) {
  return ['claude', 'codex'].flatMap((agent) => ['5h', '7d'].map((win) => {
    const q = latest.find((l) => l.agent === agent && l.win === win);
    const name = `${AGENTS[agent]} ${win}`;
    if (state.agent && state.agent !== agent) return tile('Quota used', 'n/a', `${name}: hidden by Agent filter`);
    if (!q) return tile('Quota used', 'n/a', `${name}: not reported yet`);
    if (q.resetsAt < Date.now()) return tile('Quota used', 'n/a', `${name}: window reset since report`);
    return tile('Quota used', `${Math.round(q.usedPct)}%`, `${name} · resets ${fmtTime(q.resetsAt)}`);
  })).join('');
}

function fmtCountdown(ms) {
  if (ms <= 0) return 'resets soon';
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hrs = Math.floor(min / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}d ${hrs % 24}h`;
  if (hrs > 0) return `${hrs}h ${min % 60}m`;
  return `${min}m`;
}

async function updateQuotaPills() {
  try {
    const q = await fetch('/api/quota').then((r) => r.json());
    const container = $('#quota-pills');
    if (!container || !q || !q.latest) return;
    const now = Date.now();
    let forecastPills = '';
    if (q.forecasts && q.forecasts.length > 0) {
      for (const fc of q.forecasts) {
        if (fc.willExhaustBeforeReset && fc.message) {
          forecastPills += `
            <a class="quota-pill" href="#/quota" style="border-color:var(--warn);background:var(--warn-bg);color:var(--warn)" title="${esc(fc.agent)} ${esc(fc.window)}: ${esc(fc.message)}">
              <span class="quota-pill-dot" style="background:var(--warn)"></span>
              <span style="font-weight:600">${esc(fc.message)}</span>
            </a>
          `;
        }
      }
    }
    const pills = q.latest
      .filter((l) => (l.agent === 'claude' || l.agent === 'codex') && l.resetsAt > now)
      .map((l) => {
        const remaining = fmtCountdown(l.resetsAt - now);
        const color = l.usedPct >= 85 ? 'var(--danger)' : l.usedPct >= 70 ? 'var(--warn)' : 'var(--success)';
        return `
          <a class="quota-pill" href="#/quota" title="${esc(AGENTS[l.agent] || l.agent)} ${esc(l.win)}: ${Math.round(l.usedPct)}% used, resets in ${remaining}">
            <span class="quota-pill-dot" style="background:${color}"></span>
            <span>${esc(l.agent)} ${esc(l.win)}: <strong>${Math.round(l.usedPct)}%</strong></span>
            <span class="quota-pill-countdown">${remaining}</span>
          </a>
        `;
      }).join('');
    container.innerHTML = forecastPills + pills;
  } catch {}
}

function openSlideOver(title, contentHtml) {
  const el = $('#slide-over');
  const backdrop = $('#slide-over-backdrop');
  const titleEl = $('#slide-over-title');
  const bodyEl = $('#slide-over-body');
  if (!el || !backdrop) return;
  titleEl.textContent = title;
  bodyEl.innerHTML = contentHtml;
  el.classList.add('open');
  backdrop.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  backdrop.setAttribute('aria-hidden', 'false');
}

function closeSlideOver() {
  const el = $('#slide-over');
  const backdrop = $('#slide-over-backdrop');
  if (!el || !backdrop) return;
  el.classList.remove('open');
  backdrop.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
  backdrop.setAttribute('aria-hidden', 'true');
}

function openShortcutsModal() {
  const modal = $('#shortcuts-modal');
  const backdrop = $('#shortcuts-modal-backdrop');
  if (!modal || !backdrop) return;
  modal.classList.add('open');
  backdrop.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  backdrop.setAttribute('aria-hidden', 'false');
}

function closeShortcutsModal() {
  const modal = $('#shortcuts-modal');
  const backdrop = $('#shortcuts-modal-backdrop');
  if (!modal || !backdrop) return;
  modal.classList.remove('open');
  backdrop.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  backdrop.setAttribute('aria-hidden', 'true');
}

function toggleSidebar() {
  const sidebar = $('#sidebar');
  if (!sidebar) return;
  const isCollapsed = sidebar.classList.toggle('collapsed');
  localStorage.setItem('agentlens_sidebar_collapsed', String(isCollapsed));
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('agentlens_theme', next);
  charts.forEach((c) => c.destroy());
  charts = [];
  render();
}

function renderSkeleton() {
  return `
    <div class="tiles-row">
      <div class="tile skeleton-pulse skeleton-tile"></div>
      <div class="tile skeleton-pulse skeleton-tile"></div>
      <div class="tile skeleton-pulse skeleton-tile"></div>
      <div class="tile skeleton-pulse skeleton-tile"></div>
    </div>
    <div class="grid-12">
      <div class="col-7 card skeleton-pulse skeleton-chart"></div>
      <div class="col-5 card skeleton-pulse skeleton-chart"></div>
    </div>
    <div class="grid-12">
      <div class="col-6 card skeleton-pulse skeleton-table"></div>
      <div class="col-6 card skeleton-pulse skeleton-table"></div>
    </div>
  `;
}

// Pages
async function overview() {
  const [s, daily, models, projects, quota, findingsRes] = await Promise.all([
    api('summary'),
    api('daily'),
    api('models'),
    api('projects'),
    api('quota'),
    api('findings').catch(() => ({ findings: [] })),
  ]);
  const t = s.totals;
  const days = [...new Set(daily.map((d) => d.day))];
  const agents = [...new Set(daily.map((d) => d.agent))];

  const findings = findingsRes?.findings || [];
  const balanceFinding = findings.find((f) => f.rule === 'cross_agent_balance');

  const balanceCard = balanceFinding ? `
    <div class="card" style="margin-bottom:var(--space-4);border-color:var(--accent);background:var(--surface)">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="width:36px;height:36px;border-radius:var(--radius-sm);background:var(--accent-subtle);display:flex;align-items:center;justify-content:center;color:var(--accent)">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="16 3 21 3 21 8"></polyline>
              <line x1="4" y1="20" x2="21" y2="3"></line>
              <polyline points="21 16 21 21 16 21"></polyline>
              <line x1="15" y1="15" x2="21" y2="21"></line>
              <line x1="4" y1="4" x2="9" y2="9"></line>
            </svg>
          </div>
          <div>
            <div style="display:flex;align-items:center;gap:8px">
              <h3 style="margin:0;font-size:15px;font-weight:600">Cross-Agent Workload Balancing</h3>
              <span class="badge" style="background:var(--accent-subtle);color:var(--accent);font-weight:600">Recommendation</span>
            </div>
            <p style="margin:4px 0 0;font-size:13px;color:var(--text-main)">
              <strong>${esc(balanceFinding.evidence?.suggestion || balanceFinding.confidenceReason)}</strong>
              <span style="color:var(--text-muted);margin-left:6px">${esc(balanceFinding.confidenceReason)}</span>
            </p>
          </div>
        </div>
        <a href="#/recommendations" class="btn btn-sm btn-outline">View Recommendations &rarr;</a>
      </div>
    </div>
  ` : '';

  return {
    html: `
      <section class="tiles-row">
        ${tile('Tokens (measured)', fmtTok(t.tokens), `${fmtTok(t.input)} input · ${fmtTok(t.output)} output · ${fmtTok(t.cacheRead)} cache read · ${fmtTok(t.cacheWrite)} cache write`)}
        ${tile('API-equivalent cost (estimated)', cost(t), t.unpricedTokens ? `${fmtTok(t.unpricedTokens)} tokens from unpriced models not included` : `List prices as of ${s.pricesAsOf}; not what your plan bills`)}
        ${tile('Sessions', String(s.sessions), t.tokens ? `${Math.round((t.cacheRead / t.tokens) * 100)}% of tokens were cache reads` : '')}
        ${quotaTiles(quota.latest)}
      </section>

      ${balanceCard}

      <div class="grid-12">
        <div class="col-7 card chart-container">
          <div class="chart-header">
            <h3 class="chart-title">Tokens per day</h3>
            <span class="card-subtitle">Measured token usage across agents</span>
          </div>
          <div id="c-daily" class="chart-body"></div>
        </div>

        <div class="col-5 card">
          <div class="card-header">
            <h3 class="card-title">By agent</h3>
            <span class="card-subtitle">${s.byAgent.length} active agents</span>
          </div>
          ${table([agentCol, ...tokCols], s.byAgent)}
        </div>
      </div>

      <div class="grid-12">
        <div class="col-6 card">
          <div class="card-header">
            <h3 class="card-title">By model</h3>
            <span class="card-subtitle">${models.length} models observed</span>
          </div>
          ${table([{ label: 'Model', get: (r) => r.name ?? 'unknown' }, agentCol, ...tokCols], models)}
        </div>

        <div class="col-6 card">
          <div class="card-header">
            <h3 class="card-title">Top projects</h3>
            <a href="#/projects" class="btn btn-sm btn-outline">All projects &rarr;</a>
          </div>
          ${table(projectCols, projects.slice(0, 8), (r) => `#/project/${r.projectId}`)}
        </div>
      </div>
    `,
    after: () => {
      if (days.length) {
        chart('c-daily', days.map((d) => Date.parse(`${d}T00:00:00`) / 1000),
          agents.map((a) => ({
            label: AGENTS[a] ?? a,
            color: COLORS[a],
            data: days.map((d) => daily.find((x) => x.day === d && x.agent === a)?.tokens ?? 0),
          })));
      }
    },
  };
}

async function projectsPage() {
  const rows = await api('projects');
  return {
    html: `
      <div class="card-header" style="margin-bottom:var(--space-4)">
        <div>
          <h1 style="margin:0;font-size:18px;font-weight:600">Projects</h1>
          <p class="hint" style="margin:4px 0 0">Grouped by git repository; worktrees count toward their main repo. Click a row to view project details.</p>
        </div>
      </div>
      <div class="card">
        ${table([...projectCols, { label: 'Path', get: (r) => r.root }], rows, (r) => `#/project/${r.projectId}`)}
      </div>
    `,
  };
}

async function projectPage(projectId) {
  const [projects, recData, findData, auditData, sessions, settingsRes, outcomesRes] = await Promise.all([
    api('projects'),
    api('recommendations', { project: projectId }),
    api('findings', { project: projectId }),
    api('audit', { project: projectId }),
    api('sessions', { project: projectId, limit: '20' }),
    fetch('/api/settings').then((r) => r.json()).catch(() => ({ settings: {} })),
    api('outcomes').catch(() => []),
  ]);

  const p = projects.find((x) => String(x.projectId) === String(projectId));
  if (!p) return { html: emptyState('Project not found', 'Project is not recognized or has no recorded sessions.') };

  const outcome = Array.isArray(outcomesRes) ? outcomesRes.find((o) => String(o.projectId) === String(projectId)) : null;

  const recs = recData.recommendations || [];
  const findings = findData.findings || [];
  const auditItems = auditData.items || [];
  const settings = settingsRes.settings || {};
  const allowAgentLaunch = settings.allow_agent_launch === 'true';

  const fixItems = [];

  for (const r of recs) {
    if (r.status === 'dismissed') continue;
    const f = findings.find((x) => x.rule === r.findingRule && (x.projectId == null || String(x.projectId) === String(projectId)));
    const agent = f?.evidence?.agent || (p.agents ? p.agents.split(',')[0] : 'claude');
    const evidenceOneLine = f ? (f.confidenceReason || JSON.stringify(f.evidence)) : (r.body || 'Identified workflow waste');
    fixItems.push({
      type: 'recommendation',
      id: r.id,
      title: r.title,
      evidence: evidenceOneLine,
      agent,
      rule: r.findingRule,
      estSavings: r.score || f?.estTokensWeek || 2000,
      status: r.status,
      actionSnippet: r.actionSnippet,
      finding: f,
      rec: r,
    });
  }

  for (const item of auditItems) {
    if (item.status === 'unused' || item.status === 'duplicate' || item.status === 'conflict') {
      const estSavings = (item.tokens || 100) * 10;
      fixItems.push({
        type: 'audit',
        id: item.id,
        title: `Remove or resolve ${item.status} ${item.kind} '${item.name}'`,
        evidence: `Source: ${item.sourcePath} (${item.status})`,
        agent: item.agent === 'all' ? (p.agents ? p.agents.split(',')[0] : 'claude') : item.agent,
        rule: `unused_${item.kind}`,
        estSavings,
        status: 'open',
        auditItem: item,
      });
    }
  }

  fixItems.sort((a, b) => (b.estSavings || 0) - (a.estSavings || 0));

  const fixNowRows = fixItems.length === 0
    ? `<div style="padding:24px;text-align:center;color:var(--text-muted)">All clear! No open recommendations or audit issues detected for this project.</div>`
    : `
      <div class="table-card-scroll">
        <table>
          <thead>
            <tr>
              <th>Fix Action</th>
              <th>Evidence</th>
              <th class="num">Est. Savings</th>
              <th>Agent</th>
              <th>Status</th>
              <th style="text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${fixItems.map((item) => `
              <tr data-fix-id="${esc(item.id)}" data-rule="${esc(item.rule)}" data-agent="${esc(item.agent)}">
                <td style="font-weight:500">${esc(item.title)}</td>
                <td style="color:var(--text-muted);font-size:12px;max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(item.evidence)}</td>
                <td class="num" style="font-weight:600;color:var(--success)">+${fmtTok(item.estSavings)}/wk</td>
                <td><span class="badge" style="background:var(--surface-subtle);border:1px solid var(--border)">${esc(item.agent)}</span></td>
                <td><span class="pill pill-${esc(item.status)} status-pill">${esc(item.status.toUpperCase())}</span></td>
                <td style="text-align:right">
                  <div style="display:inline-flex;gap:6px">
                    <button class="btn btn-sm btn-outline btn-copy-fix" data-id="${esc(item.id)}" data-rule="${esc(item.rule)}" data-agent="${esc(item.agent)}" title="Copy generated prompt to clipboard">Copy Prompt</button>
                    <button class="btn btn-sm btn-send-agent ${allowAgentLaunch ? '' : 'btn-outline'}" data-id="${esc(item.id)}" data-rule="${esc(item.rule)}" data-agent="${esc(item.agent)}" ${allowAgentLaunch ? '' : 'data-disabled-reason="launch_disabled"'} title="${allowAgentLaunch ? 'Send fix to agent CLI' : 'Enable agent launching in Settings'}">
                      ${allowAgentLaunch ? 'Send to agent' : 'Send (Disabled)'}
                    </button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

  return {
    html: `
      <div class="card-header" style="margin-bottom:var(--space-4);flex-wrap:wrap;gap:12px">
        <div>
          <div style="display:flex;align-items:center;gap:8px">
            <h1 style="margin:0;font-size:18px;font-weight:600">${esc(p.name)}</h1>
            <span class="badge" style="background:var(--surface-subtle);border:1px solid var(--border)">${esc(p.agents)}</span>
          </div>
          <p class="hint" style="margin:4px 0 0;font-family:var(--font-mono);font-size:12px">${esc(p.root)}</p>
        </div>
        <a href="#/projects" class="btn btn-sm btn-outline">&larr; All projects</a>
      </div>

      <!-- Fix Now Panel -->
      <div class="card" style="margin-bottom:var(--space-4);border-color:var(--accent-subtle)">
        <div class="card-header">
          <div>
            <h3 class="card-title" style="color:var(--accent)">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
              </svg>
              Fix Now
            </h3>
            <span class="card-subtitle">Prioritized actions to eliminate token waste in this project. Ranked by weekly savings.</span>
          </div>
          ${!allowAgentLaunch ? `<a href="#/settings" class="badge" style="background:var(--warn-bg);color:var(--warn);text-decoration:none">Agent Launch Disabled in Settings</a>` : ''}
        </div>
        ${fixNowRows}
      </div>

      <!-- Project KPIs -->
      <section class="tiles-row">
        ${tile('Tokens (measured)', fmtTok(p.tokens), `${fmtTok(p.cacheRead)} cache read`)}
        ${tile('API-equivalent cost (estimated)', cost(p))}
        ${tile('Sessions', String(p.sessions))}
        ${tile('Last active', fmtTime(p.lastActive))}
      </section>

      <!-- Weekly Budget Card -->
      <div class="card" style="margin-top:var(--space-4)">
        <div class="card-header" style="align-items:flex-start">
          <div>
            <h3 class="card-title">Weekly Token Budget</h3>
            <span class="card-subtitle">Set a 7-day token and cost limit for this project</span>
          </div>
          <button id="btn-toggle-budget-form" class="btn btn-sm btn-outline">${p.budgetTokens ? 'Edit Budget' : 'Set Budget'}</button>
        </div>
        ${p.budgetTokens ? `
          <div style="margin-top:12px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
              <div>
                <span style="font-size:20px;font-weight:700;color:${p.budgetPct >= 100 ? 'var(--danger)' : p.budgetPct >= 80 ? 'var(--warn)' : 'var(--success)'}">${p.budgetPct}%</span>
                <span style="color:var(--text-muted);font-size:13px;margin-left:6px">(${fmtTok(p.tokens)} used of ${fmtTok(p.budgetTokens)} budget)</span>
              </div>
              <div style="font-size:12px;color:var(--text-muted)">
                ${p.budgetCost ? `Budgeted cost: $${p.budgetCost.toFixed(2)} · ` : ''}
                ${p.budgetPct >= 100 ? '<span class="badge" style="background:var(--danger-bg);color:var(--danger)">Budget Exceeded</span>' : p.budgetPct >= 80 ? '<span class="badge" style="background:var(--warn-bg);color:var(--warn)">Warning &gt;80%</span>' : '<span class="badge" style="background:var(--success-bg);color:var(--success)">Within Budget</span>'}
              </div>
            </div>
            <div style="width:100%;height:10px;background:var(--surface-subtle);border-radius:5px;overflow:hidden">
              <div style="width:${Math.min(p.budgetPct, 100)}%;height:100%;background:${p.budgetPct >= 100 ? 'var(--danger)' : p.budgetPct >= 80 ? 'var(--warn)' : 'var(--success)'};border-radius:5px"></div>
            </div>
          </div>
        ` : `
          <p style="color:var(--text-muted);font-size:13px;margin-top:8px">No budget configured. Set a weekly token budget to track consumption and receive alerts.</p>
        `}

        <form id="form-project-budget" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
          <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px">
              <span>Weekly Tokens (e.g. 1000000)</span>
              <input type="number" id="input-budget-tokens" class="form-input" style="width:180px" value="${p.budgetTokens || ''}" placeholder="Tokens limit" min="0" step="1000" />
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px">
              <span>Weekly Cost limit ($ USD, optional)</span>
              <input type="number" id="input-budget-cost" class="form-input" style="width:180px" value="${p.budgetCost || ''}" placeholder="Cost limit ($)" min="0" step="1" />
            </label>
            <button type="submit" class="btn btn-sm">Save Budget</button>
            ${p.budgetTokens ? `<button type="button" id="btn-clear-budget" class="btn btn-sm btn-outline" style="color:var(--danger)">Remove Budget</button>` : ''}
          </div>
        </form>
      </div>

      <!-- Outcome Efficiency Card -->
      ${outcome ? `
        <div class="card" style="margin-top:var(--space-4)">
          <div class="card-header">
            <div>
              <h3 class="card-title">Git Outcome Efficiency</h3>
              <span class="card-subtitle">Tokens expended per git commit and changed line</span>
            </div>
            <span class="badge" style="background:var(--surface-subtle);border:1px solid var(--border)">${outcome.commits} commits · ${fmtTok(outcome.linesChanged)} lines</span>
          </div>
          <div class="tiles-row" style="margin-top:12px;margin-bottom:12px">
            <div class="tile">
              <div class="tile-lbl">Tokens / Commit</div>
              <div class="tile-val" style="font-size:20px;font-weight:700;color:var(--text-main)">${fmtTok(outcome.tokensPerCommit)}</div>
              <div class="tile-lbl">${outcome.commits} total commits</div>
            </div>
            <div class="tile">
              <div class="tile-lbl">Tokens / Changed Line</div>
              <div class="tile-val" style="font-size:20px;font-weight:700;color:var(--text-main)">${fmtTok(outcome.tokensPerChangedLine)}</div>
              <div class="tile-lbl">${fmtTok(outcome.linesChanged)} lines changed</div>
            </div>
          </div>
          ${outcome.byAgent && outcome.byAgent.length > 0 ? `
            <div style="margin-top:12px">
              <h4 style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;margin-bottom:8px">By Agent</h4>
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th class="num">Tokens</th>
                    <th class="num">Commits</th>
                    <th class="num">Tokens / Commit</th>
                    <th class="num">Tokens / Line</th>
                  </tr>
                </thead>
                <tbody>
                  ${outcome.byAgent.map((ag) => `
                    <tr>
                      <td><strong>${esc(AGENTS[ag.agent] ?? ag.agent)}</strong></td>
                      <td class="num">${fmtTok(ag.tokens)}</td>
                      <td class="num">${ag.commits}</td>
                      <td class="num">${fmtTok(ag.tokensPerCommit)}</td>
                      <td class="num">${fmtTok(ag.tokensPerChangedLine)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : ''}
          ${outcome.trend && outcome.trend.length > 1 ? `
            <div style="margin-top:16px">
              <h4 style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;margin-bottom:8px">Commit Activity Trend</h4>
              <div id="c-outcome-trend" style="height:140px"></div>
            </div>
          ` : ''}
        </div>
      ` : ''}

      <!-- Recent Sessions -->
      <div class="card" style="margin-top:var(--space-4)">
        <div class="card-header">
          <h3 class="card-title">Recent Project Sessions</h3>
          <span class="card-subtitle">Sessions associated with this workspace</span>
        </div>
        ${table([
          { label: 'Last activity', get: (r) => fmtTime(r.ended) },
          agentCol,
          { label: 'Turns', num: true, get: (r) => r.turns },
          { label: 'Tool calls', num: true, get: (r) => r.toolCalls },
          ...tokCols,
        ], sessions, (r) => `#/session/${encodeURIComponent(r.id)}`)}
      </div>
    `,
    after: () => {
      document.querySelectorAll('.btn-copy-fix').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const id = e.currentTarget.dataset.id;
          const rule = e.currentTarget.dataset.rule;
          const agent = e.currentTarget.dataset.agent;
          const row = e.currentTarget.closest('tr');
          btn.disabled = true;

          try {
            const promptRes = await fetch('/api/fix/prompt', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                rule,
                agent,
                projectId,
                projectName: p.name,
                projectRoot: p.root,
              }),
            }).then((r) => r.json());

            const prompt = promptRes.prompt;
            await navigator.clipboard.writeText(prompt);

            if (id.startsWith('rec:')) {
              await fetch(`/api/recommendations/${encodeURIComponent(id)}/accept`, { method: 'POST' });
            }

            btn.textContent = 'Copied!';
            const statusPill = row?.querySelector('.status-pill');
            if (statusPill) {
              statusPill.textContent = 'MEASURING';
              statusPill.className = 'pill pill-measuring status-pill';
            }

            setTimeout(() => { btn.textContent = 'Copy Prompt'; btn.disabled = false; }, 2000);
          } catch (err) {
            alert(`Failed to copy prompt: ${err.message}`);
            btn.disabled = false;
          }
        });
      });

      document.querySelectorAll('.btn-send-agent').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          if (btn.dataset.disabledReason === 'launch_disabled') {
            alert('Agent execution is disabled by default for privacy & safety.\n\nPlease enable "Allow agentlens to launch agents" on the Settings page first.');
            location.hash = '#/settings';
            return;
          }

          const id = e.currentTarget.dataset.id;
          const rule = e.currentTarget.dataset.rule;
          const agent = e.currentTarget.dataset.agent;
          const row = e.currentTarget.closest('tr');

          const promptRes = await fetch('/api/fix/prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              rule,
              agent,
              projectId,
              projectName: p.name,
              projectRoot: p.root,
            }),
          }).then((r) => r.json());

          const prompt = promptRes.prompt;
          const defaultCli = agent === 'claude' ? 'claude' : agent === 'codex' ? 'codex' : 'opencode run';

          const confirmText = `Send Fix to Agent?\n\nCommand: ${defaultCli} "${prompt.slice(0, 80)}..."\nFolder: ${p.root}\n\nClick OK to launch in background terminal (or Cancel to abort).`;
          if (!confirm(confirmText)) return;

          btn.disabled = true;
          btn.textContent = 'Launching...';

          try {
            const runRes = await fetch('/api/fix/run', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                agent,
                prompt,
                projectId,
                recommendationId: id.startsWith('rec:') ? id : undefined,
                headless: false,
              }),
            });
            const data = await runRes.json();

            if (!runRes.ok) {
              alert(`Launch failed: ${data.error || runRes.statusText}`);
            } else {
              btn.textContent = 'Dispatched!';
              const statusPill = row?.querySelector('.status-pill');
              if (statusPill) {
                statusPill.textContent = 'MEASURING';
                statusPill.className = 'pill pill-measuring status-pill';
              }
              if (data.mode === 'headless' && data.diffStat) {
                openSlideOver(`Fix Output: ${p.name}`, `
                  <h4>Command Executed</h4>
                  <pre><code>${esc(data.command)}</code></pre>
                  <h4>Git Changes (git diff --stat)</h4>
                  <pre><code>${esc(data.diffStat || 'No working tree changes recorded.')}</code></pre>
                  ${data.output ? `<h4>Output</h4><pre><code>${esc(data.output)}</code></pre>` : ''}
                `);
              }
            }
          } catch (err) {
            alert(`Error running fix: ${err.message}`);
          } finally {
            setTimeout(() => { btn.disabled = false; btn.textContent = 'Send to agent'; }, 2500);
          }
        });
      });

      $('#btn-toggle-budget-form')?.addEventListener('click', () => {
        const form = $('#form-project-budget');
        if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
      });
      $('#form-project-budget')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const tokens = Number($('#input-budget-tokens').value) || null;
        const costVal = Number($('#input-budget-cost').value) || null;
        await fetch('/api/project/budget', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, budgetTokens: tokens, budgetCost: costVal }),
        });
        render();
      });
      $('#btn-clear-budget')?.addEventListener('click', async () => {
        await fetch('/api/project/budget', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, budgetTokens: 0, budgetCost: 0 }),
        });
        render();
      });

      if (outcome?.trend && outcome.trend.length > 1) {
        const trendDays = outcome.trend.map((t) => Date.parse(`${t.date}T00:00:00`) / 1000);
        chart('c-outcome-trend', trendDays, [
          { label: 'Commits', color: 'var(--accent)', data: outcome.trend.map((t) => t.commits) },
          { label: 'Lines changed', color: 'var(--success)', data: outcome.trend.map((t) => t.linesChanged) },
        ]);
      }
    },
  };
}

async function sessionsPage() {
  const rows = await api('sessions', { limit: '300' });
  return {
    html: `
      <div class="card-header" style="margin-bottom:var(--space-4)">
        <div>
          <h1 style="margin:0;font-size:18px;font-weight:600">Sessions</h1>
          <p class="hint" style="margin:4px 0 0">Latest agent sessions ingested into local sqlite. Click a row to inspect turn-by-turn context growth.</p>
        </div>
      </div>
      <div class="card">
        ${table([
          { label: 'Last activity', get: (r) => fmtTime(r.ended) },
          agentCol,
          { label: 'Project', get: (r) => r.project ?? '—' },
          { label: 'Kind', get: (r) => (r.parentId ? 'subagent' : 'main') },
          { label: 'Turns', num: true, get: (r) => r.turns },
          { label: 'Tool calls', num: true, get: (r) => r.toolCalls },
          ...tokCols,
        ], rows, (r) => `#/session/${encodeURIComponent(r.id)}`)}
      </div>
    `,
  };
}

async function sessionPage(id) {
  const d = await api('session', { id: decodeURIComponent(id) });
  if (!d) return { html: emptyState('Session not found', 'It may not have been ingested yet; check Health.') };

  return {
    html: `
      <div class="card-header" style="margin-bottom:var(--space-4)">
        <div>
          <h1 style="margin:0;font-size:18px;font-weight:600">${esc(AGENTS[d.agent] ?? d.agent)} session</h1>
          <p class="hint" style="margin:4px 0 0">${esc(d.project ?? d.cwd ?? '')} · <code>${esc(d.id)}</code>${d.parentId ? ` · subagent of <a href="#/session/${encodeURIComponent(d.parentId)}">${esc(d.parentId)}</a>` : ''}</p>
        </div>
        <a href="#/sessions" class="btn btn-sm btn-outline">&larr; Back to sessions</a>
      </div>

      <section class="tiles-row">
        ${tile('Tokens (measured)', fmtTok(d.totals.tokens))}
        ${tile('API-equivalent cost (estimated)', cost(d.totals))}
        ${tile('Turns', String(d.turns.length))}
        ${tile('Tool Calls', String(d.tools.reduce((acc, t) => acc + (t.calls || 0), 0)))}
      </section>

      <div class="grid-12">
        <div class="col-7 card chart-container">
          <div class="chart-header">
            <h3 class="chart-title">Context size per turn</h3>
            <span class="card-subtitle">Input plus cache tokens sent on each turn. Steady growth means no compaction occurred.</span>
          </div>
          <div id="c-ctx" class="chart-body"></div>
        </div>

        <div class="col-5 card">
          <div class="card-header">
            <h3 class="card-title">Tools invoked</h3>
            <span class="card-subtitle">${d.tools.length} unique tools</span>
          </div>
          ${table([
            { label: 'Tool', get: (r) => r.tool },
            { label: 'Calls', num: true, get: (r) => r.calls },
            { label: 'Result size', num: true, get: (r) => `${fmtTok(r.resultBytes)}B` },
            { label: 'Errors', num: true, get: (r) => r.errors },
          ], d.tools)}
        </div>
      </div>

      ${d.children.length ? `
        <div class="card" style="margin-top:var(--space-4)">
          <div class="card-header"><h3 class="card-title">Subagent sessions</h3></div>
          ${table([{ label: 'Session', get: (r) => r.id }, agentCol], d.children, (r) => `#/session/${encodeURIComponent(r.id)}`)}
        </div>
      ` : ''}
    `,
    after: () => {
      if (d.turns.length) {
        chart('c-ctx', d.turns.map((_, i) => i + 1),
          [{ label: 'Context tokens', color: COLORS[d.agent], data: d.turns.map((t) => t.context) }],
          { time: false });
      }
    },
  };
}

async function quotaPage() {
  const q = await api('quota');
  const keys = [...new Set(q.timeline.map((p) => `${p.agent}|${p.win}`))];
  const xs = [...new Set(q.timeline.map((p) => p.ts))].sort((a, b) => a - b);
  const idx = new Map(xs.map((x, i) => [x, i]));

  return {
    html: `
      <div class="card-header" style="margin-bottom:var(--space-4)">
        <div>
          <h1 style="margin:0;font-size:18px;font-weight:600">Quota & Rate Limits</h1>
          <p class="hint" style="margin:4px 0 0">Percentages exactly as reported by each agent API. Agents that don't report quota show n/a.</p>
        </div>
      </div>

      <section class="tiles-row">
        ${quotaTiles(q.latest)}
      </section>

      <div class="grid-12">
        <div class="col-7 card chart-container">
          <div class="chart-header">
            <h3 class="chart-title">Usage over time</h3>
            <span class="card-subtitle">Burn rate across sliding windows</span>
          </div>
          <div id="c-quota" class="chart-body"></div>
        </div>

        <div class="col-5 card">
          <div class="card-header">
            <h3 class="card-title">Limit hits</h3>
            <span class="card-subtitle">${q.limitHits.length} incidents logged</span>
          </div>
          ${table([
            agentCol,
            { label: 'Window', get: (r) => r.win },
            { label: 'First hit', get: (r) => fmtTime(r.firstHit) },
            { label: 'Window reset', get: (r) => fmtTime(r.resetsAt) },
          ], q.limitHits)}
        </div>
      </div>
    `,
    after: () => {
      if (xs.length) {
        chart('c-quota', xs.map((x) => x / 1000), keys.map((k) => {
          const [agent, win] = k.split('|');
          const data = new Array(xs.length).fill(null);
          for (const p of q.timeline) if (p.agent === agent && p.win === win) data[idx.get(p.ts)] = p.usedPct;
          return { label: `${AGENTS[agent] ?? agent} ${win}`, color: COLORS[agent], dash: win === '7d' ? [6, 4] : undefined, data };
        }), { fmt: (v) => `${Math.round(v)}%` });
      }
    },
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
    add: 'var(--success)',
    remove: 'var(--danger)',
    replace: 'var(--warn)',
    improve: 'var(--accent)',
  };

  const CONF_COLORS = {
    high: 'var(--success)',
    medium: 'var(--warn)',
    low: 'var(--text-muted)',
  };

  const tiles = `
    <div class="tiles-row">
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
        <div class="note">Across workflow detectors</div>
      </div>
    </div>
  `;

  const trackedSection = trackedItems.length > 0 ? `
    <div class="card-header" style="margin-top:var(--space-4)">
      <h2 style="margin:0;font-size:15px;font-weight:600">Tracked Improvements (${trackedItems.length})</h2>
      <span class="card-subtitle">14-day pre- vs post-adoption verification with quality guardrails</span>
    </div>
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
              <span class="badge" style="border:1px solid var(--border);color:var(--text)">${esc(r.findingRule.replace(/_/g, ' '))}</span>
              <span class="track-delta ${deltaClass}" style="margin-left:auto">${esc(delta)}</span>
            </div>
            <h3 style="margin:8px 0 4px;font-size:14.5px">${esc(r.title)}</h3>
            ${res ? `
              <div class="track-metric">Target: <strong>${esc(res.metricName)}</strong> (${fmtTok(res.baselineVal)} &rarr; ${fmtTok(res.currentVal)})</div>
              <div class="track-metric">Samples: ${res.sampleBefore} before &middot; ${res.sampleAfter} after (min 5)</div>
              <div class="track-metric">Guardrails: <span style="font-weight:600;color:${res.guardrails?.passed ? 'var(--success)' : 'var(--danger)'}">${res.guardrails?.passed ? 'PASSED' : 'REGRESSED'}</span></div>
            ` : `<p style="color:var(--text-muted);font-size:12px;margin:4px 0">Tracking initialized &middot; gathering sessions...</p>`}
          </div>
        `;
      }).join('')}
    </div>
  ` : '';

  const recList = openRecs.length === 0
    ? emptyState('No open recommendations!', 'All active waste patterns resolved or dismissed.')
    : `<div class="rec-grid">
        ${openRecs.map((r) => `
          <div class="rec-card" data-rec-id="${esc(r.id)}">
            <div class="rec-header">
              <span class="badge" style="background:${ACTION_COLORS[r.action] || 'var(--accent)'};color:#fff">${esc(r.action.toUpperCase())}</span>
              <span class="badge" style="border:1px solid var(--border);color:var(--text)">${esc(r.findingRule.replace(/_/g, ' '))}</span>
              <span style="margin-left:auto;font-weight:600;color:var(--success)">${r.score ? `+${fmtTok(r.score)} tokens/wk` : ''}</span>
            </div>
            <h3 style="margin:8px 0 4px;font-size:14.5px">${esc(r.title)}</h3>
            <p style="margin:0 0 10px;color:var(--text-muted);font-size:13px">${esc(r.body)}</p>
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
      <div class="card-header" style="margin-bottom:var(--space-4)">
        <div>
          <h1 style="margin:0;font-size:18px;font-weight:600">Recommendations & Findings</h1>
          <p class="hint" style="margin:4px 0 0">Deterministic workflow waste detection, potential savings, and actionable configuration suggestions.</p>
        </div>
      </div>
      ${tiles}
      ${trackedSection}
      <div class="card-header" style="margin-top:var(--space-4)">
        <h2 style="margin:0;font-size:15px;font-weight:600">Active Recommendations</h2>
      </div>
      ${recList}
      <div class="card-header" style="margin-top:var(--space-4)">
        <h2 style="margin:0;font-size:15px;font-weight:600">Workflow Findings (${findings.length})</h2>
        <span class="card-subtitle">Click row to drill into session turn context</span>
      </div>
      <div class="card">
        ${findingsTable}
      </div>
    `,
    after: () => {
      document.querySelectorAll('.btn-accept').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const id = e.currentTarget.dataset.id;
          await fetch(`/api/recommendations/${encodeURIComponent(id)}/accept`, { method: 'POST' });
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
    <div class="tiles-row">
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
        <div class="value" style="${summary.unusedCount > 0 ? 'color:var(--danger)' : ''}">${summary.unusedCount}</div>
        <div class="note">Stale MCPs, skills, or plugins</div>
      </div>
      <div class="tile">
        <div class="label">Duplicates & Conflicts</div>
        <div class="value" style="${summary.duplicateCount + summary.conflictCount > 0 ? 'color:var(--warn)' : ''}">${summary.duplicateCount + summary.conflictCount}</div>
        <div class="note">${summary.duplicateCount} duplicates, ${summary.conflictCount} conflicts</div>
      </div>
    </div>
  `;

  return {
    html: `
      <div class="card-header" style="margin-bottom:var(--space-4)">
        <div>
          <h1 style="margin:0;font-size:18px;font-weight:600">Configuration Audit</h1>
          <p class="hint" style="margin:4px 0 0">Read-only audit of always-loaded instruction overhead, MCPs, skills, plugins, duplicates, and conflicts.</p>
        </div>
      </div>
      ${tiles}

      <div class="grid-12">
        <div class="col-6 card">
          <div class="card-header">
            <h3 class="card-title">Instruction Files (${instructions.length})</h3>
            <span class="card-subtitle">Always-loaded context injected on turns</span>
          </div>
          ${table([
            agentCol,
            { label: 'Name', get: (r) => r.name },
            { label: 'Tokens', num: true, get: (r) => fmtTok(r.tokens) },
            { label: 'Chars', num: true, get: (r) => fmtInt(r.details?.chars) },
            { label: 'Source Path', get: (r) => r.sourcePath },
          ], instructions)}
        </div>

        <div class="col-6 card">
          <div class="card-header">
            <h3 class="card-title">MCP Servers & Plugins (${toolsAndMcps.length})</h3>
            <span class="card-subtitle">Correlated with 30-day tool call history</span>
          </div>
          ${table([
            agentCol,
            { label: 'Type', get: (r) => r.kind.toUpperCase() },
            { label: 'Name', get: (r) => r.name },
            { label: 'Status', html: true, get: (r) => statusPill(r.status) },
            { label: '30d Calls', num: true, get: (r) => r.invocations30d > 0 ? fmtInt(r.invocations30d) : 'none' },
            { label: 'Source Path', get: (r) => r.sourcePath },
          ], toolsAndMcps)}
        </div>
      </div>

      <div class="grid-12">
        <div class="col-6 card">
          <div class="card-header">
            <h3 class="card-title">Skills (${skills.length})</h3>
            <span class="card-subtitle">Available in global or project repositories</span>
          </div>
          ${table([
            agentCol,
            { label: 'Skill Name', get: (r) => r.name },
            { label: 'Status', html: true, get: (r) => statusPill(r.status) },
            { label: '30d Calls', num: true, get: (r) => r.invocations30d > 0 ? fmtInt(r.invocations30d) : 'none' },
            { label: 'Tokens', num: true, get: (r) => fmtTok(r.tokens) },
          ], skills)}
        </div>

        <div class="col-6 card">
          <div class="card-header">
            <h3 class="card-title">Flagged Duplicates & Conflicts (${issues.length})</h3>
            <span class="card-subtitle">Configurations declared in multiple places</span>
          </div>
          ${issues.length === 0 ? emptyState('No duplicates or conflicts', 'All tool and instruction declarations are consistent.') : table([
            agentCol,
            { label: 'Issue', html: true, get: (r) => statusPill(r.status) },
            { label: 'Type', get: (r) => r.kind.toUpperCase() },
            { label: 'Name', get: (r) => r.name },
            { label: 'Source Path', get: (r) => r.sourcePath },
          ], issues)}
        </div>
      </div>
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
    <div class="card-header" style="margin-bottom:var(--space-4);flex-wrap:wrap;gap:12px">
      <div style="display:flex;align-items:center;gap:10px">
        <label for="rep-select" style="font-weight:600;font-size:13px">Report:</label>
        <select id="rep-select" class="form-select" style="max-width:300px">
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
        <div class="card-header">
          <div>
            <h1 style="margin:0;font-size:18px;font-weight:600">Weekly Usage Reports</h1>
            <p class="hint" style="margin:4px 0 0">Automated weekly usage, cost trends, quota peaks, token-wasting patterns, and action items.</p>
          </div>
        </div>
        ${selector}
        <div class="card" style="text-align:center;padding:40px">
          ${emptyState('No weekly report available yet', 'Generate a report to inspect weekly patterns.', '<button class="btn" id="btn-gen-first">Generate Report Now</button>')}
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

  const d = reportDetail.data || {};
  const s = d.summary || { totalTokens: 0, tokensDeltaPct: 0, totalCost: 0, costDeltaPct: 0, activeSessions: 0, sessionsDeltaPct: 0 };
  const q = d.quotaInsights || { fiveHourPeakPct: 0, limitHits: 0 };
  const weekLabel = d.week || selectedWeek || 'Current';
  const dateRange = (d.startDate && d.endDate) ? ` (${esc(d.startDate)} to ${esc(d.endDate)})` : '';
  const tiles = `
    <div class="tiles-row">
      <div class="tile">
        <div class="label">Tokens (measured)</div>
        <div class="value">${fmtTok(s.totalTokens)}</div>
        <div class="note">${fmtDelta(s.tokensDeltaPct)} vs prev week</div>
      </div>
      <div class="tile">
        <div class="label">API Cost (estimated)</div>
        <div class="value">${fmtUsd(s.totalCost)}</div>
        <div class="note">${fmtDelta(s.costDeltaPct)} vs prev week</div>
      </div>
      <div class="tile">
        <div class="label">Active Sessions</div>
        <div class="value">${s.activeSessions}</div>
        <div class="note">${fmtDelta(s.sessionsDeltaPct)} vs prev week</div>
      </div>
      <div class="tile">
        <div class="label">5h Peak Quota</div>
        <div class="value">${q.fiveHourPeakPct}%</div>
        <div class="note">${q.limitHits} limit hits recorded</div>
      </div>
    </div>
  `;

  const mode = state.reportMode || 'preview';
  return {
    html: `
      <div class="card-header" style="margin-bottom:var(--space-4)">
        <div>
          <h1 style="margin:0;font-size:18px;font-weight:600">Weekly Usage Reports</h1>
          <p class="hint" style="margin:4px 0 0">Automated weekly usage, cost trends, quota peaks, and action items.</p>
        </div>
      </div>
      ${selector}
      ${tiles}
      <div class="report-viewer card">
        <div class="card-header" style="flex-wrap:wrap;gap:8px">
          <h2 style="margin:0;font-size:15px;font-weight:600">Report: ${esc(weekLabel)}${dateRange}</h2>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button id="btn-toggle-mode" class="btn btn-sm btn-outline">${mode === 'preview' ? 'View Markdown' : 'View Rendered HTML'}</button>
            <button id="btn-copy-md" class="btn btn-sm btn-outline">Copy Markdown</button>
            <a href="data:text/html;charset=utf-8,${encodeURIComponent(reportDetail.html || '')}" download="${esc(weekLabel)}.html" class="btn btn-sm btn-outline">Download HTML</a>
            <a href="/api/reports/${encodeURIComponent(weekLabel)}" target="_blank" class="btn btn-sm btn-outline">View Raw JSON</a>
          </div>
        </div>
        ${mode === 'preview'
          ? `<iframe srcdoc="${esc(reportDetail.html || '')}" style="width:100%;min-height:550px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg)"></iframe>`
          : `<pre><code>${esc(reportDetail.markdown || '')}</code></pre>`
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

async function catalogPage() {
  const [catRes, candRes] = await Promise.all([
    fetch('/api/catalog').then((r) => r.json()).catch(() => ({ catalog: [] })),
    fetch('/api/candidates').then((r) => r.json()).catch(() => ({ candidates: [] })),
  ]);

  const catalog = catRes.catalog || [];
  const candidates = candRes.candidates || [];
  const tab = state.catalogTab || 'curated';
  const kindFilter = state.catalogKind || 'all';

  let filteredCatalog = catalog;
  if (kindFilter !== 'all') {
    filteredCatalog = catalog.filter((c) => c.kind === kindFilter);
  }

  const tabsHtml = `
    <div class="card-header" style="margin-bottom:var(--space-4);flex-wrap:wrap;gap:12px">
      <div style="display:flex;gap:8px">
        <button id="tab-curated" class="btn btn-sm ${tab === 'curated' ? '' : 'btn-outline'}">Curated Tools & MCPs (${catalog.length})</button>
        <button id="tab-candidates" class="btn btn-sm ${tab === 'candidates' ? '' : 'btn-outline'}">Discovered Candidates (${candidates.length})</button>
      </div>
      ${tab === 'curated' ? `
        <div style="display:flex;align-items:center;gap:8px">
          <label style="font-size:12px;color:var(--text-muted)">Kind:
            <select id="sel-cat-kind" class="form-select" style="font-size:12px;padding:2px 6px">
              <option value="all" ${kindFilter === 'all' ? 'selected' : ''}>All Types</option>
              <option value="mcp" ${kindFilter === 'mcp' ? 'selected' : ''}>MCP Servers</option>
              <option value="tool" ${kindFilter === 'tool' ? 'selected' : ''}>CLI Tools</option>
              <option value="plugin" ${kindFilter === 'plugin' ? 'selected' : ''}>Plugins</option>
              <option value="skill" ${kindFilter === 'skill' ? 'selected' : ''}>Skills</option>
            </select>
          </label>
        </div>
      ` : ''}
    </div>
  `;

  let contentHtml = '';
  if (tab === 'curated') {
    contentHtml = `
      <div class="catalog-grid">
        ${filteredCatalog.map((item) => `
          <div class="catalog-card">
            <div class="catalog-header">
              <div>
                <h3 class="catalog-title">${esc(item.name)}</h3>
                <div style="display:flex;gap:6px;margin-top:4px">
                  <span class="badge" style="background:var(--border)">${esc(item.kind.toUpperCase())}</span>
                  <span class="pill pill-active">~${item.estSavingsPct}% Potential Savings</span>
                </div>
              </div>
            </div>
            <div class="catalog-desc">${esc(item.description)}</div>
            <div style="margin-bottom:12px">
              <span style="font-size:11px;color:var(--text-muted)">Targets Waste Patterns:</span>
              <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">
                ${item.targetRules.map((r) => `<span class="pill" style="background:var(--bg)">${esc(r)}</span>`).join('')}
              </div>
            </div>
            ${item.installCommand ? `
              <div class="catalog-install">
                <code>${esc(item.installCommand)}</code>
              </div>
            ` : ''}
            <div style="margin-top:auto;display:flex;justify-content:space-between;align-items:center">
              <a href="${esc(item.url)}" target="_blank" class="btn btn-sm btn-outline">View Repository &nearr;</a>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  } else {
    contentHtml = `
      <div class="card" style="margin-bottom:var(--space-4)">
        <h3 style="margin:0 0 6px 0;font-size:14px">Opt-In GitHub Discovery</h3>
        <p class="hint" style="margin-bottom:12px">
          Search GitHub for public AI developer tools and MCPs. <strong>Privacy Guarantee:</strong> Searches use only generic keywords. Your code, prompts, project names, and tokens are never sent.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input type="text" id="inp-discover-q" placeholder="Search keywords (e.g. mcp server postgres)" style="flex:1;min-width:240px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg);color:var(--text);font:inherit" />
          <button id="btn-run-discover" class="btn btn-sm">Discover Tools</button>
        </div>
      </div>
      ${candidates.length === 0 ? emptyState('No candidate tools discovered yet', 'Click "Discover Tools" above or run agentlens discover.') : `
        <div class="catalog-grid">
          ${candidates.map((c) => `
            <div class="catalog-card">
              <div class="catalog-header">
                <div>
                  <h3 class="catalog-title">${esc(c.fullName)}</h3>
                  <div style="display:flex;gap:6px;margin-top:4px">
                    <span class="badge" style="background:var(--warn-bg);color:var(--warn)">★ ${c.stars.toLocaleString()}</span>
                    <span class="badge" style="background:var(--border)">${esc(c.suggestedKind.toUpperCase())}</span>
                    ${c.relevanceRule ? `<span class="pill" style="background:var(--bg)">${esc(c.relevanceRule)}</span>` : ''}
                  </div>
                </div>
              </div>
              <div class="catalog-desc">${esc(c.description || 'No description provided')}</div>
              <div style="margin-top:auto">
                <a href="${esc(c.url)}" target="_blank" class="btn btn-sm btn-outline">View on GitHub &nearr;</a>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    `;
  }

  return {
    html: `
      <div class="card-header" style="margin-bottom:var(--space-4)">
        <div>
          <h1 style="margin:0;font-size:18px;font-weight:600">Tool Catalog & Discovery</h1>
          <p class="hint" style="margin:4px 0 0">Curated AI tools, MCPs, and skills mapped to workflow waste patterns.</p>
        </div>
      </div>
      ${tabsHtml}
      ${contentHtml}
    `,
    after: () => {
      $('#tab-curated')?.addEventListener('click', () => {
        state.catalogTab = 'curated';
        render();
      });
      $('#tab-candidates')?.addEventListener('click', () => {
        state.catalogTab = 'candidates';
        render();
      });
      $('#sel-cat-kind')?.addEventListener('change', (e) => {
        state.catalogKind = e.target.value;
        render();
      });
      $('#btn-run-discover')?.addEventListener('click', async (e) => {
        const btn = e.target;
        const q = $('#inp-discover-q')?.value?.trim();
        btn.disabled = true;
        btn.textContent = 'Discovering...';
        try {
          const res = await fetch('/api/discover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: q || undefined }),
          });
          const data = await res.json();
          if (!res.ok) alert(`Discovery error: ${data.error || res.statusText}`);
          else render();
        } catch (err) {
          alert(`Network error: ${err.message}`);
        } finally {
          btn.disabled = false;
          btn.textContent = 'Discover Tools';
        }
      });
    },
  };
}

async function healthPage() {
  const h = await api('health');
  const badgeColor = h.status === 'healthy' ? 'var(--success)' : h.status === 'warning' ? 'var(--warn)' : 'var(--danger)';
  const badgeLabel = h.status ? h.status.charAt(0).toUpperCase() + h.status.slice(1) : 'Healthy';
  const statusBadge = `<span class="badge" style="background:${badgeColor};color:#fff;vertical-align:middle;margin-left:0.5rem">${badgeLabel}</span>`;

  const warningsHtml =
    h.warnings && h.warnings.length > 0
      ? `<div style="margin-bottom:var(--space-4);padding:var(--space-3) var(--space-4);background:var(--warn-bg);border-left:4px solid var(--warn);border-radius:var(--radius-md)">
          <strong style="color:var(--warn)">Warnings (${h.warnings.length})</strong>
          <ul style="margin:0.25rem 0 0 1.25rem;padding:0">
            ${h.warnings.map((w) => `<li style="margin:0.25rem 0">${esc(w)}</li>`).join('')}
          </ul>
        </div>`
      : '';

  const crossCheckHtml =
    h.crossCheck && h.crossCheck.length > 0
      ? `<div class="card" style="margin-top:var(--space-4)">
          <div class="card-header">
            <h3 class="card-title">ccusage Cross-Check</h3>
            <span class="card-subtitle">Daily token comparison against ccusage. Drift &gt; 5% triggers a warning.</span>
          </div>
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
                    ? '<span style="color:var(--danger);font-weight:600">Drift &gt; 5%</span>'
                    : '<span style="color:var(--success);font-weight:500">OK</span>',
              },
            ],
            h.crossCheck,
          )}
        </div>`
      : `<div class="card" style="margin-top:var(--space-4)">
          <div class="card-header"><h3 class="card-title">ccusage Cross-Check</h3></div>
          <p class="hint" style="margin:0">${h.ccusageAvailable === false ? 'ccusage binary was not detected in PATH. Install ccusage (<code>npm i -g ccusage</code>) to enable automatic daily cross-checking.' : 'No cross-check data available for the last 7 days.'}</p>
        </div>`;

  return {
    html: `
      <div class="card-header" style="margin-bottom:var(--space-4)">
        <div>
          <h1 style="margin:0;font-size:18px;font-weight:600">System Health ${statusBadge}</h1>
          <p class="hint" style="margin:4px 0 0">Ingestion status, parser integrity, and ccusage daily cross-checking.</p>
        </div>
      </div>
      ${warningsHtml}
      <div class="grid-12">
        <div class="col-6 card">
          <div class="card-header">
            <h3 class="card-title">Log sources</h3>
            <span class="card-subtitle">Tracked cursor offsets</span>
          </div>
          ${table([
            agentCol,
            { label: 'Files tracked', num: true, get: (r) => r.files },
            { label: 'Bad lines', num: true, get: (r) => r.badLines },
            { label: 'Last ingest', get: (r) => fmtTime(r.lastIngest) },
          ], h.sources)}
        </div>

        <div class="col-6 card">
          <div class="card-header">
            <h3 class="card-title">Events recorded</h3>
            <span class="card-subtitle">Database event log totals</span>
          </div>
          ${table([
            agentCol,
            { label: 'Events', num: true, get: (r) => r.events },
            { label: 'Latest event', get: (r) => fmtTime(r.latestEvent) },
          ], h.events)}
        </div>
      </div>
      ${crossCheckHtml}
    `,
  };
}

async function settingsPage() {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  let settings = {};
  let projectsList = [];
  try {
    const [sRes, pRes] = await Promise.all([
      fetch('/api/settings').then((r) => r.json()),
      fetch('/api/projects').then((r) => r.json()),
    ]);
    settings = sRes.settings || {};
    projectsList = Array.isArray(pRes) ? pRes : (pRes.projects || []);
  } catch {}
  const allowAgentLaunch = settings.allow_agent_launch === 'true';

  return {
    html: `
      <div class="card-header" style="margin-bottom:var(--space-4)">
        <div>
          <h1 style="margin:0;font-size:18px;font-weight:600">Settings</h1>
          <p class="hint" style="margin:4px 0 0">Configure agentlens preferences, layout, and automation permissions.</p>
        </div>
      </div>

      <div class="grid-12">
        <div class="col-6 card">
          <div class="card-header"><h3 class="card-title">Appearance & Layout</h3></div>
          <p style="margin-bottom:12px;color:var(--text-muted)">Customize dashboard theme and navigation.</p>
          <div style="display:flex;flex-direction:column;gap:12px">
            <label style="display:flex;align-items:center;justify-content:space-between">
              <span>Theme</span>
              <select id="settings-theme" class="form-select">
                <option value="dark" ${theme === 'dark' ? 'selected' : ''}>Dark (Default)</option>
                <option value="light" ${theme === 'light' ? 'selected' : ''}>Light</option>
              </select>
            </label>
            <label style="display:flex;align-items:center;justify-content:space-between">
              <span>Sidebar layout</span>
              <button id="settings-toggle-sidebar" class="btn btn-sm btn-outline">Toggle Sidebar Collapsed</button>
            </label>
            <label style="display:flex;align-items:center;justify-content:space-between">
              <span>Keyboard navigation</span>
              <button id="settings-show-shortcuts" class="btn btn-sm btn-outline">Show Shortcut Sheet (?)</button>
            </label>
          </div>
        </div>

        <div class="col-6 card">
          <div class="card-header"><h3 class="card-title">Agent Automation (Opt-In)</h3></div>
          <p style="margin-bottom:12px;color:var(--text-muted)">Allow agentlens to dispatch fixes directly to local CLI agents (claude, codex, opencode).</p>
          <div id="settings-agent-automation-section">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" id="chk-allow-agent-launch" ${allowAgentLaunch ? 'checked' : ''} />
              <span style="font-weight:500">Allow agentlens to launch agents</span>
            </label>
            <p class="hint" style="margin-top:8px">When disabled, fix actions only offer "Copy Prompt". When enabled, fixes can be dispatched directly to your agent CLI.</p>
            <div id="settings-save-status" style="font-size:12px;color:var(--success);margin-top:6px;display:none">Settings saved successfully.</div>
          </div>
        </div>

        <div class="col-6 card" style="margin-top:var(--space-4)">
          <div class="card-header"><h3 class="card-title">Live Desktop Alerts</h3></div>
          <p style="margin-bottom:12px;color:var(--text-muted)">Raise native desktop notifications during background serve when critical waste or limits occur.</p>
          <div style="display:flex;flex-direction:column;gap:12px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" id="chk-alert-retry" ${settings.alert_retry_loop !== 'false' ? 'checked' : ''} />
              <span>Alert when a retry loop is detected in an active session</span>
            </label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" id="chk-alert-quota" ${settings.alert_quota_forecast !== 'false' ? 'checked' : ''} />
              <span>Alert when quota exhaustion is projected within 30 minutes</span>
            </label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" id="chk-alert-budget" ${settings.alert_budget !== 'false' ? 'checked' : ''} />
              <span>Alert when project token budget crosses 80% or 100%</span>
            </label>
          </div>
        </div>

        <div class="col-6 card" style="margin-top:var(--space-4)">
          <div class="card-header"><h3 class="card-title">Project Weekly Budgets</h3></div>
          <p style="margin-bottom:12px;color:var(--text-muted)">Configure weekly token limits to monitor consumption and trigger budget warnings.</p>
          ${projectsList.length === 0 ? '<p style="color:var(--text-muted);font-size:13px">No projects discovered yet.</p>' : `
            <div style="display:flex;flex-direction:column;gap:12px">
              ${projectsList.map((pr) => `
                <div style="padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface)">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                    <span style="font-weight:600;font-size:13px">${esc(pr.name)}</span>
                    <a href="#/project/${pr.projectId}" class="btn btn-sm btn-outline" style="font-size:11px;padding:2px 6px">View Project</a>
                  </div>
                  <div style="display:flex;gap:8px;align-items:center">
                    <input type="number" class="form-input setting-budget-tok" data-proj="${pr.projectId}" placeholder="Weekly Tokens" value="${pr.budgetTokens || ''}" style="width:140px;font-size:12px" step="1000" />
                    <input type="number" class="form-input setting-budget-cost" data-proj="${pr.projectId}" placeholder="Cost ($)" value="${pr.budgetCost || ''}" style="width:90px;font-size:12px" step="1" />
                    <button class="btn btn-sm btn-save-proj-budget" data-proj="${pr.projectId}">Save</button>
                    ${pr.budgetTokens ? `<button class="btn btn-sm btn-outline btn-clear-proj-budget" data-proj="${pr.projectId}" style="color:var(--danger)">Clear</button>` : ''}
                  </div>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      </div>
    `,
    after: () => {
      $('#settings-theme')?.addEventListener('change', (e) => {
        const val = e.target.value;
        document.documentElement.setAttribute('data-theme', val);
        localStorage.setItem('agentlens_theme', val);
        charts.forEach((c) => c.destroy());
        charts = [];
        render();
      });
      $('#settings-toggle-sidebar')?.addEventListener('click', toggleSidebar);
      $('#settings-show-shortcuts')?.addEventListener('click', openShortcutsModal);
      $('#chk-allow-agent-launch')?.addEventListener('change', async (e) => {
        const checked = e.target.checked;
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowAgentLaunch: checked }),
        });
        const statusEl = $('#settings-save-status');
        if (statusEl) {
          statusEl.style.display = 'block';
          setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
        }
      });
      const saveAlertSetting = async (key, checked) => {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value: String(checked) }),
        });
      };
      $('#chk-alert-retry')?.addEventListener('change', (e) => saveAlertSetting('alert_retry_loop', e.target.checked));
      $('#chk-alert-quota')?.addEventListener('change', (e) => saveAlertSetting('alert_quota_forecast', e.target.checked));
      $('#chk-alert-budget')?.addEventListener('change', (e) => saveAlertSetting('alert_budget', e.target.checked));

      document.querySelectorAll('.btn-save-proj-budget').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const projId = e.currentTarget.dataset.proj;
          const container = e.currentTarget.closest('div');
          const tokVal = Number(container.querySelector('.setting-budget-tok')?.value) || null;
          const costVal = Number(container.querySelector('.setting-budget-cost')?.value) || null;
          btn.disabled = true;
          await fetch('/api/project/budget', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: projId, budgetTokens: tokVal, budgetCost: costVal }),
          });
          btn.textContent = 'Saved!';
          setTimeout(() => render(), 400);
        });
      });
      document.querySelectorAll('.btn-clear-proj-budget').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const projId = e.currentTarget.dataset.proj;
          btn.disabled = true;
          await fetch('/api/project/budget', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: projId, budgetTokens: 0, budgetCost: 0 }),
          });
          render();
        });
      });
    },
  };
}

const routes = {
  overview,
  projects: projectsPage,
  project: projectPage,
  sessions: sessionsPage,
  session: sessionPage,
  quota: quotaPage,
  recommendations: recommendationsPage,
  audit: auditPage,
  reports: reportsPage,
  catalog: catalogPage,
  health: healthPage,
  settings: settingsPage,
};

async function render() {
  const [, name = 'overview', arg = ''] = location.hash.split('/');
  if (name === 'project' && arg) {
    state.project = arg;
    const fProj = $('#f-project');
    if (fProj) fProj.value = arg;
  }

  document.querySelectorAll('#sidebar a').forEach((a) => {
    if (a.getAttribute('href') === `#/${name}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  const main = $('#main');
  main.setAttribute('aria-busy', 'true');

  let skeletonTimer = setTimeout(() => {
    if (main.getAttribute('aria-busy') === 'true') {
      main.innerHTML = renderSkeleton();
    }
  }, 300);

  try {
    const { html, after } = await (routes[name] ?? overview)(arg);
    clearTimeout(skeletonTimer);
    charts.forEach((c) => c.destroy());
    charts = [];
    main.innerHTML = html;
    after?.();
  } catch (e) {
    clearTimeout(skeletonTimer);
    main.innerHTML = emptyState(`Couldn't load this page`, esc(e.message), '<a href="#/health" class="btn btn-sm">Check System Health</a>');
  }
  main.removeAttribute('aria-busy');
}

// Global filters
for (const [id, key] of [['f-range', 'range'], ['f-agent', 'agent'], ['f-project', 'project']]) {
  $(`#${id}`)?.addEventListener('change', (e) => {
    state[key] = key === 'range' ? Number(e.target.value) : e.target.value;
    render();
  });
}

// Table click / enter navigation
document.addEventListener('click', (e) => {
  const tr = e.target.closest?.('tr[data-href]');
  if (tr && !e.target.closest('button, a, input, select')) {
    location.hash = tr.dataset.href;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches?.('tr[data-href]')) {
    location.hash = e.target.dataset.href;
  }
});

// UI controls
$('#btn-sidebar-collapse')?.addEventListener('click', toggleSidebar);
$('#btn-theme-top')?.addEventListener('click', toggleTheme);
$('#btn-theme-sidebar')?.addEventListener('click', toggleTheme);
$('#btn-shortcuts-top')?.addEventListener('click', openShortcutsModal);
$('#btn-shortcuts-sidebar')?.addEventListener('click', openShortcutsModal);
$('#shortcuts-close')?.addEventListener('click', closeShortcutsModal);
$('#shortcuts-modal-backdrop')?.addEventListener('click', closeShortcutsModal);
$('#slide-over-close')?.addEventListener('click', closeSlideOver);
$('#slide-over-backdrop')?.addEventListener('click', closeSlideOver);

// Mobile drawer
$('#btn-mobile-toggle')?.addEventListener('click', () => {
  const sidebar = $('#sidebar');
  const backdrop = $('#mobile-sidebar-backdrop');
  if (sidebar && backdrop) {
    sidebar.classList.toggle('mobile-open');
    backdrop.classList.toggle('open');
  }
});
$('#mobile-sidebar-backdrop')?.addEventListener('click', () => {
  $('#sidebar')?.classList.remove('mobile-open');
  $('#mobile-sidebar-backdrop')?.classList.remove('open');
});

// Keyboard navigation
let pendingG = false;
let gTimer = null;

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }

  if (e.key === 'Escape') {
    closeSlideOver();
    closeShortcutsModal();
    $('#sidebar')?.classList.remove('mobile-open');
    $('#mobile-sidebar-backdrop')?.classList.remove('open');
    return;
  }

  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    e.preventDefault();
    openShortcutsModal();
    return;
  }

  if (e.key === '[') {
    e.preventDefault();
    toggleSidebar();
    return;
  }

  if (e.key === 't') {
    e.preventDefault();
    toggleTheme();
    return;
  }

  if (e.key === 'g') {
    pendingG = true;
    clearTimeout(gTimer);
    gTimer = setTimeout(() => { pendingG = false; }, 1000);
    return;
  }

  if (pendingG) {
    pendingG = false;
    clearTimeout(gTimer);
    const map = {
      o: '#/overview',
      p: '#/projects',
      s: '#/sessions',
      q: '#/quota',
      r: '#/recommendations',
      a: '#/audit',
      w: '#/reports',
      c: '#/catalog',
      h: '#/health',
      ',': '#/settings',
    };
    if (map[e.key]) {
      e.preventDefault();
      location.hash = map[e.key];
    }
  }
});

window.addEventListener('hashchange', () => {
  $('#sidebar')?.classList.remove('mobile-open');
  $('#mobile-sidebar-backdrop')?.classList.remove('open');
  render();
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 250);
});

setInterval(() => {
  if (!document.hidden) {
    render();
    updateQuotaPills();
  }
}, 60_000);

// Init theme & sidebar
const storedTheme = localStorage.getItem('agentlens_theme');
if (storedTheme === 'light' || storedTheme === 'dark') {
  document.documentElement.setAttribute('data-theme', storedTheme);
} else {
  document.documentElement.setAttribute('data-theme', 'dark');
}

if (localStorage.getItem('agentlens_sidebar_collapsed') === 'true') {
  $('#sidebar')?.classList.add('collapsed');
}

// Fetch project options
fetch('/api/projects').then((r) => r.json()).then((ps) => {
  const fProj = $('#f-project');
  if (fProj) {
    fProj.insertAdjacentHTML('beforeend', ps.map((p) => `<option value="${p.projectId}">${esc(p.name)}</option>`).join(''));
    if (state.project) fProj.value = state.project;
  }
}).catch(() => {});

updateQuotaPills();
render();
