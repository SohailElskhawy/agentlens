// agentlens dashboard — Vanilla JS, zero build step, Linear/Raycast precision UI.
import { esc, fmtTok, optimizeIgnoreFilesCardHtml, optimizeDrawerIgnoreFilesHtml, optimizeTrimLine, pendingIgFiles } from './optimize-view.js';
const $ = (sel) => document.querySelector(sel);
const fmtInt = (n) => (n ?? 0).toLocaleString();
const fmtUsd = (n) => `$${(n ?? 0).toFixed(2)}`;
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtShortTime = (ms) => (ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDelta = (n) => ((n ?? 0) > 0 ? `+${n}%` : `${n ?? 0}%`);

const AGENTS = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  gemini: 'Gemini CLI',
  aider: 'Aider',
  cursor: 'Cursor',
};

const COLORS = {
  claude: '#f97316',
  codex: '#3b82f6',
  opencode: '#10b981',
  antigravity: '#a855f7',
  gemini: '#60a5fa',
  aider: '#06b6d4',
  cursor: '#c084fc',
};

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const cost = (t) => (t.cost === 0 && t.unpricedTokens > 0 ? 'unpriced' : fmtUsd(t.cost) + (t.unpricedTokens > 0 ? '*' : ''));

const state = {
  range: 30,
  agent: '',
  project: '',
  recView: 'grouped', // 'grouped' | 'all'
  recRuleFilter: 'all',
  recSearch: '',
  recPage: 1,
  reportMode: 'native', // 'native' | 'markdown' | 'html'
};

let charts = [];
const inflight = new Map();

function showToast(message, type = 'success') {
  const container = $('#toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icon = type === 'error' ? '✕' : type === 'warn' ? '⚠' : '✓';
  el.innerHTML = `<span>${icon}</span><span>${esc(message)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    el.style.transition = 'opacity 150ms ease, transform 150ms ease';
    setTimeout(() => el.remove(), 160);
  }, 2600);
}

async function copyText(text, label = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(label, 'success');
    return true;
  } catch (err) {
    showToast(`Copy failed: ${err.message}`, 'error');
    return false;
  }
}

async function api(path, extra = {}) {
  const p = new URLSearchParams(extra);
  if (state.range) p.set('from', String(Date.now() - state.range * 864e5));
  if (state.agent) p.set('agent', state.agent);
  if (state.project && !extra.project) p.set('project', state.project);
  const url = `/api/${path}?${p}`;
  if (inflight.has(url)) return inflight.get(url);

  const req = (async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`/api/${path} returned ${r.status}`);
      return await r.json();
    } finally {
      inflight.delete(url);
    }
  })();

  inflight.set(url, req);
  return req;
}

function agentBadge(agentKey) {
  if (!agentKey || agentKey === 'all') {
    return `<span class="badge">All Agents</span>`;
  }
  const color = COLORS[agentKey] || 'var(--accent)';
  const label = AGENTS[agentKey] ?? agentKey;
  return `<span class="agent-badge"><span class="agent-dot" style="background:${color}"></span>${esc(label)}</span>`;
}

function agentListBadges(agentsCsv, maxVisible = 2) {
  const list = (agentsCsv ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return '<span style="color:var(--text-dim)">—</span>';
  const visible = list.slice(0, maxVisible);
  const extra = list.length - visible.length;
  const fullNames = list.map((a) => AGENTS[a] ?? a).join(', ');
  return `
    <div style="display:flex;gap:8px;align-items:center;white-space:nowrap" title="${esc(fullNames)}">
      ${visible.map((a) => agentBadge(a)).join('')}
      ${extra > 0 ? `<span class="badge" style="font-size:10px;padding:1px 5px">+${extra}</span>` : ''}
    </div>
  `;
}

function shortenPath(p) {
  if (!p) return '—';
  const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 3) return p;
  return `…/${parts.slice(-2).join('/')}`;
}

function tile(label, value, note = '', extraHtml = '') {
  return `
    <div class="tile">
      <div class="label">${esc(label)}</div>
      <div class="value">${esc(value)}</div>
      ${extraHtml}
      ${note ? `<div class="note">${esc(note)}</div>` : ''}
    </div>
  `;
}

function emptyState(title, desc = '', actionHtml = '') {
  return `
    <div class="empty-state">
      <div class="empty-state-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>
      </div>
      <div class="empty-state-title">${esc(title)}</div>
      ${desc ? `<div class="empty-state-desc">${esc(desc)}</div>` : ''}
      ${actionHtml ? `<div class="empty-state-actions">${actionHtml}</div>` : ''}
    </div>
  `;
}

function table(cols, rows, href) {
  if (!rows || !rows.length) {
    return emptyState('No records in this view', 'Try widening the date range above or clearing active filters.');
  }
  const head = cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('');
  const body = rows.map((r) => `<tr${href ? ` data-href="${esc(href(r))}" tabindex="0"` : ''}>${
    cols.map((c) => {
      const classes = [c.num ? 'num' : '', c.cls || ''].filter(Boolean).join(' ');
      const titleAttr = c.title ? ` title="${esc(c.title(r))}"` : '';
      const val = c.html ? c.get(r) : esc(c.get(r));
      return `<td${classes ? ` class="${classes}"` : ''}${titleAttr}>${val}</td>`;
    }).join('')}</tr>`).join('');
  return `<div class="table-card-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderDiff(diffText) {
  if (!diffText) return '';
  return diffText
    .split('\n')
    .map((line) => {
      let cls = '';
      if (line.startsWith('+') && !line.startsWith('+++')) cls = 'diff-line-add';
      else if (line.startsWith('-') && !line.startsWith('---')) cls = 'diff-line-del';
      else if (line.startsWith('@@')) cls = 'diff-line-hunk';
      return `<div class="${cls}">${esc(line)}</div>`;
    })
    .join('');
}

function hexToRgba(hex, alpha) {
  if (!hex || !hex.startsWith('#') || hex.length !== 7) return `rgba(99, 102, 241, ${alpha})`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function chart(id, x, series, { time = true, fmt = fmtTok, height = 235 } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
    (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const textColor = css('--text-muted') || (isDark ? '#8a93a6' : '#64748b');
  const gridColor = css('--grid') || (isDark ? 'rgba(255,255,255,0.05)' : 'rgba(15,23,42,0.06)');
  const axis = {
    stroke: textColor,
    grid: { stroke: gridColor, width: 1 },
    ticks: { stroke: gridColor, width: 1 },
    font: '11px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  };
  const u = new uPlot({
    width: Math.max(el.clientWidth - 8, 300),
    height,
    scales: { x: { time } },
    cursor: {
      points: { size: 7, width: 2 },
    },
    series: [
      {},
      ...series.map((s) => ({
        label: s.label,
        stroke: s.color,
        fill: s.dash ? undefined : hexToRgba(s.color, isDark ? 0.12 : 0.08),
        dash: s.dash,
        width: 2,
        points: { show: x.length <= 14, size: 5 },
        spanGaps: true,
        value: (uPlotInstance, v) => (v == null ? '—' : fmt(v)),
      })),
    ],
    axes: [axis, { ...axis, size: 58, values: (uPlotInstance, vals) => vals.map(fmt) }],
  }, [x, ...series.map((s) => s.data)], el);
  charts.push(u);
}

const agentCol = { label: 'Agent', html: true, get: (r) => agentBadge(r.agent) };
const tokCols = [
  { label: 'Tokens', num: true, get: (r) => fmtTok(r.tokens) },
  { label: 'Cache Read', num: true, get: (r) => fmtTok(r.cacheRead) },
  { label: 'Est. Cost', num: true, get: cost },
];

const projectCols = [
  {
    label: 'Project',
    html: true,
    get: (r) => `<strong style="color:var(--text)">${esc(r.name)}</strong>`,
  },
  {
    label: 'Agents',
    html: true,
    get: (r) => agentListBadges(r.agents),
  },
  { label: 'Sessions', num: true, get: (r) => r.sessions },
  ...tokCols,
  {
    label: 'Weekly Budget',
    html: true,
    get: (r) => {
      if (!r.budgetTokens) return '<span style="color:var(--text-dim);font-size:11.5px">No cap</span>';
      const pct = r.budgetPct ?? Math.round((r.tokens / r.budgetTokens) * 100);
      const color = pct >= 100 ? 'var(--danger)' : pct >= 80 ? 'var(--warn)' : 'var(--success)';
      const clamped = Math.min(pct, 100);
      return `
        <div style="min-width:115px">
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px">
            <span style="font-weight:600;color:${color}">${pct}%</span>
            <span style="color:var(--text-muted)">${fmtTok(r.tokens)} / ${fmtTok(r.budgetTokens)}</span>
          </div>
          <div class="quota-meter-track">
            <div class="quota-meter-fill" style="width:${clamped}%;background:${color}"></div>
          </div>
        </div>
      `;
    },
  },
  { label: 'Last Active', get: (r) => fmtShortTime(r.lastActive) },
];

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

// Unified Rate-Limit & Quota Summary Card for Overview (replaces the 4 separate n/a tiles)
function quotaSummaryCard(latest = []) {
  const now = Date.now();
  const active = latest.filter((l) => l.resetsAt > now && (!state.agent || state.agent === l.agent));

  if (!active.length) {
    return `
      <div class="tile">
        <div class="label">
          <span>Rate-Limit Quotas</span>
          <a href="#/quota" style="color:var(--accent-hover);text-decoration:none;font-size:10.5px">Details &rarr;</a>
        </div>
        <div class="value" style="font-size:20px;color:var(--text-muted);margin-top:4px">No active windows</div>
        <div class="note">Quota telemetry updates automatically as Claude Code or Codex report sliding windows.</div>
      </div>
    `;
  }

  const rowsHtml = active.slice(0, 3).map((q) => {
    const pct = Math.round(q.usedPct);
    const color = pct >= 85 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : 'var(--success)';
    const rem = fmtCountdown(q.resetsAt - now);
    return `
      <div class="quota-meter-row">
        <div class="quota-meter-meta">
          <span style="font-weight:600;color:var(--text-main)">${esc(AGENTS[q.agent] || q.agent)} ${esc(q.win)}</span>
          <span><strong style="color:${color}">${pct}%</strong> <span style="color:var(--text-dim)">(${rem})</span></span>
        </div>
        <div class="quota-meter-track">
          <div class="quota-meter-fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="tile">
      <div class="label">
        <span>Active Quota Windows</span>
        <a href="#/quota" style="color:var(--accent-hover);text-decoration:none;font-size:10.5px">View all &rarr;</a>
      </div>
      <div class="quota-meter-list">
        ${rowsHtml}
      </div>
    </div>
  `;
}

// Detailed 4-card grid for the dedicated Quota page
function quotaDetailTiles(latest = []) {
  const now = Date.now();
  return ['claude', 'codex'].flatMap((agent) => ['5h', '7d'].map((win) => {
    const q = latest.find((l) => l.agent === agent && l.win === win);
    const name = `${AGENTS[agent]} · ${win} window`;
    if (state.agent && state.agent !== agent) {
      return tile(name, 'Filtered', `Hidden by active Agent filter`);
    }
    if (!q || q.resetsAt < now) {
      return tile(name, 'Idle', q ? 'Window reset since last activity' : 'No telemetry reported yet');
    }
    const pct = Math.round(q.usedPct);
    const color = pct >= 85 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : 'var(--success)';
    const bar = `
      <div class="quota-meter-track" style="margin:6px 0 2px">
        <div class="quota-meter-fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div>
      </div>
    `;
    return tile(name, `${pct}%`, `Resets in ${fmtCountdown(q.resetsAt - now)} (${fmtShortTime(q.resetsAt)})`, bar);
  })).join('');
}

async function updateQuotaPills() {
  try {
    const q = await api('quota');
    const container = $('#quota-pills');
    if (!container || !q || !q.latest) return;
    const now = Date.now();
    const fcMap = new Map();
    if (Array.isArray(q.forecasts)) {
      for (const fc of q.forecasts) {
        if (fc.willExhaustBeforeReset && fc.message) {
          fcMap.set(`${fc.agent}|${fc.window}`, fc);
        }
      }
    }
    const pills = q.latest
      .filter((l) => (l.agent === 'claude' || l.agent === 'codex') && l.resetsAt > now)
      .map((l) => {
        const remaining = fmtCountdown(l.resetsAt - now);
        const fc = fcMap.get(`${l.agent}|${l.win}`);
        const pct = Math.round(l.usedPct);
        const isWarn = pct >= 85 || Boolean(fc);
        const color = pct >= 85 ? 'var(--danger)' : isWarn || pct >= 70 ? 'var(--warn)' : 'var(--success)';
        const pillStyle = isWarn ? 'border-color:var(--warn-border);background:var(--warn-bg)' : '';
        const fcHint = fc ? ` · ${fc.message}` : '';
        return `
          <a class="quota-pill" href="#/quota" style="${pillStyle}" title="${esc(AGENTS[l.agent] || l.agent)} ${esc(l.win)}: ${pct}% used (resets in ${remaining})${esc(fcHint)}">
            <span class="quota-pill-dot" style="background:${color}"></span>
            <span>${esc(AGENTS[l.agent] || l.agent)} ${esc(l.win)}: <strong>${pct}%</strong></span>
            <span class="quota-pill-countdown">${remaining}${fc ? ' ⚠' : ''}</span>
          </a>
        `;
      }).join('');
    container.innerHTML = pills;
  } catch {}
}

async function updateNavBadges() {
  try {
    const [recData, auditData] = await Promise.all([
      api('recommendations').catch(() => null),
      api('audit').catch(() => null),
    ]);
    const recBadge = $('#nav-badge-recs');
    if (recBadge && recData?.recommendations) {
      const openRecs = recData.recommendations.filter((r) => r.status === 'open');
      const uniqueRules = new Set(openRecs.map((r) => `${r.findingRule}:${r.action}`)).size;
      if (uniqueRules > 0) {
        recBadge.textContent = String(uniqueRules);
        recBadge.hidden = false;
      } else {
        recBadge.hidden = true;
      }
    }
    const auditBadge = $('#nav-badge-audit');
    if (auditBadge && auditData?.summary) {
      const count = (auditData.summary.unusedCount || 0) + (auditData.summary.duplicateCount || 0) + (auditData.summary.conflictCount || 0);
      if (count > 0) {
        auditBadge.textContent = String(count);
        auditBadge.hidden = false;
      } else {
        auditBadge.hidden = true;
      }
    }
  } catch {}
}

let slideOverReturnFocus = null;
const anomalyKey = a => `${a.day}|${a.projectId}|${a.agent}`;
const pendingAnomalies = new Set();
const anomalyButton = key => [...document.querySelectorAll('.anomaly-explain')].find(b => b.dataset.anomalyKey === key);

function openSlideOver(title, content) {
  const el = $('#slide-over');
  const backdrop = $('#slide-over-backdrop');
  const titleEl = $('#slide-over-title');
  const bodyEl = $('#slide-over-body');
  if (!el || !backdrop) return;
  titleEl.textContent = title;
  if (typeof content === 'string') bodyEl.innerHTML = content;
  else bodyEl.replaceChildren(content); // DOM nodes keep model-generated text out of innerHTML
  if (!el.classList.contains('open')) slideOverReturnFocus = document.activeElement; // keep the original opener across panel swaps
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
  if (slideOverReturnFocus?.isConnected) slideOverReturnFocus.focus();
  else if (slideOverReturnFocus?.id === 'btn-explain-ai') $('#btn-explain-ai')?.focus();
  else if (slideOverReturnFocus?.dataset?.anomalyKey) anomalyButton(slideOverReturnFocus.dataset.anomalyKey)?.focus(); // rerender replaced the opener; find it by stable identity
  slideOverReturnFocus = null;
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
    <div class="kpi-grid">
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

// ============================================================================
// PAGES
// ============================================================================

async function overview() {
  const [s, daily, models, projects, quota, findingsRes, healthRes, anomalies, aiState] = await Promise.all([
    api('summary'),
    api('daily'),
    api('models'),
    api('projects'),
    api('quota'),
    api('findings').catch(() => ({ findings: [] })),
    api('health').catch(() => null),
    fetch(`/api/anomalies?${new URLSearchParams({ ...(state.agent ? { agent: state.agent } : {}), ...(state.project ? { project: state.project } : {}) })}`).then(r => r.json()).catch(() => ({ anomalies: [] })),
    api('ai/status').catch(() => null),
  ]);
  const t = s.totals;
  const days = [...new Set(daily.map((d) => d.day))];
  const agents = [...new Set(daily.map((d) => d.agent))];

  const findings = findingsRes?.findings || [];
  const balanceFinding = findings.find((f) => f.rule === 'cross_agent_balance');
  const totalSavings = findingsRes?.totalEstWeeklySavings || 0;

  const totalTok = Math.max(t.tokens || 1, 1);
  const cachePct = Math.round(((t.cacheRead || 0) / totalTok) * 100);
  const inputPct = Math.max(1, Math.round(((t.input || 0) / totalTok) * 100));
  const outputPct = Math.max(1, Math.round(((t.output || 0) / totalTok) * 100));

  const tokSplitBar = t.tokens > 0 ? `
    <div class="split-bar" title="Cache Read: ${fmtTok(t.cacheRead)} · Input: ${fmtTok(t.input)} · Output: ${fmtTok(t.output)}">
      <div class="split-segment" style="width:${cachePct}%;background:var(--success)"></div>
      <div class="split-segment" style="width:${inputPct}%;background:var(--accent)"></div>
      <div class="split-segment" style="width:${outputPct}%;background:var(--warn)"></div>
    </div>
  ` : '';

  const hasAntigravityTokens = s.byAgent?.some((a) => a.agent === 'antigravity' && a.tokens > 0) || healthRes?.events?.some((e) => e.agent === 'antigravity' && e.events > 0);
  const antigravityNotice = (!hasAntigravityTokens && healthRes?.ccusageAvailable === false && (s.byAgent?.some((a) => a.agent === 'antigravity') || healthRes?.sources?.some((src) => src.agent === 'antigravity'))) ? `
    <div class="banner-card banner-warn">
      <div style="display:flex;align-items:center;gap:12px">
        <span style="font-size:18px">⚠️</span>
        <div>
          <strong style="color:var(--warn);font-size:13px">Antigravity Token Ingestion Notice</strong>
          <p style="margin:2px 0 0;font-size:12.5px;color:var(--text-main)">
            The <code>ccusage</code> CLI was not detected in <code>PATH</code>. Run <code>npm i -g ccusage</code> to enable Antigravity token telemetry.
          </p>
        </div>
      </div>
      <a href="#/health" class="btn btn-sm btn-outline">System Health &rarr;</a>
    </div>
  ` : '';

  const balanceCard = balanceFinding ? `
    <div class="banner-card banner-accent">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:32px;height:32px;border-radius:var(--radius-sm);background:var(--accent-subtle);display:flex;align-items:center;justify-content:center;color:var(--accent-hover);flex-shrink:0">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
        </div>
        <div>
          <div style="display:flex;align-items:center;gap:8px">
            <strong style="font-size:13px;color:var(--text)">Cross-Agent Workload Balancing</strong>
            <span class="pill pill-open">Recommendation</span>
          </div>
          <p style="margin:2px 0 0;font-size:12.5px;color:var(--text-main)">
            ${esc(balanceFinding.evidence?.suggestion || balanceFinding.confidenceReason)}
          </p>
        </div>
      </div>
      <a href="#/recommendations" class="btn btn-sm btn-outline">Optimize &rarr;</a>
    </div>
  ` : '';

  return {
    html: `
      <div class="page-header">
        <div>
          <h1 class="page-title">Overview</h1>
          <p class="page-subtitle">Real-time token telemetry, cache efficiency, and rate-limit burn across coding agents.</p>
        </div>
        ${totalSavings > 0 ? `
          <div class="page-actions">
            <a href="#/recommendations" class="btn btn-sm btn-outline" style="border-color:var(--success-border);color:var(--success)">
              ⚡ Save ~${fmtTok(totalSavings)} tokens/wk &rarr;
            </a>
          </div>
        ` : ''}
      </div>

      <section class="kpi-grid">
        ${tile(
          'Measured Tokens',
          fmtTok(t.tokens),
          `${fmtTok(t.input)} in · ${fmtTok(t.output)} out · ${fmtTok(t.cacheRead)} cache`,
          tokSplitBar,
        )}
        ${tile(
          'API-Equivalent Cost',
          cost(t),
          t.unpricedTokens
            ? `${fmtTok(t.unpricedTokens)} unpriced tokens excluded`
            : `List rates as of ${s.pricesAsOf} (subscription-neutral)`,
        )}
        ${tile(
          'Sessions & Cache Ratio',
          fmtInt(s.sessions),
          t.tokens ? `${cachePct}% of total volume served from prompt cache` : 'No sessions recorded in range',
        )}
        ${quotaSummaryCard(quota.latest)}
      </section>

      ${antigravityNotice}
      ${balanceCard}
      <section class="card">
        <div class="card-header"><div><h3 class="card-title">Today's token spikes</h3><span class="card-subtitle">Compared with the median of recent active days</span></div></div>
        ${(anomalies.anomalies || []).length ? anomalies.anomalies.map((a, i) => `
          <div class="anomaly-row"><div><strong>${esc(a.project || 'Unknown project')}</strong> · ${esc(AGENTS[a.agent] || a.agent)}<br><span class="card-subtitle">${fmtTok(a.tokens)} tokens · ${a.ratio}× baseline</span></div>
          ${aiState?.enabled ? `<button type="button" class="btn btn-sm btn-outline anomaly-explain" data-index="${i}" data-anomaly-key="${esc(anomalyKey(a))}"${pendingAnomalies.has(anomalyKey(a)) ? ' disabled' : ''}>${pendingAnomalies.has(anomalyKey(a)) ? 'Preparing…' : 'Explain with AI'}</button>` : ''}</div>
        `).join('') : '<p class="card-subtitle">No spikes detected today.</p>'}
        <p id="anomaly-ai-error" class="ai-note" role="status"></p>
      </section>

      <div class="grid-12">
        <div class="col-7 card chart-container">
          <div class="chart-header">
            <div>
              <h3 class="chart-title">Daily Token Volume</h3>
              <span class="card-subtitle">Measured token consumption by agent over time</span>
            </div>
          </div>
          <div id="c-daily" class="chart-body"></div>
        </div>

        <div class="col-5 card">
          <div class="card-header">
            <div>
              <h3 class="card-title">By Agent</h3>
              <span class="card-subtitle">${s.byAgent.length} active agent${s.byAgent.length === 1 ? '' : 's'}</span>
            </div>
          </div>
          ${table([agentCol, ...tokCols], s.byAgent)}
        </div>
      </div>

      <div class="grid-12">
        <div class="col-6 card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Top Projects</h3>
              <span class="card-subtitle">Click a project to inspect Fix Now actions & budgets</span>
            </div>
            <a href="#/projects" class="btn btn-xs btn-outline">All projects (${projects.length}) &rarr;</a>
          </div>
          ${table([
            projectCols[0],
            projectCols[1],
            { label: 'Sessions', num: true, get: (r) => r.sessions },
            { label: 'Tokens', num: true, get: (r) => fmtTok(r.tokens) },
            { label: 'Est. Cost', num: true, get: cost },
          ], projects.slice(0, 8), (r) => `#/project/${r.projectId}`)}
        </div>

        <div class="col-6 card">
          <div class="card-header">
            <div>
              <h3 class="card-title">By Model</h3>
              <span class="card-subtitle">${models.length} model${models.length === 1 ? '' : 's'} observed</span>
            </div>
          </div>
          ${table([
            {
              label: 'Model',
              html: true,
              title: (r) => r.name ?? 'unknown',
              get: (r) => `<div class="cell-truncate cell-mono" style="max-width:145px">${esc(r.name ?? 'unknown')}</div>`,
            },
            agentCol,
            { label: 'Tokens', num: true, get: (r) => fmtTok(r.tokens) },
            { label: 'Cache', num: true, get: (r) => fmtTok(r.cacheRead) },
            { label: 'Est. Cost', num: true, get: cost },
          ], models)}
        </div>
      </div>
    `,
    after: () => {
      document.querySelectorAll('.anomaly-explain').forEach(btn => {
        const a = anomalies.anomalies[Number(btn.dataset.index)];
        wireAnomalyExplain(btn, a);
      });
      if (days.length) {
        chart(
          'c-daily',
          days.map((d) => Date.parse(`${d}T00:00:00`) / 1000),
          agents.map((a) => ({
            label: AGENTS[a] ?? a,
            color: COLORS[a] || '#6366f1',
            data: days.map((d) => daily.find((x) => x.day === d && x.agent === a)?.tokens ?? 0),
          })),
        );
      }
    },
  };
}

async function projectsPage() {
  const rows = await api('projects');
  return {
    html: `
      <div class="page-header">
        <div>
          <h1 class="page-title">Projects</h1>
          <p class="page-subtitle">Grouped by git repository (worktrees roll up to their main repo). Select a row for Fix Now optimizations.</p>
        </div>
        <div class="page-actions">
          <a href="/api/export.csv?type=sessions" download="agentlens-sessions.csv" class="btn btn-sm btn-outline">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export CSV
          </a>
        </div>
      </div>
      <div class="card">
        ${table([
          ...projectCols,
          {
            label: 'Workspace Path',
            cls: 'cell-path',
            title: (r) => r.root,
            get: (r) => shortenPath(r.root),
          },
        ], rows, (r) => `#/project/${r.projectId}`)}
      </div>
    `,
  };
}

async function projectPage(projectId) {
  const [projects, recData, findData, auditData, sessions, settingsRes, outcomesRes, optPreview] = await Promise.all([
    api('projects'),
    api('recommendations', { project: projectId }),
    api('findings', { project: projectId }),
    api('audit', { project: projectId }),
    api('sessions', { project: projectId, limit: '25' }),
    fetch('/api/settings').then((r) => r.json()).catch(() => ({ settings: {} })),
    api('outcomes', { project: projectId }).catch(() => []),
    api('optimize', { project: projectId }).catch(() => null),
  ]);

  const p = projects.find((x) => String(x.projectId) === String(projectId));
  if (!p) return { html: emptyState('Project not found', 'Project is not recognized or has no recorded sessions.', '<a href="#/projects" class="btn btn-sm">Back to Projects</a>') };

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
    });
  }

  for (const item of auditItems) {
    if (item.status === 'unused' || item.status === 'duplicate' || item.status === 'conflict') {
      const estSavings = (item.tokens || 100) * 10;
      fixItems.push({
        type: 'audit',
        id: item.id,
        title: `Resolve ${item.status} ${item.kind} '${item.name}'`,
        evidence: `${shortenPath(item.sourcePath)} (${item.status})`,
        agent: item.agent === 'all' ? (p.agents ? p.agents.split(',')[0] : 'claude') : item.agent,
        rule: `unused_${item.kind}`,
        estSavings,
        status: 'open',
      });
    }
  }

  fixItems.sort((a, b) => (b.estSavings || 0) - (a.estSavings || 0));

  const fixNowRows = fixItems.length === 0
    ? `<div style="padding:20px;text-align:center;color:var(--text-muted)">✨ All clear! No open recommendations or configuration issues detected for this project.</div>`
    : `
      <div class="table-card-scroll">
        <table>
          <thead>
            <tr>
              <th>Action</th>
              <th>Diagnostic Evidence</th>
              <th class="num">Est. Savings</th>
              <th>Agent</th>
              <th>Status</th>
              <th style="text-align:right">Execute</th>
            </tr>
          </thead>
          <tbody>
            ${fixItems.map((item) => `
              <tr data-fix-id="${esc(item.id)}" data-rule="${esc(item.rule)}" data-agent="${esc(item.agent)}">
                <td style="font-weight:600;color:var(--text)">${esc(item.title)}</td>
                <td class="cell-truncate" title="${esc(item.evidence)}" style="color:var(--text-muted);max-width:300px">${esc(item.evidence)}</td>
                <td class="num" style="font-weight:600;color:var(--success)">+${fmtTok(item.estSavings)}/wk</td>
                <td>${agentBadge(item.agent)}</td>
                <td><span class="pill pill-${esc(item.status)} status-pill">${esc(item.status)}</span></td>
                <td style="text-align:right">
                  <div style="display:inline-flex;gap:6px">
                    <button class="btn btn-xs btn-outline btn-copy-fix" data-id="${esc(item.id)}" data-rule="${esc(item.rule)}" data-agent="${esc(item.agent)}">Copy Prompt</button>
                    <button class="btn btn-xs btn-send-agent ${allowAgentLaunch ? '' : 'btn-outline'}" data-id="${esc(item.id)}" data-rule="${esc(item.rule)}" data-agent="${esc(item.agent)}" ${allowAgentLaunch ? '' : 'data-disabled-reason="launch_disabled"'}>
                      ${allowAgentLaunch ? 'Send to Agent' : 'Send (Opt-in)'}
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
      <div class="page-header">
        <div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <h1 class="page-title">${esc(p.name)}</h1>
            ${agentListBadges(p.agents)}
          </div>
          <p class="page-subtitle cell-mono" style="margin-top:4px">${esc(p.root)}</p>
        </div>
        <div class="page-actions">
          <button id="btn-toggle-optimize-panel" class="btn btn-sm">⚡ Optimize Workspace</button>
          <button id="btn-toggle-budget-form" class="btn btn-sm btn-outline">${p.budgetTokens ? 'Edit Weekly Budget' : 'Set Weekly Budget'}</button>
          <a href="#/projects" class="btn btn-sm btn-outline">&larr; All Projects</a>
        </div>
      </div>

      <!-- KPIs -->
      <section class="kpi-grid">
        ${tile('Measured Tokens', fmtTok(p.tokens), `${fmtTok(p.cacheRead)} served from cache`)}
        ${tile('API-Equivalent Cost', cost(p), 'Estimated list-price value')}
        ${tile('Recorded Sessions', fmtInt(p.sessions), `Last active ${fmtShortTime(p.lastActive)}`)}
        ${p.budgetTokens ? tile(
          'Weekly Token Budget',
          `${p.budgetPct}%`,
          `${fmtTok(p.tokens)} of ${fmtTok(p.budgetTokens)} cap`,
          `<div class="quota-meter-track" style="margin:4px 0 2px"><div class="quota-meter-fill" style="width:${Math.min(p.budgetPct, 100)}%;background:${p.budgetPct >= 100 ? 'var(--danger)' : p.budgetPct >= 80 ? 'var(--warn)' : 'var(--success)'}"></div></div>`,
        ) : tile('Weekly Token Budget', 'Uncapped', 'Click "Set Weekly Budget" above to track limits')}
      </section>

      <!-- Budget Configuration Form (Expandable) -->
      <form id="form-project-budget" class="card" style="display:none;margin-bottom:var(--space-4);border-color:var(--accent-border)">
        <div class="card-header">
          <div>
            <h3 class="card-title">Configure Weekly Project Budget</h3>
            <span class="card-subtitle">Trigger desktop notifications when 7-day rolling consumption crosses 80% or 100%.</span>
          </div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted)">
            <span>Weekly Token Cap (e.g. 5000000)</span>
            <input type="number" id="input-budget-tokens" class="form-input" style="width:200px" value="${p.budgetTokens || ''}" placeholder="Tokens limit" min="0" step="1000" />
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted)">
            <span>Weekly Cost Cap ($ USD, optional)</span>
            <input type="number" id="input-budget-cost" class="form-input" style="width:180px" value="${p.budgetCost || ''}" placeholder="Cost limit ($)" min="0" step="1" />
          </label>
          <button type="submit" class="btn btn-sm">Save Budget</button>
          ${p.budgetTokens ? `<button type="button" id="btn-clear-budget" class="btn btn-sm btn-outline" style="color:var(--danger)">Remove Cap</button>` : ''}
        </div>
      </form>

      <!-- Workspace Hygiene & Pre-Session Optimizer -->
      ${optPreview ? (() => {
        const claudeIg = optPreview.ignoreFiles?.find((x) => x.fileName === '.claudeignore');
        const cursorIg = optPreview.ignoreFiles?.find((x) => x.fileName === '.cursorignore');
        const missingIgCount = (claudeIg?.addedPatterns?.length || 0) + (cursorIg?.addedPatterns?.length || 0);
        const trimCount = optPreview.instructionTrims?.length || 0;
        const oversizedCount = optPreview.oversizedFiles?.length || 0;
        const unusedCount = optPreview.unusedItems?.length || 0;
        const hasActionableWrites = missingIgCount > 0 || trimCount > 0;
        return `
          <div id="panel-optimize-workspace" class="card" style="margin-bottom:var(--space-4);border-color:rgba(16,185,129,0.28);background:linear-gradient(180deg, rgba(16,185,129,0.05) 0%, var(--bg-card) 100%)">
            <div class="card-header">
              <div>
                <h3 class="card-title" style="color:var(--success)">
                  ⚡ Pre-Session Workspace Hygiene (${hasActionableWrites ? `~${fmtTok(optPreview.estimatedTokensSavedPerTurn)} tok/turn est. reduction` : 'Optimized'})
                </h3>
                <span class="card-subtitle">Adds <code class="cell-mono">.claudeignore</code> / <code class="cell-mono">.cursorignore</code> patterns and trims redundant instruction lines with <code class="cell-mono">.bak</code> backups. Ignore files are provider-specific &mdash; <code class="cell-mono">.claudeignore</code> has no effect in Claude Code.</span>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button type="button" id="btn-copy-optimize-cli" class="btn btn-xs btn-outline" data-cmd="agentlens optimize --project &quot;${esc(p.root)}&quot; --apply">Copy CLI Command</button>
                ${hasActionableWrites ? `<button type="button" id="btn-apply-optimize" class="btn btn-xs">Apply Hygiene Now</button>` : `<span class="pill pill-verified">✓ Clean</span>`}
              </div>
            </div>
            <div class="grid-12" style="margin-bottom:0;gap:12px">
              <div class="col-4" style="background:var(--bg-elevated);padding:12px;border-radius:var(--radius-sm);border:1px solid var(--border)">
                <div style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">Ignore Files (.claudeignore / .cursorignore)</div>
                ${optimizeIgnoreFilesCardHtml(optPreview.ignoreFiles)}
              </div>
              <div class="col-4" style="background:var(--bg-elevated);padding:12px;border-radius:var(--radius-sm);border:1px solid var(--border)">
                <div style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">Oversized Files & Instruction Trims</div>
                ${oversizedCount > 0 ? `
                  <div style="font-size:12px;color:var(--warn);margin-bottom:6px">
                    Flagging <strong>${oversizedCount}</strong> large root file(s) (context exposure, not savings): ${optPreview.oversizedFiles.map((f) => `<code class="cell-mono">${esc(f.relativePath)}</code> (${fmtTok(f.estTokens)} tok)`).join(', ')}
                  </div>
                ` : ''}
                ${trimCount > 0 ? `
                  <div style="font-size:12px;color:var(--text)">
                    <strong>${trimCount}</strong> instruction file(s) can be trimmed (${optimizeTrimLine(optPreview.instructionTrims)}).
                  </div>
                ` : `<div style="font-size:12.5px;color:var(--success)">✓ No redundant cuts needed in CLAUDE.md / AGENTS.md.</div>`}
              </div>
              <div class="col-4" style="background:var(--bg-elevated);padding:12px;border-radius:var(--radius-sm);border:1px solid var(--border)">
                <div style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">Unused MCPs & Stale Schemas (30d)</div>
                ${unusedCount > 0 ? `
                  <div style="font-size:12.5px;color:var(--text);margin-bottom:4px"><strong>${unusedCount}</strong> unused MCP/skill item(s) loaded every turn:</div>
                  <div style="font-size:11.5px;color:var(--text-muted)">
                    ${optPreview.unusedItems.slice(0, 4).map((u) => `<code class="cell-mono">${esc(u.name)}</code>`).join(', ')}${unusedCount > 4 ? ` +${unusedCount - 4} more` : ''}
                  </div>
                ` : `<div style="font-size:12.5px;color:var(--success)">✓ Zero unused MCPs detected.</div>`}
              </div>
            </div>
          </div>
        `;
      })() : ''}

      <!-- Fix Now Panel -->
      <div class="card" style="margin-bottom:var(--space-4);border-color:var(--accent-border)">
        <div class="card-header">
          <div>
            <h3 class="card-title" style="color:var(--accent-hover)">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              Fix Now (${fixItems.length})
            </h3>
            <span class="card-subtitle">Prioritized workflow and config actions ranked by weekly token savings.</span>
          </div>
          ${!allowAgentLaunch ? `<a href="#/settings" class="pill pill-duplicate" style="text-decoration:none">CLI Dispatch Opt-In in Settings</a>` : ''}
        </div>
        ${fixNowRows}
      </div>

      <!-- Git Outcome Efficiency -->
      ${outcome ? `
        <div class="card" style="margin-bottom:var(--space-4)">
          <div class="card-header">
            <div>
              <h3 class="card-title">Git Outcome Efficiency</h3>
              <span class="card-subtitle">Tokens expended per git commit and changed line in this repository</span>
            </div>
            <span class="badge">${outcome.commits} commits · ${fmtTok(outcome.linesChanged)} lines changed</span>
          </div>
          <div class="grid-12" style="margin-bottom:0">
            <div class="col-6">
              ${outcome.byAgent && outcome.byAgent.length > 0 ? table([
                agentCol,
                { label: 'Tokens', num: true, get: (ag) => fmtTok(ag.tokens) },
                { label: 'Commits', num: true, get: (ag) => ag.commits },
                { label: 'Tok / Commit', num: true, get: (ag) => fmtTok(ag.tokensPerCommit) },
                { label: 'Tok / Line', num: true, get: (ag) => fmtTok(ag.tokensPerChangedLine) },
              ], outcome.byAgent) : ''}
            </div>
            <div class="col-6">
              ${outcome.trend && outcome.trend.length > 1 ? `
                <div id="c-outcome-trend" style="height:170px"></div>
              ` : `<div style="padding:24px;color:var(--text-muted);font-size:12.5px">Overall: <strong>${fmtTok(outcome.tokensPerCommit)}</strong> tokens/commit · <strong>${fmtTok(outcome.tokensPerChangedLine)}</strong> tokens/line changed.</div>`}
            </div>
          </div>
        </div>
      ` : ''}

      <!-- Recent Sessions -->
      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Recent Project Sessions</h3>
            <span class="card-subtitle">Click a session to inspect turn-by-turn token growth and detector markers</span>
          </div>
        </div>
        ${table([
          { label: 'Last Activity', get: (r) => fmtShortTime(r.ended) },
          agentCol,
          { label: 'Turns', num: true, get: (r) => r.turns },
          { label: 'Tool Calls', num: true, get: (r) => r.toolCalls },
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
              body: JSON.stringify({ rule, agent, projectId, projectName: p.name, projectRoot: p.root }),
            }).then((r) => r.json());

            await copyText(promptRes.prompt, 'Fix prompt copied to clipboard');

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
            showToast(`Failed to generate prompt: ${err.message}`, 'error');
            btn.disabled = false;
          }
        });
      });

      document.querySelectorAll('.btn-send-agent').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          if (btn.dataset.disabledReason === 'launch_disabled') {
            showToast('Enable "Allow agentlens to launch agents" in Settings first.', 'warn');
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
            body: JSON.stringify({ rule, agent, projectId, projectName: p.name, projectRoot: p.root }),
          }).then((r) => r.json());

          const prompt = promptRes.prompt;
          const defaultCli = agent === 'claude' ? 'claude' : agent === 'codex' ? 'codex' : 'opencode run';
          if (!confirm(`Dispatch Fix to ${AGENTS[agent] || agent}?\n\nCommand: ${defaultCli} "${prompt.slice(0, 80)}..."\nWorkspace: ${p.root}`)) return;

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
              showToast(`Launch failed: ${data.error || runRes.statusText}`, 'error');
            } else {
              showToast(`Dispatched fix to ${AGENTS[agent] || agent}`, 'success');
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
            showToast(`Error running fix: ${err.message}`, 'error');
          } finally {
            setTimeout(() => { btn.disabled = false; btn.textContent = 'Send to Agent'; }, 2500);
          }
        });
      });

      async function runApplyOptimize(btn) {
        if (!btn) return;
        const origText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Applying...';
        try {
          const res = await fetch('/api/optimize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: Number(projectId), projectRoot: p.root, apply: true }),
          });
          const data = await res.json();
          if (!res.ok) {
            showToast(`Optimization failed: ${data.error || res.statusText}`, 'error');
            btn.disabled = false;
            btn.textContent = origText;
            return;
          }
          const addedCount = data.ignoreFiles?.reduce((s, f) => s + (f.addedPatterns?.length || 0), 0) || 0;
          const trimCount = data.instructionTrims?.filter((t) => t.applied).length || 0;
          showToast(
            `Applied workspace hygiene to ${p.name}: +${addedCount} ignore rule(s), ${trimCount} file(s) trimmed (est. ~${fmtTok(data.estimatedTokensSavedPerTurn)} tok/turn reduction)`,
            'success'
          );
          closeSlideOver();
          render();
        } catch (err) {
          showToast(`Optimization error: ${err.message}`, 'error');
          btn.disabled = false;
          btn.textContent = origText;
        }
      }

      $('#btn-toggle-optimize-panel')?.addEventListener('click', async () => {
        const data = optPreview || await api('optimize', { project: projectId }).catch(() => null);
        if (!data) {
          showToast('Could not load workspace optimization preview', 'error');
          return;
        }
        const trims = data.instructionTrims || [];
        const oversized = data.oversizedFiles || [];
        const unused = data.unusedItems || [];
        const hasWrites = pendingIgFiles(data.ignoreFiles).length > 0 || trims.length > 0;

        openSlideOver(`⚡ Optimize Workspace: ${p.name}`, `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.28);border-radius:var(--radius-sm);margin-bottom:16px">
            <div>
              <div style="font-weight:700;color:var(--success);font-size:14px">Estimated Reduction: ~${fmtTok(data.estimatedTokensSavedPerTurn)} instruction tokens / turn (estimate, not measured)</div>
              <div style="font-size:12px;color:var(--text-muted)">Root: <code class="cell-mono">${esc(p.root)}</code></div>
            </div>
            <div style="display:flex;gap:8px">
              <button type="button" id="btn-drawer-apply-optimize" class="btn btn-sm">
                ${hasWrites ? '⚡ Apply Hygiene Now' : '✓ Re-Apply / Verify'}
              </button>
            </div>
          </div>

          <h4>1. Ignore Files (.claudeignore &amp; .cursorignore)</h4>
          <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Provider-specific: <code class="cell-mono">.claudeignore</code> has no effect in Claude Code; <code class="cell-mono">.cursorignore</code> applies to Cursor only. Not a security or OS isolation mechanism.</p>
          ${optimizeDrawerIgnoreFilesHtml(data.ignoreFiles)}

          ${oversized.length > 0 ? `
            <h4>2. Oversized Workspace Files (&gt;40 KB) &mdash; context exposure, not savings</h4>
            <ul style="font-size:12.5px;color:var(--text-secondary);padding-left:18px;margin-bottom:14px">
              ${oversized.map((f) => `<li><code class="cell-mono">${esc(f.relativePath)}</code> — ${Math.round(f.bytes / 1024)} KB (~${fmtTok(f.estTokens)} tokens)</li>`).join('')}
            </ul>
          ` : ''}

          <h4>3. Instruction File Trimming (CLAUDE.md / AGENTS.md / GEMINI.md)</h4>
          ${trims.length > 0 ? trims.map((t) => `
            <div style="margin-bottom:12px">
              <div style="font-size:12.5px;font-weight:600;margin-bottom:4px">${esc(t.fileName)} <span class="badge">-${fmtTok(t.tokensSaved)} tok/turn est.</span></div>
              <pre><code>${esc(t.unifiedDiff || t.cuts.map((c) => `- Line ${c.startLine}: ${c.description}`).join('\n'))}</code></pre>
            </div>
          `).join('') : `
            <p style="font-size:12.5px;color:var(--success);margin-bottom:14px">✓ All core instruction files are clean (0 redundant cuts needed).</p>
          `}

          <h4>4. Unused MCP Servers & Skills (0 calls in 30d)</h4>
          ${unused.length > 0 ? `
            <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Consider disabling these unused schemas in <a href="#/audit" onclick="document.getElementById('slide-over-close')?.click()">Config Audit</a>:</p>
            <ul style="font-size:12px;color:var(--text-secondary);padding-left:18px;margin-bottom:16px">
              ${unused.slice(0, 12).map((u) => `<li><strong>[${esc(u.agent)}] ${esc(u.kind.toUpperCase())}</strong> <code class="cell-mono">${esc(u.name)}</code> (~${fmtTok(u.tokens)} tok) — <span class="cell-mono" style="color:var(--text-dim)">${esc(shortenPath(u.sourcePath))}</span></li>`).join('')}
            </ul>
          ` : `<p style="font-size:12.5px;color:var(--success)">✓ Zero unused MCPs detected.</p>`}

          <h4>CLI Equivalent</h4>
          <pre><code>agentlens optimize --project "${esc(p.root)}" --apply</code></pre>
        `);

        $('#btn-drawer-apply-optimize')?.addEventListener('click', (e) => runApplyOptimize(e.currentTarget));
      });
      $('#btn-copy-optimize-cli')?.addEventListener('click', (e) => {
        const cmd = e.currentTarget.dataset.cmd;
        if (cmd) copyText(cmd, 'CLI optimize command copied to clipboard');
      });
      $('#btn-apply-optimize')?.addEventListener('click', (e) => runApplyOptimize(e.currentTarget));

      $('#btn-toggle-budget-form')?.addEventListener('click', () => {
        const form = $('#form-project-budget');
        if (form) form.style.display = form.style.display === 'none' ? 'flex' : 'none';
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
        showToast('Project budget updated', 'success');
        render();
      });
      $('#btn-clear-budget')?.addEventListener('click', async () => {
        await fetch('/api/project/budget', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, budgetTokens: 0, budgetCost: 0 }),
        });
        showToast('Project budget removed', 'success');
        render();
      });

      if (outcome?.trend && outcome.trend.length > 1) {
        const trendDays = outcome.trend.map((t) => Date.parse(`${t.date}T00:00:00`) / 1000);
        chart('c-outcome-trend', trendDays, [
          { label: 'Commits', color: '#6366f1', data: outcome.trend.map((t) => t.commits) },
          { label: 'Lines changed', color: '#10b981', data: outcome.trend.map((t) => t.linesChanged) },
        ], { height: 155 });
      }
    },
  };
}

async function sessionsPage() {
  const rows = await api('sessions', { limit: '300' });
  return {
    html: `
      <div class="page-header">
        <div>
          <h1 class="page-title">Sessions</h1>
          <p class="page-subtitle">Latest coding agent sessions ingested locally. Click any session to inspect turn-by-turn context growth.</p>
        </div>
        <div class="page-actions">
          <a href="/api/export.csv?type=sessions" download="agentlens-sessions.csv" class="btn btn-sm btn-outline">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export CSV
          </a>
        </div>
      </div>
      <div class="card">
        ${table([
          { label: 'Last Activity', get: (r) => fmtShortTime(r.ended) },
          agentCol,
          {
            label: 'Project',
            html: true,
            get: (r) => r.project ? `<strong>${esc(r.project)}</strong>` : '<span style="color:var(--text-dim)">—</span>',
          },
          {
            label: 'Kind',
            html: true,
            get: (r) => r.parentId ? '<span class="badge">Subagent</span>' : '<span class="badge" style="color:var(--text-muted)">Main</span>',
          },
          { label: 'Turns', num: true, get: (r) => r.turns },
          { label: 'Tool Calls', num: true, get: (r) => r.toolCalls },
          ...tokCols,
        ], rows, (r) => `#/session/${encodeURIComponent(r.id)}`)}
      </div>
    `,
  };
}

// Builds DOM with textContent only: prompt and model text must never reach innerHTML.
function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

async function postDiagnose(sessionId, confirm) {
  const r = await fetch('/api/ai/diagnose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(confirm ? { sessionId, confirm } : { sessionId }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const hint = {
      AI_DISABLED: 'AI is turned off. Run `agentlens ai enable` to opt in, then reload.',
      AI_INVALID_SETTINGS: 'Your AI settings are invalid. Check them with `agentlens ai status`.',
      AI_DAILY_LIMIT: 'The daily AI call limit is reached. Try again tomorrow or raise ai_max_calls_per_day.',
      UNKNOWN_SESSION: 'This session is no longer available. Reload the page.',
      AI_PROVIDER_UNSUPPORTED: 'Only the Claude Code CLI is supported for diagnosis. Set ai_agent to auto or claude.',
      AI_RUN_FAILED: 'The AI CLI did not complete. Check that it is installed and signed in, then try again.',
      AI_INVALID_OUTPUT: 'The AI answered in an unexpected format. Try again; nothing was saved.',
    }[body.code];
    throw new Error(hint || 'Could not reach agentlens. Reload the page and try again.');
  }
  return body;
}

// Fixed display mapping only; labels are always model-assigned. Legacy causes without kind show "AI unclassified".
function renderDiagnosis(d, cached) {
  const kinds = { observation: 'AI observation', hypothesis: 'AI hypothesis', unknown: 'AI unknown' };
  const root = mk('div', 'ai-diagnosis');
  root.append(mk('p', 'ai-summary', d.summary));
  if (cached) root.append(mk('p', 'ai-note', 'Saved result from an earlier run. Nothing was sent.'));
  if (d.causes.length) {
    root.append(mk('h4', 'ai-heading', 'Causes and hypotheses'));
    for (const c of d.causes) {
      const item = mk('div', 'ai-item');
      item.append(mk('strong', null, c.cause), mk('span', 'badge', kinds[c.kind] || 'AI unclassified'), mk('p', null, c.evidence),
        mk('span', 'badge', `~${fmtInt(Math.round(c.est_tokens))} tokens, unverified AI estimate`));
      root.append(item);
    }
  }
  if (d.fixes.length) {
    root.append(mk('h4', 'ai-heading', 'Suggested fixes'));
    for (const f of d.fixes) {
      const item = mk('div', 'ai-item');
      item.append(mk('strong', null, f.action), mk('p', 'ai-note', f.where));
      if (f.snippet.trim()) item.append(mk('pre', 'ai-pre', f.snippet));
      root.append(item);
    }
  }
  root.append(mk('p', 'ai-note', 'AI-generated from structured session metadata. Token figures are model estimates, not measurements.'));
  return root;
}

function renderDiagnosePreview(sessionId, preview, onDone, post = postDiagnose) {
  const root = mk('div', 'ai-diagnosis');
  const agent = preview.model ? `${preview.agent} (${preview.model})` : preview.agent;
  root.append(
    mk('p', 'ai-summary', `This sends the data below to your configured provider (${agent}) and uses its quota. Nothing is sent until you confirm.`),
    mk('h4', 'ai-heading', 'Exact prompt'),
  );
  const pre = mk('pre', 'ai-pre ai-prompt', preview.prompt);
  pre.tabIndex = 0; // scrollable region must be keyboard reachable
  pre.setAttribute('aria-label', 'Exact prompt that will be sent');
  const status = mk('p', 'ai-note');
  status.setAttribute('role', 'status');
  const send = mk('button', 'btn btn-sm', `Send to ${preview.agent}`);
  send.type = 'button';
  const cancel = mk('button', 'btn btn-sm btn-outline', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', closeSlideOver);
  send.addEventListener('click', async () => {
    send.disabled = cancel.disabled = true;
    send.textContent = 'Sending…';
    status.textContent = '';
    try {
      const r = await post(sessionId, preview.confirmationHash);
      if (r.status === 'ok') return onDone(r);
      // Data changed since the preview: show the fresh one instead of sending stale consent.
      openSlideOver('Review before sending', renderDiagnosePreview(sessionId, r.preview, onDone, post));
    } catch (err) {
      status.textContent = err.message;
      send.disabled = cancel.disabled = false;
      send.textContent = `Send to ${preview.agent}`;
    }
  });
  const actions = mk('div', 'ai-actions');
  actions.append(send, cancel);
  root.append(pre, status, actions);
  queueMicrotask(() => send.focus());
  return root;
}

function wireAnomalyExplain(btn, anomaly) {
  const post = async (_id, confirm) => {
    const response = await fetch('/api/ai/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: anomaly.day, project: String(anomaly.projectId), agent: anomaly.agent, ...(confirm ? { confirm } : {}) }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Could not prepare the explanation. Try again.');
    return body;
  };
  const showResult = result => {
    const root = mk('div', 'ai-diagnosis');
    root.append(mk('p', 'ai-summary', result.explanation));
    if (result.cached) root.append(mk('p', 'ai-note', 'Saved result from an earlier run. Nothing was sent.'));
    root.append(mk('p', 'ai-note', 'AI interpretation of structured metadata. Causes are unverified; the detected spike is unchanged.'));
    openSlideOver('AI explanation', root);
    $('#slide-over-close')?.focus();
  };
  btn.addEventListener('click', async () => {
    const key = anomalyKey(anomaly);
    if (pendingAnomalies.has(key)) return;
    pendingAnomalies.add(key);
    btn.disabled = true; btn.textContent = 'Preparing…'; $('#anomaly-ai-error').textContent = '';
    // A rerender during the request replaces the button, so look the live one up again by identity.
    const settle = () => { pendingAnomalies.delete(key); const live = anomalyButton(key) || btn; live.disabled = false; live.textContent = 'Explain with AI'; live.focus(); };
    try {
      const result = await post(null);
      settle();
      if (result.status === 'ok') showResult(result);
      else openSlideOver('Review before sending', renderDiagnosePreview(null, result.preview, showResult, post));
    } catch (e) {
      settle(); const status = $('#anomaly-ai-error'); if (status) status.textContent = e.message;
    }
  });
}

function wireExplainWithAi(btn, sessionId) {
  const label = btn.textContent;
  const err = $('#ai-error');
  const showResult = (r) => {
    openSlideOver('AI explanation', renderDiagnosis(r.diagnosis, r.cached));
    $('#slide-over-close')?.focus();
  };
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    if (err) err.textContent = '';
    const reset = () => { btn.disabled = false; btn.textContent = label; btn.focus(); }; // focus first so closing the panel returns here
    try {
      const r = await postDiagnose(sessionId);
      reset();
      if (r.status === 'ok') showResult(r);
      else openSlideOver('Review before sending', renderDiagnosePreview(sessionId, r.preview, showResult));
    } catch (e) {
      reset();
      if (err) err.textContent = e.message;
    }
  });
}

async function sessionPage(id) {
  const [d, timeline, aiState] = await Promise.all([
    api('session', { id: decodeURIComponent(id) }),
    api('session/timeline', { id: decodeURIComponent(id) }).catch(() => null),
    api('ai/status').catch(() => null),
  ]);
  if (!d) return { html: emptyState('Session not found', 'It may not have been ingested yet; check System Health.', '<a href="#/sessions" class="btn btn-sm">Back to Sessions</a>') };

  const turns = timeline?.turns?.length ? timeline.turns : d.turns;
  const markers = timeline?.markers || [];

  return {
    html: `
      <div class="page-header">
        <div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <h1 class="page-title">${esc(AGENTS[d.agent] ?? d.agent)} Session</h1>
            ${agentBadge(d.agent)}
          </div>
          <p class="page-subtitle">
            ${esc(d.project ?? shortenPath(d.cwd) ?? '')} · <code class="cell-mono">${esc(d.id)}</code>
            ${d.parentId ? ` · subagent of <a href="#/session/${encodeURIComponent(d.parentId)}" style="color:var(--accent-hover)">${esc(d.parentId)}</a>` : ''}
          </p>
        </div>
        <div class="page-actions">
          ${aiState?.enabled ? '<button type="button" id="btn-explain-ai" class="btn btn-sm">Explain with AI</button>' : ''}
          <a href="#/sessions" class="btn btn-sm btn-outline">&larr; All Sessions</a>
        </div>
      </div>
      ${aiState?.enabled ? '<p id="ai-error" class="ai-error" role="alert"></p>' : ''}

      <section class="kpi-grid">
        ${tile('Measured Tokens', fmtTok(d.totals.tokens), `${fmtTok(d.totals.cacheRead)} cache read`)}
        ${tile('API-Equivalent Cost', cost(d.totals), 'Estimated list-price cost')}
        ${tile('Conversation Turns', fmtInt(d.turns.length), `${markers.length} detector event${markers.length === 1 ? '' : 's'}`)}
        ${tile('Tool Invocations', fmtInt(d.tools.reduce((acc, t) => acc + (t.calls || 0), 0)), `${d.tools.length} unique tools called`)}
      </section>

      <div class="grid-12">
        <div class="col-7 card chart-container">
          <div class="chart-header">
            <div>
              <h3 class="chart-title">Turn Breakdown & Detector Timeline</h3>
              <span class="card-subtitle">Per-turn input, output, and cache reads with waste detector markers</span>
            </div>
            ${markers.length ? `<span class="pill pill-duplicate">${markers.length} waste event${markers.length === 1 ? '' : 's'}</span>` : '<span class="pill pill-active">Clean Session</span>'}
          </div>
          <div id="c-timeline" class="chart-body"></div>

          ${markers.length > 0 ? `
            <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
              <div style="font-size:10.5px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Fired Detector Markers (click to inspect):</div>
              <div style="display:flex;flex-wrap:wrap;gap:6px">
                ${markers.map((m, idx) => `
                  <button type="button" class="btn btn-xs btn-outline btn-timeline-marker" data-marker-idx="${idx}">
                    <span class="pill pill-open" style="font-size:9.5px;padding:1px 5px">Turn ${m.turnIndex}</span>
                    <strong>${esc(m.rule.replace(/_/g, ' '))}</strong>
                  </button>
                `).join('')}
              </div>
            </div>
          ` : ''}
        </div>

        <div class="col-5 card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Tools Invoked</h3>
              <span class="card-subtitle">${d.tools.length} unique tool${d.tools.length === 1 ? '' : 's'}</span>
            </div>
          </div>
          ${table([
            { label: 'Tool', cls: 'cell-truncate cell-mono', title: (r) => r.tool, get: (r) => r.tool },
            { label: 'Calls', num: true, get: (r) => r.calls },
            { label: 'Payload', num: true, get: (r) => `${fmtTok(r.resultBytes)}B` },
            {
              label: 'Errors',
              num: true,
              html: true,
              get: (r) => r.errors > 0 ? `<span style="color:var(--danger);font-weight:600">${r.errors}</span>` : '<span style="color:var(--text-dim)">0</span>',
            },
          ], d.tools)}
        </div>
      </div>

      ${d.children.length ? `
        <div class="card" style="margin-top:var(--space-4)">
          <div class="card-header"><h3 class="card-title">Spawned Subagent Sessions (${d.children.length})</h3></div>
          ${table([{ label: 'Session ID', cls: 'cell-mono', get: (r) => r.id }, agentCol], d.children, (r) => `#/session/${encodeURIComponent(r.id)}`)}
        </div>
      ` : ''}
    `,
    after: () => {
      const explain = $('#btn-explain-ai');
      if (explain) wireExplainWithAi(explain, d.id);
      if (turns && turns.length) {
        chart('c-timeline', turns.map((t, idx) => t.turnIndex || (idx + 1)), [
          { label: 'Cache read', color: '#10b981', data: turns.map((t) => t.cacheRead || 0) },
          { label: 'Input tokens', color: '#6366f1', data: turns.map((t) => t.input != null ? t.input : Math.max(0, (t.context || 0) - (t.cacheRead || 0))) },
          { label: 'Output tokens', color: '#f59e0b', data: turns.map((t) => t.output || 0) },
        ], { time: false });
      }

      document.querySelectorAll('.btn-timeline-marker').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const idx = Number(e.currentTarget.dataset.markerIdx);
          const m = markers[idx];
          if (!m) return;
          openSlideOver(`Detector Finding: ${m.rule.replace(/_/g, ' ')}`, `
            <div style="display:flex;flex-direction:column;gap:14px">
              <div style="display:flex;gap:8px;align-items:center">
                <span class="pill pill-open">Fired on Turn ${m.turnIndex}</span>
                <span class="badge">${esc(m.confidence.toUpperCase())} CONFIDENCE</span>
              </div>
              <p style="font-size:13.5px;color:var(--text);margin:0;line-height:1.45"><strong>${esc(m.confidenceReason)}</strong></p>
              ${m.estTokensWeek ? `<p style="font-size:13px;color:var(--success);margin:0">Est. Waste: <strong>+${fmtTok(m.estTokensWeek)} tokens/week</strong></p>` : ''}
              <div>
                <h4 style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin:0 0 6px">Evidence Payload</h4>
                <pre style="background:var(--bg-elevated);border:1px solid var(--border);padding:12px;border-radius:var(--radius-md);max-height:240px;overflow:auto;font-family:var(--font-mono);font-size:11.5px;margin:0"><code>${esc(JSON.stringify(m.evidence, null, 2))}</code></pre>
              </div>
              <div style="display:flex;gap:8px;margin-top:6px">
                <button class="btn btn-sm btn-copy-slide-prompt" data-rule="${esc(m.rule)}">Copy Fix Prompt</button>
                <a href="#/recommendations" class="btn btn-sm btn-outline" onclick="document.getElementById('slide-over-close').click()">View in Recommendations</a>
              </div>
            </div>
          `);

          document.querySelector('.btn-copy-slide-prompt')?.addEventListener('click', async (evt) => {
            const rule = evt.currentTarget.dataset.rule;
            try {
              const res = await fetch('/api/fix/prompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rule, agent: d.agent, evidence: m.evidence }),
              }).then((r) => r.json());
              await copyText(res.prompt, 'Fix prompt copied to clipboard');
            } catch (err) {
              showToast(`Failed to copy prompt: ${err.message}`, 'error');
            }
          });
        });
      });
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
      <div class="page-header">
        <div>
          <h1 class="page-title">Quota & Rate Limits</h1>
          <p class="page-subtitle">Sliding 5-hour and 7-day subscription rate limits, burn-rate projections, and historical cap hits.</p>
        </div>
      </div>

      <section class="kpi-grid">
        ${quotaDetailTiles(q.latest)}
      </section>

      <div class="grid-12">
        <div class="col-7 card chart-container">
          <div class="chart-header">
            <div>
              <h3 class="chart-title">Quota Utilization Over Time</h3>
              <span class="card-subtitle">Reported usage percentage across 5h (solid) and 7d (dashed) sliding windows</span>
            </div>
          </div>
          <div id="c-quota" class="chart-body"></div>
        </div>

        <div class="col-5 card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Recorded Limit Hits</h3>
              <span class="card-subtitle">${q.limitHits.length} cap incident${q.limitHits.length === 1 ? '' : 's'} logged</span>
            </div>
          </div>
          ${table([
            agentCol,
            { label: 'Window', html: true, get: (r) => `<span class="badge">${esc(r.win)}</span>` },
            { label: 'First Hit', get: (r) => fmtShortTime(r.firstHit) },
            { label: 'Window Reset', get: (r) => fmtShortTime(r.resetsAt) },
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
          return {
            label: `${AGENTS[agent] ?? agent} ${win}`,
            color: COLORS[agent] || '#6366f1',
            dash: win === '7d' ? [6, 4] : undefined,
            data,
          };
        }), { fmt: (v) => `${Math.round(v)}%` });
      }
    },
  };
}

async function recommendationsPage() {
  const [aiStatus, findData, trackData, projectsList] = await Promise.all([
    api('ai/status').catch(() => null),
    api('findings'),
    api('tracking'),
    api('projects').catch(() => []),
  ]);
  const aiOn = Boolean(aiStatus?.enabled && !aiStatus.error);
  const recData = aiOn ? await api('recommendations', { ai: '1' }) : await api('recommendations');

  const projMap = new Map(
    (Array.isArray(projectsList) ? projectsList : []).map((p) => [String(p.projectId), p.name]),
  );

  const recs = recData.recommendations || [];
  const findings = findData.findings || [];
  const savings = findData.totalEstWeeklySavings || 0;
  const trackedItems = trackData.items || [];

  const openRecs = recs.filter((r) => r.status === 'open');
  const acceptedRecs = recs.filter((r) => r.status === 'accepted' || r.status === 'measuring');

  // Group open recommendations by (findingRule + action + title) so 700 session cards become crisp pattern groups!
  const groupMap = new Map();
  for (const r of openRecs) {
    const key = `${r.findingRule}::${r.action}::${r.title}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        key,
        findingRule: r.findingRule,
        action: r.action,
        title: r.title,
        body: r.body,
        actionSnippet: r.actionSnippet,
        totalScore: 0,
        ids: [],
        projectIds: new Set(),
      });
    }
    const g = groupMap.get(key);
    g.totalScore += (r.score || 0);
    g.ids.push(r.id);
    if (r.projectId != null) g.projectIds.add(String(r.projectId));
    if (r.aiBody && !g.aiBody) g.aiBody = r.aiBody;
    if (r.aiActionSnippet && !g.aiActionSnippet) g.aiActionSnippet = r.aiActionSnippet;
  }
  const groupedRecs = [...groupMap.values()].sort((a, b) => b.totalScore - a.totalScore);

  const allRules = [...new Set(openRecs.map((r) => r.findingRule))].sort();

  const ACTION_PILL = {
    add: 'pill-active',
    remove: 'pill-unused',
    replace: 'pill-duplicate',
    improve: 'pill-open',
  };

  const CONF_COLORS = {
    high: 'var(--success)',
    medium: 'var(--warn)',
    low: 'var(--text-muted)',
  };

  // Filter individual items if 'all' mode or search/rule filter is active
  const searchQ = (state.recSearch || '').toLowerCase().trim();
  const ruleFilter = state.recRuleFilter || 'all';

  const filteredGroups = groupedRecs.filter((g) => {
    if (ruleFilter !== 'all' && g.findingRule !== ruleFilter) return false;
    if (searchQ && !`${g.title} ${g.body} ${g.findingRule}`.toLowerCase().includes(searchQ)) return false;
    return true;
  });

  const filteredIndividual = openRecs.filter((r) => {
    if (ruleFilter !== 'all' && r.findingRule !== ruleFilter) return false;
    const pName = r.projectId != null ? (projMap.get(String(r.projectId)) || '') : '';
    if (searchQ && !`${r.title} ${r.body} ${r.findingRule} ${pName}`.toLowerCase().includes(searchQ)) return false;
    return true;
  });

  const PAGE_SIZE = 18;
  const totalIndividualPages = Math.max(1, Math.ceil(filteredIndividual.length / PAGE_SIZE));
  if (state.recPage > totalIndividualPages) state.recPage = 1;
  const pagedIndividual = filteredIndividual.slice((state.recPage - 1) * PAGE_SIZE, state.recPage * PAGE_SIZE);

  const trackedSection = trackedItems.length > 0 ? `
    <div class="section-header">
      <h2 class="section-title">
        Tracked Improvements (${trackedItems.length})
        <span class="card-subtitle" style="font-weight:400">— 14-day before/after verification with quality guardrails</span>
      </h2>
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
              <span class="pill pill-${esc(r.status)}">${esc(r.status)}</span>
              <span class="badge">${esc(r.findingRule.replace(/_/g, ' '))}</span>
              <span class="track-delta ${deltaClass}" style="margin-left:auto">${esc(delta)}</span>
            </div>
            <h3 class="rec-title">${esc(r.title)}</h3>
            ${res ? `
              <div class="track-metric">Metric: <strong>${esc(res.metricName)}</strong> (${fmtTok(res.baselineVal)} &rarr; ${fmtTok(res.currentVal)})</div>
              <div class="track-metric">Samples: ${res.sampleBefore} pre &middot; ${res.sampleAfter} post (min 5)</div>
              <div class="track-metric">Guardrails: <span style="font-weight:600;color:${res.guardrails?.passed ? 'var(--success)' : 'var(--danger)'}">${res.guardrails?.passed ? 'PASSED' : 'REGRESSED'}</span></div>
            ` : `<p class="rec-body" style="margin:4px 0 0">Tracking initialized &middot; gathering post-adoption sessions...</p>`}
          </div>
        `;
      }).join('')}
    </div>
  ` : '';

  const toolbarHtml = `
    <div class="rec-toolbar">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <div class="segmented-control" role="tablist">
          <button type="button" class="seg-btn ${state.recView === 'grouped' ? 'active' : ''}" data-rec-view="grouped">
            Grouped by Pattern (${groupedRecs.length})
          </button>
          <button type="button" class="seg-btn ${state.recView === 'all' ? 'active' : ''}" data-rec-view="all">
            All Occurrences (${openRecs.length})
          </button>
        </div>

        <select id="sel-rec-rule" class="form-select" style="padding:4px 8px;font-size:12px">
          <option value="all" ${ruleFilter === 'all' ? 'selected' : ''}>All Detector Rules (${allRules.length})</option>
          ${allRules.map((rule) => `<option value="${esc(rule)}" ${ruleFilter === rule ? 'selected' : ''}>${esc(rule.replace(/_/g, ' '))}</option>`).join('')}
        </select>
      </div>

      <div style="display:flex;align-items:center;gap:8px;flex:1;justify-content:flex-end;min-width:220px">
        <input type="search" id="inp-rec-search" class="form-input" style="padding:4px 10px;font-size:12px;width:min(260px, 100%)" placeholder="Filter recommendations..." value="${esc(state.recSearch)}" />
      </div>
    </div>
  `;

  let cardsHtml = '';
  if (openRecs.length === 0) {
    cardsHtml = emptyState('No open recommendations!', 'All detected workflow waste patterns have been accepted or dismissed.');
  } else if (state.recView === 'grouped') {
    cardsHtml = filteredGroups.length === 0
      ? emptyState('No matching recommendation groups', 'Try clearing your rule or search filter.')
      : `<div class="rec-grid">
          ${filteredGroups.map((g, idx) => {
            const projNames = [...g.projectIds].map((pid) => projMap.get(pid) || `Project #${pid}`);
            const projSummary = projNames.length === 0
              ? 'Global / Session-level'
              : projNames.length <= 2
                ? projNames.join(', ')
                : `${projNames.slice(0, 2).join(', ')} +${projNames.length - 2} more`;

            return `
              <div class="rec-card">
                <div class="rec-header">
                  <span class="pill ${ACTION_PILL[g.action] || 'pill-open'}">${esc(g.action)}</span>
                  <span class="badge">${esc(g.findingRule.replace(/_/g, ' '))}</span>
                  ${g.ids.length > 1 ? `<span class="badge" style="color:var(--accent-hover);border-color:var(--accent-border)">${g.ids.length} occurrences</span>` : ''}
                  <span style="margin-left:auto;font-weight:700;font-size:12px;color:var(--success)">${g.totalScore ? `+${fmtTok(g.totalScore)}/wk` : ''}</span>
                </div>
                <h3 class="rec-title">${esc(g.title)}</h3>
                <div style="font-size:11.5px;color:var(--text-dim);margin-bottom:6px">
                  📁 ${esc(projSummary)}
                </div>
                <p class="rec-body">${esc(g.body)}</p>
                ${g.aiBody ? `
                  <div class="ai-rec-enrichment">
                    <span class="badge">AI-refined (unverified)</span>
                    <p class="rec-body ai-rec-body">${esc(g.aiBody)}</p>
                  </div>
                ` : ''}
                ${g.actionSnippet ? `
                  <div class="snippet-box">
                    <code>${esc(g.actionSnippet)}</code>
                    <button type="button" class="btn btn-xs btn-outline btn-copy-snippet" data-snippet="${esc(g.actionSnippet)}">Copy</button>
                  </div>
                ` : ''}
                ${g.aiActionSnippet ? `
                  <div class="snippet-box">
                    <span class="badge">AI snippet</span>
                    <code>${esc(g.aiActionSnippet)}</code>
                    <button type="button" class="btn btn-xs btn-outline btn-copy-snippet" data-snippet="${esc(g.aiActionSnippet)}">Copy</button>
                  </div>
                ` : ''}
                <div class="rec-actions">
                  <button class="btn btn-sm btn-accept-group" data-group-idx="${idx}">
                    ${g.ids.length > 1 ? `Accept All (${g.ids.length})` : 'Accept & Track'}
                  </button>
                  <button class="btn btn-sm btn-outline btn-dismiss-group" data-group-idx="${idx}">
                    ${g.ids.length > 1 ? 'Dismiss All' : 'Dismiss'}
                  </button>
                </div>
              </div>
            `;
          }).join('')}
        </div>`;
  } else {
    cardsHtml = pagedIndividual.length === 0
      ? emptyState('No matching recommendations', 'Try clearing your search or rule filter.')
      : `
        <div class="rec-grid">
          ${pagedIndividual.map((r) => {
            const pName = r.projectId != null ? (projMap.get(String(r.projectId)) || `Project #${r.projectId}`) : 'Session-level';
            return `
              <div class="rec-card" data-rec-id="${esc(r.id)}">
                <div class="rec-header">
                  <span class="pill ${ACTION_PILL[r.action] || 'pill-open'}">${esc(r.action)}</span>
                  <span class="badge">${esc(r.findingRule.replace(/_/g, ' '))}</span>
                  <span style="margin-left:auto;font-weight:700;font-size:12px;color:var(--success)">${r.score ? `+${fmtTok(r.score)}/wk` : ''}</span>
                </div>
                <h3 class="rec-title">${esc(r.title)}</h3>
                <div style="font-size:11.5px;color:var(--text-dim);margin-bottom:6px">📁 ${esc(pName)}</div>
                <p class="rec-body">${esc(r.body)}</p>
                ${r.aiBody ? `
                  <div class="ai-rec-enrichment">
                    <span class="badge">AI-refined (unverified)</span>
                    <p class="rec-body ai-rec-body">${esc(r.aiBody)}</p>
                  </div>
                ` : ''}
                ${r.actionSnippet ? `
                  <div class="snippet-box">
                    <code>${esc(r.actionSnippet)}</code>
                    <button type="button" class="btn btn-xs btn-outline btn-copy-snippet" data-snippet="${esc(r.actionSnippet)}">Copy</button>
                  </div>
                ` : ''}
                ${r.aiActionSnippet ? `
                  <div class="snippet-box">
                    <span class="badge">AI snippet</span>
                    <code>${esc(r.aiActionSnippet)}</code>
                    <button type="button" class="btn btn-xs btn-outline btn-copy-snippet" data-snippet="${esc(r.aiActionSnippet)}">Copy</button>
                  </div>
                ` : ''}
                <div class="rec-actions">
                  <button class="btn btn-sm btn-accept" data-id="${esc(r.id)}">Accept & Track</button>
                  <button class="btn btn-sm btn-outline btn-dismiss" data-id="${esc(r.id)}">Dismiss</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
        ${totalIndividualPages > 1 ? `
          <div class="pagination-bar">
            <span>Showing ${(state.recPage - 1) * PAGE_SIZE + 1}–${Math.min(state.recPage * PAGE_SIZE, filteredIndividual.length)} of ${filteredIndividual.length} recommendations</span>
            <div style="display:flex;gap:6px">
              <button type="button" class="btn btn-xs btn-outline" id="btn-rec-prev" ${state.recPage <= 1 ? 'disabled' : ''}>&larr; Previous</button>
              <span style="padding:2px 8px;font-weight:600;color:var(--text)">Page ${state.recPage} / ${totalIndividualPages}</span>
              <button type="button" class="btn btn-xs btn-outline" id="btn-rec-next" ${state.recPage >= totalIndividualPages ? 'disabled' : ''}>Next &rarr;</button>
            </div>
          </div>
        ` : ''}
      `;
  }

  const findingsTable = table(
    [
      {
        label: 'Detector Rule',
        html: true,
        get: (f) => `<span class="badge">${esc(f.rule.replace(/_/g, ' '))}</span>`,
      },
      {
        label: 'Confidence',
        html: true,
        get: (f) => `<span style="color:${CONF_COLORS[f.confidence] || 'inherit'};font-weight:600;text-transform:uppercase;font-size:11px">${esc(f.confidence)}</span>`,
      },
      {
        label: 'Diagnostic Reason',
        cls: 'cell-truncate',
        title: (f) => f.confidenceReason,
        get: (f) => f.confidenceReason,
      },
      {
        label: 'Est. Waste / Wk',
        num: true,
        html: true,
        get: (f) => f.estTokensWeek ? `<strong style="color:var(--success)">+${fmtTok(f.estTokensWeek)}</strong>` : '<span style="color:var(--text-dim)">diagnostic</span>',
      },
      { label: 'Last Seen', get: (f) => fmtShortTime(f.lastSeen) },
    ],
    findings.slice(0, 150),
    (f) => f.sessionId ? `#/session/${encodeURIComponent(f.sessionId)}` : undefined,
  );

  return {
    html: `
      <div class="page-header">
        <div>
          <h1 class="page-title">Recommendations & Findings</h1>
          <p class="page-subtitle">Deterministic workflow waste patterns, estimated weekly token savings, and 14-day improvement verification.</p>
        </div>
        <div class="page-actions">
          ${aiOn && openRecs.length > 0 ? '<button type="button" id="btn-enrich-ai" class="btn btn-sm btn-outline">Enrich with AI</button>' : ''}
          <a href="/api/export.csv?type=findings" download="agentlens-findings.csv" class="btn btn-sm btn-outline">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export Findings CSV
          </a>
        </div>
      </div>
      <p id="rec-ai-error" class="ai-note" role="alert"></p>

      <section class="kpi-grid">
        ${tile('Est. Weekly Savings', fmtTok(savings), 'Potential token reduction across active rules')}
        ${tile('Unique Patterns', String(groupedRecs.length), `${openRecs.length} total open occurrences`)}
        ${tile('Tracked Improvements', String(acceptedRecs.length), 'Active 14-day before/after cohorts')}
        ${tile('Detector Findings', fmtInt(findings.length), 'Across 14 deterministic waste rules')}
      </section>

      ${trackedSection}

      <div class="section-header">
        <h2 class="section-title">Active Recommendations</h2>
      </div>
      ${toolbarHtml}
      ${cardsHtml}

      <div class="section-header">
        <div>
          <h2 class="section-title">Raw Workflow Findings (${findings.length})</h2>
          <span class="card-subtitle">Click any session finding to inspect its turn-by-turn timeline</span>
        </div>
      </div>
      <div class="card">
        ${findingsTable}
      </div>
    `,
    after: () => {
      const postRecEnrich = async (_id, confirm) => {
        const r = await fetch('/api/ai/recommendations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(confirm ? { confirm } : {}),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok || body.status === 'error') {
          throw new Error(body.message || 'Could not enrich recommendations.');
        }
        return body;
      };

      const enrichBtn = $('#btn-enrich-ai');
      if (enrichBtn) {
        enrichBtn.addEventListener('click', async () => {
          enrichBtn.disabled = true;
          enrichBtn.textContent = 'Preparing…';
          const errEl = $('#rec-ai-error');
          if (errEl) errEl.textContent = '';
          const reset = () => {
            enrichBtn.disabled = false;
            enrichBtn.textContent = 'Enrich with AI';
          };
          try {
            const result = await postRecEnrich(null);
            reset();
            if (result.status === 'ok') {
              closeSlideOver();
              await render();
              $('#btn-enrich-ai')?.focus();
            } else if (result.status === 'confirmation_required') {
              openSlideOver('Review before sending', renderDiagnosePreview(null, result.preview, async () => {
                closeSlideOver();
                await render();
                $('#btn-enrich-ai')?.focus();
              }, postRecEnrich));
            }
          } catch (e) {
            reset();
            const err = $('#rec-ai-error') || errEl;
            if (err) err.textContent = e.message;
          }
        });
      }

      document.querySelectorAll('[data-rec-view]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          state.recView = e.currentTarget.dataset.recView;
          state.recPage = 1;
          render();
        });
      });

      $('#sel-rec-rule')?.addEventListener('change', (e) => {
        state.recRuleFilter = e.target.value;
        state.recPage = 1;
        render();
      });

      $('#inp-rec-search')?.addEventListener('input', (e) => {
        state.recSearch = e.target.value;
        state.recPage = 1;
        render();
      });

      $('#btn-rec-prev')?.addEventListener('click', () => {
        if (state.recPage > 1) {
          state.recPage--;
          render();
        }
      });
      $('#btn-rec-next')?.addEventListener('click', () => {
        if (state.recPage < totalIndividualPages) {
          state.recPage++;
          render();
        }
      });

      document.querySelectorAll('.btn-copy-snippet').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          copyText(e.currentTarget.dataset.snippet, 'Command snippet copied');
        });
      });

      document.querySelectorAll('.btn-accept-group').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const g = filteredGroups[Number(e.currentTarget.dataset.groupIdx)];
          if (!g) return;
          btn.disabled = true;
          btn.textContent = 'Accepting...';
          await Promise.all(g.ids.map((id) => fetch(`/api/recommendations/${encodeURIComponent(id)}/accept`, { method: 'POST' })));
          showToast(`Accepted ${g.ids.length} recommendation(s) for tracking`, 'success');
          updateNavBadges();
          render();
        });
      });

      document.querySelectorAll('.btn-dismiss-group').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const g = filteredGroups[Number(e.currentTarget.dataset.groupIdx)];
          if (!g) return;
          btn.disabled = true;
          await Promise.all(g.ids.map((id) => fetch(`/api/recommendations/${encodeURIComponent(id)}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'dismissed' }),
          })));
          showToast(`Dismissed ${g.ids.length} recommendation(s)`, 'success');
          updateNavBadges();
          render();
        });
      });

      document.querySelectorAll('.btn-accept').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const id = e.currentTarget.dataset.id;
          await fetch(`/api/recommendations/${encodeURIComponent(id)}/accept`, { method: 'POST' });
          showToast('Recommendation accepted for 14-day tracking', 'success');
          updateNavBadges();
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
          showToast('Recommendation dismissed', 'success');
          updateNavBadges();
          render();
        });
      });
    },
  };
}

async function auditPage() {
  const [data, settingsRes] = await Promise.all([
    api('audit'),
    api('settings').catch(() => ({})),
  ]);
  const allowAgentLaunch = settingsRes?.settings?.allow_agent_launch === 'true' || settingsRes?.settings?.allowAgentLaunch === 'true';
  const items = data.items || [];
  const trimmings = data.trimmings || [];
  const summary = data.summary || {
    totalItems: 0,
    totalFixedTokens: 0,
    unusedCount: 0,
    duplicateCount: 0,
    conflictCount: 0,
    totalTrimSavings: 0,
  };

  const statusPill = (status) => `<span class="pill pill-${esc(status)}">${esc(status)}</span>`;
  const instructions = items.filter((i) => i.kind === 'instruction');
  const toolsAndMcps = items.filter((i) => i.kind === 'mcp' || i.kind === 'plugin');
  const skills = items.filter((i) => i.kind === 'skill');
  const issues = items.filter((i) => i.status === 'duplicate' || i.status === 'conflict');

  const trimmerSection = trimmings.length > 0 ? `
    <div class="card" style="margin-bottom:var(--space-4);border-color:var(--accent-border)">
      <div class="card-header">
        <div>
          <h3 class="card-title" style="color:var(--accent-hover)">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
            Instruction Trimmer & Unified Diffs (${trimmings.length})
          </h3>
          <span class="card-subtitle">Automated non-destructive cuts for duplicate rules, oversized code blocks, and stale paths (~${fmtTok(summary.totalTrimSavings || 0)} tokens/turn saved).</span>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px">
        ${trimmings.map((t, idx) => `
          <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-md);padding:14px">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px">
              <div>
                <div style="display:flex;align-items:center;gap:8px">
                  <strong style="font-size:13.5px;color:var(--text)">${esc(t.fileName)}</strong>
                  ${agentBadge(t.agent)}
                  ${t.projectName ? `<span class="badge">📁 ${esc(t.projectName)}</span>` : ''}
                </div>
                <div class="cell-mono" style="color:var(--text-muted);margin-top:3px">${esc(t.filePath)}</div>
              </div>
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <span class="pill pill-active">+${fmtTok(t.tokensSaved)} tok/turn</span>
                <button type="button" class="btn btn-xs btn-outline btn-copy-trim-diff" data-idx="${idx}">Copy Diff</button>
                <button type="button" class="btn btn-xs btn-outline btn-copy-trim-prompt" data-idx="${idx}">Copy Prompt</button>
                <button type="button" class="btn btn-xs ${allowAgentLaunch ? '' : 'btn-outline'} btn-send-trim-agent" data-idx="${idx}" ${allowAgentLaunch ? '' : 'data-disabled="true"'}>
                  ${allowAgentLaunch ? 'Send to Agent' : 'Send (Opt-in)'}
                </button>
              </div>
            </div>

            <div style="margin:8px 0">
              <ul style="margin:0;padding-left:18px;font-size:12px;color:var(--text-main)">
                ${t.cuts.map((c) => `
                  <li style="margin-bottom:3px">
                    <span class="badge" style="font-size:9.5px">${esc(c.type.replace(/_/g, ' '))}</span>
                    L${c.startLine}${c.endLine > c.startLine ? `–${c.endLine}` : ''}:
                    <span>${esc(c.description)}</span>
                    <strong style="color:var(--success);margin-left:4px">(+${fmtTok(c.tokensSaved)} tok)</strong>
                  </li>
                `).join('')}
              </ul>
            </div>

            <div class="diff-container">
              ${renderDiff(t.unifiedDiff)}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';

  return {
    html: `
      <div class="page-header">
        <div>
          <h1 class="page-title">Configuration Audit</h1>
          <p class="page-subtitle">Read-only inspection of always-loaded instruction overhead, MCP servers, skills, plugins, duplicates, and conflicts.</p>
        </div>
      </div>

      <section class="kpi-grid">
        ${tile('Fixed Session Overhead', fmtTok(summary.totalFixedTokens), 'Instruction tokens injected every session/turn')}
        ${tile('Configured Items', fmtInt(summary.totalItems), `${items.filter((i) => i.status === 'active').length} active in last 30 days`)}
        ${tile('Unused (30 Days)', fmtInt(summary.unusedCount), 'Stale MCP servers, skills, or plugins')}
        ${tile('Duplicates & Conflicts', fmtInt(summary.duplicateCount + summary.conflictCount), `${summary.duplicateCount} duplicates · ${summary.conflictCount} conflicts`)}
      </section>

      ${trimmerSection}

      <div class="grid-12">
        <div class="col-6 card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Instruction Files (${instructions.length})</h3>
              <span class="card-subtitle">Always-loaded context files (hover file for full path)</span>
            </div>
          </div>
          ${table([
            agentCol,
            {
              label: 'File',
              html: true,
              title: (r) => r.sourcePath,
              get: (r) => `
                <div class="cell-truncate" style="max-width:190px;font-weight:500;color:var(--text)">${esc(r.name)}</div>
                <div class="cell-path" style="max-width:190px">${esc(shortenPath(r.sourcePath))}</div>
              `,
            },
            { label: 'Tokens', num: true, get: (r) => fmtTok(r.tokens) },
            { label: 'Chars', num: true, get: (r) => fmtInt(r.details?.chars) },
          ], instructions)}
        </div>

        <div class="col-6 card">
          <div class="card-header">
            <div>
              <h3 class="card-title">MCP Servers & Plugins (${toolsAndMcps.length})</h3>
              <span class="card-subtitle">Correlated with 30-day tool call history</span>
            </div>
          </div>
          ${table([
            agentCol,
            {
              label: 'Server / Plugin',
              html: true,
              title: (r) => r.sourcePath,
              get: (r) => `
                <div style="display:flex;align-items:center;gap:6px">
                  <span class="cell-truncate" style="max-width:140px;font-weight:500;color:var(--text)">${esc(r.name)}</span>
                  <span class="badge" style="font-size:9.5px;padding:1px 5px">${esc(r.kind)}</span>
                </div>
                <div class="cell-path" style="max-width:170px">${esc(shortenPath(r.sourcePath))}</div>
              `,
            },
            { label: 'Status', html: true, get: (r) => statusPill(r.status) },
            { label: '30d Calls', num: true, get: (r) => r.invocations30d > 0 ? fmtInt(r.invocations30d) : '0' },
          ], toolsAndMcps)}
        </div>
      </div>

      <div class="grid-12">
        <div class="col-6 card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Skills (${skills.length})</h3>
              <span class="card-subtitle">Discovered across global and workspace directories</span>
            </div>
          </div>
          ${table([
            agentCol,
            {
              label: 'Skill',
              html: true,
              title: (r) => r.sourcePath || r.name,
              get: (r) => `<div class="cell-truncate" style="max-width:155px;font-weight:500;color:var(--text)">${esc(r.name)}</div>`,
            },
            { label: 'Status', html: true, get: (r) => statusPill(r.status) },
            { label: 'Calls', num: true, get: (r) => r.invocations30d > 0 ? fmtInt(r.invocations30d) : '0' },
            { label: 'Tokens', num: true, get: (r) => fmtTok(r.tokens) },
          ], skills)}
        </div>

        <div class="col-6 card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Flagged Duplicates & Conflicts (${issues.length})</h3>
              <span class="card-subtitle">Redundant or contradictory declarations</span>
            </div>
          </div>
          ${issues.length === 0 ? emptyState('No duplicates or conflicts', 'All tool and instruction declarations are consistent.') : table([
            agentCol,
            { label: 'Issue', html: true, get: (r) => statusPill(r.status) },
            { label: 'Kind', html: true, get: (r) => `<span class="badge">${esc(r.kind)}</span>` },
            {
              label: 'Item & Source',
              html: true,
              title: (r) => r.sourcePath,
              get: (r) => `
                <div class="cell-truncate" style="max-width:180px;font-weight:500;color:var(--text)">${esc(r.name)}</div>
                <div class="cell-path" style="max-width:180px">${esc(shortenPath(r.sourcePath))}</div>
              `,
            },
          ], issues)}
        </div>
      </div>
    `,
    after: () => {
      document.querySelectorAll('.btn-copy-trim-diff').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const t = trimmings[Number(e.currentTarget.dataset.idx)];
          if (t) copyText(t.unifiedDiff, `Unified diff for ${t.fileName} copied`);
        });
      });

      document.querySelectorAll('.btn-copy-trim-prompt').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const t = trimmings[Number(e.currentTarget.dataset.idx)];
          if (t) copyText(t.fixPrompt, `Trimmer prompt for ${t.fileName} copied`);
        });
      });

      document.querySelectorAll('.btn-send-trim-agent').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          if (btn.dataset.disabled === 'true') {
            showToast('Enable "Allow agentlens to launch agents" in Settings first.', 'warn');
            location.hash = '#/settings';
            return;
          }
          const t = trimmings[Number(e.currentTarget.dataset.idx)];
          if (!t) return;
          const defaultCli = t.agent === 'claude' ? 'claude' : t.agent === 'codex' ? 'codex' : 'opencode run';
          if (!confirm(`Send Trimming Fix to ${AGENTS[t.agent] || t.agent}?\n\nCommand: ${defaultCli} "${t.fixPrompt.slice(0, 80)}..."\nTarget: ${t.filePath}`)) return;

          btn.disabled = true;
          btn.textContent = 'Launching...';
          try {
            const runRes = await fetch('/api/fix/run', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                agent: t.agent,
                prompt: t.fixPrompt,
                projectId: t.projectId ?? undefined,
                headless: false,
              }),
            });
            const resData = await runRes.json();
            if (!runRes.ok) {
              showToast(`Launch failed: ${resData.error || runRes.statusText}`, 'error');
              btn.textContent = 'Failed';
            } else {
              showToast('Dispatched trimmer fix to agent CLI', 'success');
              btn.textContent = 'Dispatched!';
            }
          } catch (err) {
            showToast(`Launch error: ${err.message}`, 'error');
            btn.textContent = 'Error';
          }
        });
      });
    },
  };
}

async function reportsPage() {
  const reportsList = await api('reports');
  const reports = reportsList.reports || [];

  const selectedWeek = state.reportWeek || (reports[0]?.week);
  let reportDetail = null;

  if (selectedWeek) {
    try {
      const r = await fetch(`/api/reports/${encodeURIComponent(selectedWeek)}`);
      if (r.ok) reportDetail = await r.json();
    } catch {}
  }

  const headerHtml = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Weekly Usage Reports</h1>
        <p class="page-subtitle">Executive summaries of week-over-week trends, quota peaks, waste patterns, and top priorities.</p>
      </div>
      <div class="page-actions">
        <select id="rep-select" class="form-select" style="min-width:220px">
          ${reports.length === 0 ? '<option value="">No reports generated yet</option>' : ''}
          ${reports.map((r) => `<option value="${esc(r.week)}" ${r.week === selectedWeek ? 'selected' : ''}>${esc(r.week)} · ${fmtShortTime(r.generatedAt)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" id="btn-gen-report">Generate Current Week</button>
      </div>
    </div>
  `;

  if (!reportDetail) {
    return {
      html: `
        ${headerHtml}
        <div class="card">
          ${emptyState('No weekly report available yet', 'Generate a report to inspect week-over-week token trends and priorities.', '<button class="btn" id="btn-gen-first">Generate Report Now</button>')}
        </div>
      `,
      after: () => {
        const genBtn = $('#btn-gen-report') || $('#btn-gen-first');
        genBtn?.addEventListener('click', async () => {
          genBtn.disabled = true;
          genBtn.textContent = 'Generating...';
          await fetch('/api/reports/generate', { method: 'POST' });
          showToast('Weekly report generated', 'success');
          render();
        });
      },
    };
  }

  const d = reportDetail.data || {};
  const s = d.summary || { totalTokens: 0, tokensDeltaPct: 0, totalCost: 0, costDeltaPct: 0, activeSessions: 0, sessionsDeltaPct: 0 };
  const q = d.quotaInsights || { fiveHourPeakPct: 0, sevenDayPeakPct: 0, limitHits: 0 };
  const weekLabel = d.week || selectedWeek || 'Current';
  const dateRange = (d.startDate && d.endDate) ? `${d.startDate} to ${d.endDate}` : '';
  const mode = state.reportMode || 'native';

  const nativeBody = `
    <div class="grid-12">
      <div class="col-6 card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Week-over-Week by Agent</h3>
            <span class="card-subtitle">Period: ${esc(dateRange)}</span>
          </div>
        </div>
        ${table([
          agentCol,
          { label: 'Tokens', num: true, get: (r) => fmtTok(r.tokens) },
          { label: 'Est. Cost', num: true, get: (r) => fmtUsd(r.cost) },
          { label: 'Sessions', num: true, get: (r) => r.sessions },
          { label: 'WoW Delta', num: true, get: (r) => fmtDelta(r.deltaPct) },
        ], d.byAgent || [])}
      </div>

      <div class="col-6 card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Top Projects</h3>
            <span class="card-subtitle">Project token share and budget status</span>
          </div>
        </div>
        ${table([
          { label: 'Project', html: true, get: (r) => `<strong>${esc(r.name)}</strong>` },
          { label: 'Tokens', num: true, get: (r) => fmtTok(r.tokens) },
          { label: 'Est. Cost', num: true, get: (r) => fmtUsd(r.cost) },
          { label: 'Sessions', num: true, get: (r) => r.sessions },
          { label: 'WoW', num: true, get: (r) => fmtDelta(r.deltaPct) },
        ], d.byProject || [])}
      </div>
    </div>

    <div class="grid-12">
      <div class="col-6 card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Top Wasting Patterns</h3>
            <span class="card-subtitle">Highest-impact detector rules triggered this week</span>
          </div>
        </div>
        ${table([
          { label: 'Rule', html: true, get: (r) => `<span class="badge">${esc(r.rule.replace(/_/g, ' '))}</span>` },
          { label: 'Hits', num: true, get: (r) => r.count },
          { label: 'Est. Waste/Wk', num: true, html: true, get: (r) => `<strong style="color:var(--warn)">${fmtTok(r.estTokensWeek)}</strong>` },
          { label: 'Summary', cls: 'cell-truncate', title: (r) => r.description, get: (r) => r.description },
        ], d.topWastePatterns || [])}
      </div>

      <div class="col-6 card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Top Priority Actions for Next Week</h3>
            <span class="card-subtitle">Recommended changes ranked by savings</span>
          </div>
        </div>
        ${table([
          { label: 'Action', html: true, get: (r) => `<span class="pill pill-open">${esc(r.action)}</span>` },
          { label: 'Priority', cls: 'cell-truncate', title: (r) => r.title, get: (r) => r.title },
          { label: 'Est. Savings', num: true, html: true, get: (r) => `<strong style="color:var(--success)">+${fmtTok(r.estSavingsTokens)}/wk</strong>` },
        ], d.topActions || [])}
      </div>
    </div>
  `;

  return {
    html: `
      ${headerHtml}

      <section class="kpi-grid">
        ${tile('Weekly Tokens', fmtTok(s.totalTokens), `${fmtDelta(s.tokensDeltaPct)} vs previous week`)}
        ${tile('Estimated API Cost', fmtUsd(s.totalCost), `${fmtDelta(s.costDeltaPct)} vs previous week`)}
        ${tile('Active Sessions', fmtInt(s.activeSessions), `${fmtDelta(s.sessionsDeltaPct)} vs previous week`)}
        ${tile('5h Peak Quota', `${q.fiveHourPeakPct}%`, `${q.limitHits} limit hit${q.limitHits === 1 ? '' : 's'} · 7d peak ${q.sevenDayPeakPct ?? 0}%`)}
      </section>

      <div class="rec-toolbar">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <div class="segmented-control">
            <button type="button" class="seg-btn ${mode === 'native' ? 'active' : ''}" data-rep-mode="native">Dashboard View</button>
            <button type="button" class="seg-btn ${mode === 'markdown' ? 'active' : ''}" data-rep-mode="markdown">Markdown Source</button>
            <button type="button" class="seg-btn ${mode === 'html' ? 'active' : ''}" data-rep-mode="html">Standalone HTML</button>
          </div>
          <span class="card-subtitle">Report <strong>${esc(weekLabel)}</strong> (${esc(dateRange)})</span>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button id="btn-copy-md" class="btn btn-xs btn-outline">Copy Markdown</button>
          <a href="data:text/html;charset=utf-8,${encodeURIComponent(reportDetail.html || '')}" download="${esc(weekLabel)}.html" class="btn btn-xs btn-outline">Download HTML</a>
          <a href="/api/reports/${encodeURIComponent(weekLabel)}" target="_blank" class="btn btn-xs btn-outline">Raw JSON &nearr;</a>
        </div>
      </div>

      ${mode === 'native'
        ? nativeBody
        : mode === 'markdown'
          ? `<div class="report-viewer card"><pre><code>${esc(reportDetail.markdown || '')}</code></pre></div>`
          : `<div class="report-viewer card"><iframe srcdoc="${esc(reportDetail.html || '')}" style="width:100%;min-height:620px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg)"></iframe></div>`
      }
    `,
    after: () => {
      $('#rep-select')?.addEventListener('change', (e) => {
        state.reportWeek = e.target.value;
        render();
      });
      $('#btn-gen-report')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Generating...';
        await fetch('/api/reports/generate', { method: 'POST' });
        showToast('Weekly report refreshed', 'success');
        render();
      });
      document.querySelectorAll('[data-rep-mode]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          state.reportMode = e.currentTarget.dataset.repMode;
          render();
        });
      });
      $('#btn-copy-md')?.addEventListener('click', () => {
        copyText(reportDetail.markdown || '', 'Report Markdown copied to clipboard');
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
    <div class="rec-toolbar">
      <div class="segmented-control">
        <button id="tab-curated" class="seg-btn ${tab === 'curated' ? 'active' : ''}">Curated Tools & MCPs (${catalog.length})</button>
        <button id="tab-candidates" class="seg-btn ${tab === 'candidates' ? 'active' : ''}">Discovered Candidates (${candidates.length})</button>
      </div>
      ${tab === 'curated' ? `
        <div style="display:flex;align-items:center;gap:8px">
          <span class="filter-label">Kind</span>
          <select id="sel-cat-kind" class="form-select" style="font-size:12px;padding:4px 8px">
            <option value="all" ${kindFilter === 'all' ? 'selected' : ''}>All Types</option>
            <option value="mcp" ${kindFilter === 'mcp' ? 'selected' : ''}>MCP Servers</option>
            <option value="tool" ${kindFilter === 'tool' ? 'selected' : ''}>CLI Tools</option>
            <option value="plugin" ${kindFilter === 'plugin' ? 'selected' : ''}>Plugins</option>
            <option value="skill" ${kindFilter === 'skill' ? 'selected' : ''}>Skills</option>
          </select>
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
                <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
                  <span class="badge">${esc(item.kind.toUpperCase())}</span>
                  <span class="pill pill-active">~${item.estSavingsPct}% Token Savings</span>
                </div>
              </div>
            </div>
            <div class="catalog-desc">${esc(item.description)}</div>
            <div style="margin-bottom:12px">
              <div style="font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-dim);margin-bottom:5px">Targets Waste Rules</div>
              <div style="display:flex;gap:4px;flex-wrap:wrap">
                ${item.targetRules.map((r) => `<span class="badge" style="color:var(--text-muted)">${esc(r.replace(/_/g, ' '))}</span>`).join('')}
              </div>
            </div>
            ${item.installCommand ? `
              <div class="catalog-install">
                <code title="${esc(item.installCommand)}">${esc(item.installCommand)}</code>
                <button type="button" class="btn btn-xs btn-outline btn-copy-install" data-cmd="${esc(item.installCommand)}">Copy</button>
              </div>
            ` : ''}
            <div style="margin-top:auto;display:flex;justify-content:space-between;align-items:center">
              <a href="${esc(item.url)}" target="_blank" rel="noopener" class="btn btn-xs btn-outline">View Repository &nearr;</a>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  } else {
    contentHtml = `
      <div class="card" style="margin-bottom:var(--space-4)">
        <h3 class="card-title" style="margin-bottom:4px">Opt-In GitHub Discovery</h3>
        <p class="hint" style="margin-bottom:12px">
          Search GitHub for public AI developer tools and MCPs. <strong>Privacy Guarantee:</strong> Queries use only generic keywords; your code, prompts, project names, and tokens never leave your machine.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input type="text" id="inp-discover-q" class="form-input" placeholder="Search keywords (e.g. mcp server postgres)" style="flex:1;min-width:240px" />
          <button id="btn-run-discover" class="btn btn-sm">Discover Tools</button>
        </div>
      </div>
      ${candidates.length === 0 ? emptyState('No candidate tools discovered yet', 'Click "Discover Tools" above or run agentlens discover in your terminal.') : `
        <div class="catalog-grid">
          ${candidates.map((c) => `
            <div class="catalog-card">
              <div class="catalog-header">
                <div>
                  <h3 class="catalog-title">${esc(c.fullName)}</h3>
                  <div style="display:flex;gap:6px;margin-top:6px">
                    <span class="pill pill-duplicate">★ ${c.stars.toLocaleString()}</span>
                    <span class="badge">${esc(c.suggestedKind.toUpperCase())}</span>
                    ${c.relevanceRule ? `<span class="badge">${esc(c.relevanceRule)}</span>` : ''}
                  </div>
                </div>
              </div>
              <div class="catalog-desc">${esc(c.description || 'No description provided')}</div>
              <div style="margin-top:auto">
                <a href="${esc(c.url)}" target="_blank" rel="noopener" class="btn btn-xs btn-outline">View on GitHub &nearr;</a>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    `;
  }

  return {
    html: `
      <div class="page-header">
        <div>
          <h1 class="page-title">Tool Catalog & Discovery</h1>
          <p class="page-subtitle">Curated open-source AI tools, MCP servers, and skills mapped directly to workflow waste detectors.</p>
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
      document.querySelectorAll('.btn-copy-install').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          copyText(e.currentTarget.dataset.cmd, 'Install command copied');
        });
      });
      $('#btn-run-discover')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
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
          if (!res.ok) showToast(`Discovery error: ${data.error || res.statusText}`, 'error');
          else {
            showToast('GitHub discovery complete', 'success');
            render();
          }
        } catch (err) {
          showToast(`Network error: ${err.message}`, 'error');
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
  const pillClass = h.status === 'healthy' ? 'pill-active' : h.status === 'warning' ? 'pill-duplicate' : 'pill-unused';
  const badgeLabel = h.status ? h.status.toUpperCase() : 'HEALTHY';

  const warningsHtml =
    h.warnings && h.warnings.length > 0
      ? `<div class="banner-card banner-warn">
          <div>
            <strong style="color:var(--warn);font-size:13px">System Warnings (${h.warnings.length})</strong>
            <ul style="margin:6px 0 0 18px;padding:0;font-size:12.5px;color:var(--text-main)">
              ${h.warnings.map((w) => `<li style="margin:3px 0">${esc(w)}</li>`).join('')}
            </ul>
          </div>
        </div>`
      : '';

  const crossCheckHtml =
    h.crossCheck && h.crossCheck.length > 0
      ? `<div class="card" style="margin-top:var(--space-4)">
          <div class="card-header">
            <div>
              <h3 class="card-title">ccusage Daily Cross-Check</h3>
              <span class="card-subtitle">Daily token comparison against ccusage. Variance &gt; 5% triggers a drift warning.</span>
            </div>
          </div>
          ${table(
            [
              agentCol,
              { label: 'Date', get: (r) => r.date },
              { label: 'agentlens Tokens', num: true, get: (r) => fmtInt(r.agentlensTokens) },
              { label: 'ccusage Tokens', num: true, get: (r) => fmtInt(r.ccusageTokens) },
              { label: 'Variance', num: true, get: (r) => `${r.diffPct}%` },
              {
                label: 'Status',
                html: true,
                get: (r) =>
                  r.warning
                    ? '<span class="pill pill-unused">Drift &gt; 5%</span>'
                    : '<span class="pill pill-active">Verified</span>',
              },
            ],
            h.crossCheck,
          )}
        </div>`
      : `<div class="card" style="margin-top:var(--space-4)">
          <div class="card-header"><h3 class="card-title">ccusage Daily Cross-Check</h3></div>
          <p class="hint" style="margin:0">${h.ccusageAvailable === false ? 'The <code>ccusage</code> CLI binary was not detected in PATH. Install <code>npm i -g ccusage</code> to enable automatic daily cross-checking and Antigravity token ingestion.' : 'No cross-check drift data recorded for the last 7 days.'}</p>
        </div>`;

  return {
    html: `
      <div class="page-header">
        <div>
          <h1 class="page-title">
            System Health
            <span class="pill ${pillClass}">${esc(badgeLabel)}</span>
          </h1>
          <p class="page-subtitle">Ingestion pipeline status, SQLite cursor offsets, parser integrity, and daily cross-checks.</p>
        </div>
      </div>
      ${warningsHtml}
      <div class="grid-12">
        <div class="col-6 card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Log Sources</h3>
              <span class="card-subtitle">Tracked incremental file & database cursors</span>
            </div>
          </div>
          ${table([
            agentCol,
            { label: 'Files Tracked', num: true, get: (r) => r.files },
            { label: 'Parse Errors', num: true, get: (r) => r.badLines },
            { label: 'Last Ingest', get: (r) => fmtShortTime(r.lastIngest) },
          ], h.sources)}
        </div>

        <div class="col-6 card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Events Recorded</h3>
              <span class="card-subtitle">Total normalized turn & tool events in SQLite</span>
            </div>
          </div>
          ${table([
            agentCol,
            { label: 'Events', num: true, get: (r) => fmtInt(r.events) },
            { label: 'Latest Event', get: (r) => fmtShortTime(r.latestEvent) },
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
      <div class="page-header">
        <div>
          <h1 class="page-title">Settings</h1>
          <p class="page-subtitle">Configure dashboard appearance, desktop notifications, project budgets, and CLI automation permissions.</p>
        </div>
      </div>

      <div class="grid-12">
        <div class="col-6 card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Appearance & Interface</h3>
              <span class="card-subtitle">Customize theme and workspace layout</span>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:14px">
            <label style="display:flex;align-items:center;justify-content:space-between">
              <span style="font-weight:500">Color Theme</span>
              <select id="settings-theme" class="form-select">
                <option value="dark" ${theme === 'dark' ? 'selected' : ''}>Linear Dark (Default)</option>
                <option value="light" ${theme === 'light' ? 'selected' : ''}>Crisp Light</option>
              </select>
            </label>
            <label style="display:flex;align-items:center;justify-content:space-between">
              <span style="font-weight:500">Sidebar Mode</span>
              <button id="settings-toggle-sidebar" class="btn btn-xs btn-outline">Toggle Sidebar (<kbd>[</kbd>)</button>
            </label>
            <label style="display:flex;align-items:center;justify-content:space-between">
              <span style="font-weight:500">Keyboard Shortcuts</span>
              <button id="settings-show-shortcuts" class="btn btn-xs btn-outline">Open Reference (<kbd>?</kbd>)</button>
            </label>
          </div>
        </div>

        <div class="col-6 card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Agent CLI Automation (Opt-In)</h3>
              <span class="card-subtitle">Allow agentlens to dispatch fixes directly to local CLI agents</span>
            </div>
          </div>
          <div id="settings-agent-automation-section">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
              <input type="checkbox" id="chk-allow-agent-launch" ${allowAgentLaunch ? 'checked' : ''} />
              <span style="font-weight:600;color:var(--text)">Allow agentlens to launch agents (claude, codex, opencode)</span>
            </label>
            <p class="hint" style="margin-top:8px">When disabled, Fix Now actions only copy prompts to your clipboard. When enabled, you can confirm and dispatch fixes directly to your agent CLI.</p>
          </div>
        </div>

        <div class="col-6 card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Live Desktop Alerts</h3>
              <span class="card-subtitle">Native OS notifications during background serve</span>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:12px">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
              <input type="checkbox" id="chk-alert-retry" ${settings.alert_retry_loop !== 'false' ? 'checked' : ''} />
              <span>Alert when a retry loop is detected in an active session</span>
            </label>
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
              <input type="checkbox" id="chk-alert-quota" ${settings.alert_quota_forecast !== 'false' ? 'checked' : ''} />
              <span>Alert when rate-limit exhaustion is projected within 30 minutes</span>
            </label>
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
              <input type="checkbox" id="chk-alert-budget" ${settings.alert_budget !== 'false' ? 'checked' : ''} />
              <span>Alert when a project weekly budget crosses 80% or 100%</span>
            </label>
          </div>
        </div>

        <div class="col-6 card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Project Weekly Budgets</h3>
              <span class="card-subtitle">Set 7-day token and cost caps per repository</span>
            </div>
          </div>
          ${projectsList.length === 0 ? '<p class="hint">No projects discovered yet.</p>' : `
            <div style="display:flex;flex-direction:column;gap:10px;max-height:300px;overflow-y:auto;padding-right:4px">
              ${projectsList.map((pr) => `
                <div style="padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-elevated);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
                  <div>
                    <a href="#/project/${pr.projectId}" style="font-weight:600;font-size:13px;color:var(--text);text-decoration:none">${esc(pr.name)}</a>
                    <div style="font-size:11px;color:var(--text-muted)">Used: ${fmtTok(pr.tokens)}</div>
                  </div>
                  <div style="display:flex;gap:6px;align-items:center">
                    <input type="number" class="form-input setting-budget-tok" data-proj="${pr.projectId}" placeholder="Token cap" value="${pr.budgetTokens || ''}" style="width:120px;padding:4px 8px;font-size:12px" step="1000" />
                    <input type="number" class="form-input setting-budget-cost" data-proj="${pr.projectId}" placeholder="$ Cost" value="${pr.budgetCost || ''}" style="width:80px;padding:4px 8px;font-size:12px" step="1" />
                    <button class="btn btn-xs btn-save-proj-budget" data-proj="${pr.projectId}">Save</button>
                    ${pr.budgetTokens ? `<button class="btn btn-xs btn-outline btn-clear-proj-budget" data-proj="${pr.projectId}" style="color:var(--danger)">Clear</button>` : ''}
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
        showToast('Agent automation preference saved', 'success');
      });
      const saveAlertSetting = async (key, checked) => {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value: String(checked) }),
        });
        showToast('Alert preference updated', 'success');
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
          showToast('Project budget saved', 'success');
          render();
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
          showToast('Project budget cleared', 'success');
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

  document.querySelectorAll('#sidebar a[data-nav]').forEach((a) => {
    const navTarget = a.getAttribute('data-nav');
    const isActive = navTarget === name || (name === 'project' && navTarget === 'projects') || (name === 'session' && navTarget === 'sessions');
    if (isActive) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  const main = $('#main');
  main.setAttribute('aria-busy', 'true');

  const skeletonTimer = setTimeout(() => {
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
    updateNavBadges();
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
api('projects').then((ps) => {
  const fProj = $('#f-project');
  if (fProj && Array.isArray(ps)) {
    fProj.insertAdjacentHTML('beforeend', ps.map((p) => `<option value="${p.projectId}">${esc(p.name)}</option>`).join(''));
    if (state.project) fProj.value = state.project;
  }
}).catch(() => {});

updateQuotaPills();
updateNavBadges();
render();
