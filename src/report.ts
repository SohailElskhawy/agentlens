import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DB } from './db.ts';
import { costOf } from './pricing.ts';

const HOME = process.env.AGENTLENS_HOME || homedir();

export interface WeeklyReportData {
  week: string; // e.g. "2026-W42"
  generatedAt: number;
  startDate: string;
  endDate: string;
  summary: {
    totalTokens: number;
    tokensDeltaPct: number;
    totalCost: number;
    costDeltaPct: number;
    activeSessions: number;
    sessionsDeltaPct: number;
  };
  byAgent: Array<{
    agent: string;
    tokens: number;
    cost: number;
    sessions: number;
    deltaPct: number;
  }>;
  byProject: Array<{
    name: string;
    tokens: number;
    cost: number;
    sessions: number;
    deltaPct: number;
  }>;
  quotaInsights: {
    fiveHourPeakPct: number;
    sevenDayPeakPct: number;
    limitHits: number;
    topConsumers: Array<{ sessionId: string; agent: string; tokens: number }>;
  };
  topWastePatterns: Array<{
    rule: string;
    count: number;
    estTokensWeek: number;
    description: string;
  }>;
  recommendations: {
    newOpen: number;
    accepted: number;
    verified: number;
    regressed: number;
  };
  topActions: Array<{
    title: string;
    action: string;
    actionSnippet?: string;
    estSavingsTokens: number;
  }>;
}

export function getIsoWeekString(dateOrTs: Date | number = new Date()): string {
  const now = typeof dateOrTs === 'number' ? new Date(dateOrTs) : dateOrTs;
  const target = new Date(now.valueOf());
  const dayNr = (now.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay() + 7) % 7));
  }
  const week = 1 + Math.ceil((firstThursday - target.valueOf()) / 604_800_000);
  const year = target.getUTCFullYear();
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function getIsoWeekBounds(weekStr?: string): {
  week: string;
  startTs: number;
  endTs: number;
  prevStartTs: number;
  prevEndTs: number;
} {
  let year: number;
  let week: number;

  if (weekStr) {
    const match = weekStr.match(/^(\d{4})-W(\d{1,2})$/);
    if (!match) throw new Error(`Invalid ISO week format: ${weekStr}. Expected YYYY-Www (e.g. 2026-W42)`);
    year = Number.parseInt(match[1], 10);
    week = Number.parseInt(match[2], 10);
  } else {
    // Current or previous week based on current date
    const now = new Date();
    // Fourth day of the year is always in week 1
    const target = new Date(now.valueOf());
    const dayNr = (now.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNr + 3);
    const firstThursday = target.valueOf();
    target.setUTCMonth(0, 1);
    if (target.getUTCDay() !== 4) {
      target.setUTCMonth(0, 1 + ((4 - target.getUTCDay() + 7) % 7));
    }
    week = 1 + Math.ceil((firstThursday - target.valueOf()) / 604_800_000);
    year = target.getUTCFullYear();
  }

  // Calculate Monday 00:00:00 UTC of target ISO week
  // Jan 4th is always in week 1
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7; // Monday = 0
  const mondayWeek1 = new Date(jan4.getTime() - jan4Day * 86_400_000);
  mondayWeek1.setUTCHours(0, 0, 0, 0);

  const startTs = mondayWeek1.getTime() + (week - 1) * 7 * 86_400_000;
  const endTs = startTs + 7 * 86_400_000 - 1;

  const prevStartTs = startTs - 7 * 86_400_000;
  const prevEndTs = endTs - 7 * 86_400_000;

  const paddedWeek = String(week).padStart(2, '0');
  return {
    week: `${year}-W${paddedWeek}`,
    startTs,
    endTs,
    prevStartTs,
    prevEndTs,
  };
}

export function generateWeeklyReport(
  db: DB,
  weekStr?: string,
  home?: string
): {
  data: WeeklyReportData;
  markdown: string;
  html: string;
  filePathMd: string;
  filePathHtml: string;
} {
  const bounds = getIsoWeekBounds(weekStr);
  const reportsDir = join(home ?? HOME, '.local/share/agentlens/reports');
  mkdirSync(reportsDir, { recursive: true });

  // 1. Gather usage in current week
  const currEventRows = db.prepare(`
    SELECT
      e.agent,
      e.session_id AS sessionId,
      s.project_id AS projectId,
      p.name AS projectName,
      e.model,
      e.input,
      e.output,
      e.cache_read AS cacheRead,
      e.cache_write AS cacheWrite,
      e.cache_write_1h AS cacheWrite1h
    FROM events e
    LEFT JOIN sessions s ON s.id = e.session_id
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE e.kind = 'assistant' AND e.ts >= ? AND e.ts <= ?
  `).all(bounds.startTs, bounds.endTs) as any[];

  // 1b. Gather usage in previous week
  const prevEventRows = db.prepare(`
    SELECT
      e.agent,
      e.session_id AS sessionId,
      s.project_id AS projectId,
      e.model,
      e.input,
      e.output,
      e.cache_read AS cacheRead,
      e.cache_write AS cacheWrite,
      e.cache_write_1h AS cacheWrite1h
    FROM events e
    LEFT JOIN sessions s ON s.id = e.session_id
    WHERE e.kind = 'assistant' AND e.ts >= ? AND e.ts <= ?
  `).all(bounds.prevStartTs, bounds.prevEndTs) as any[];

  // Calculate current week totals
  let currTokens = 0;
  let currCost = 0;
  const currSessions = new Set<string>();
  const currByAgent = new Map<string, { tokens: number; cost: number; sessions: Set<string> }>();
  const currByProject = new Map<string, { tokens: number; cost: number; sessions: Set<string> }>();
  const sessionTokenMap = new Map<string, { agent: string; tokens: number }>();

  for (const r of currEventRows) {
    const tokens = (r.input || 0) + (r.output || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0);
    const cost = costOf(r.model, {
      input: r.input || 0,
      output: r.output || 0,
      cacheRead: r.cacheRead || 0,
      cacheWrite: r.cacheWrite || 0,
      cacheWrite1h: r.cacheWrite1h || 0,
    }) || 0;

    currTokens += tokens;
    currCost += cost;
    currSessions.add(r.sessionId);

    // Agent map
    const ag = currByAgent.get(r.agent) || { tokens: 0, cost: 0, sessions: new Set() };
    ag.tokens += tokens;
    ag.cost += cost;
    ag.sessions.add(r.sessionId);
    currByAgent.set(r.agent, ag);

    // Project map
    const proj = r.projectName || 'global / unassigned';
    const pr = currByProject.get(proj) || { tokens: 0, cost: 0, sessions: new Set() };
    pr.tokens += tokens;
    pr.cost += cost;
    pr.sessions.add(r.sessionId);
    currByProject.set(proj, pr);

    // Session consumer tracker
    const st = sessionTokenMap.get(r.sessionId) || { agent: r.agent, tokens: 0 };
    st.tokens += tokens;
    sessionTokenMap.set(r.sessionId, st);
  }

  // Calculate previous week totals
  let prevTokens = 0;
  let prevCost = 0;
  const prevSessions = new Set<string>();
  const prevByAgent = new Map<string, { tokens: number; cost: number; sessions: Set<string> }>();
  const prevByProject = new Map<string, { tokens: number; cost: number; sessions: Set<string> }>();

  for (const r of prevEventRows) {
    const tokens = (r.input || 0) + (r.output || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0);
    const cost = costOf(r.model, {
      input: r.input || 0,
      output: r.output || 0,
      cacheRead: r.cacheRead || 0,
      cacheWrite: r.cacheWrite || 0,
      cacheWrite1h: r.cacheWrite1h || 0,
    }) || 0;

    prevTokens += tokens;
    prevCost += cost;
    prevSessions.add(r.sessionId);

    const ag = prevByAgent.get(r.agent) || { tokens: 0, cost: 0, sessions: new Set() };
    ag.tokens += tokens;
    ag.cost += cost;
    ag.sessions.add(r.sessionId);
    prevByAgent.set(r.agent, ag);
  }

  const calcDelta = (curr: number, prev: number) => {
    if (prev <= 0) return 0;
    return Number((((curr - prev) / prev) * 100).toFixed(1));
  };

  const tokensDeltaPct = calcDelta(currTokens, prevTokens);
  const costDeltaPct = calcDelta(currCost, prevCost);
  const sessionsDeltaPct = calcDelta(currSessions.size, prevSessions.size);

  const byAgentList = Array.from(currByAgent.entries()).map(([agent, data]) => {
    const prev = prevByAgent.get(agent);
    return {
      agent,
      tokens: data.tokens,
      cost: Number(data.cost.toFixed(2)),
      sessions: data.sessions.size,
      deltaPct: calcDelta(data.tokens, prev?.tokens || 0),
    };
  }).sort((a, b) => b.tokens - a.tokens);

  const byProjectList = Array.from(currByProject.entries()).map(([name, data]) => {
    const prev = prevByProject.get(name);
    return {
      name,
      tokens: data.tokens,
      cost: Number(data.cost.toFixed(2)),
      sessions: data.sessions.size,
      deltaPct: calcDelta(data.tokens, prev?.tokens || 0),
    };
  }).sort((a, b) => b.tokens - a.tokens);

  // 2. Quota Insights
  const quotaRows = db.prepare(`
    SELECT agent, win, used_pct, ts
    FROM quota_snapshots
    WHERE ts >= ? AND ts <= ?
  `).all(bounds.startTs, bounds.endTs) as any[];

  let fiveHourPeakPct = 0;
  let sevenDayPeakPct = 0;
  let limitHits = 0;

  for (const q of quotaRows) {
    if (q.win === '5h') fiveHourPeakPct = Math.max(fiveHourPeakPct, q.used_pct);
    if (q.win === '7d') sevenDayPeakPct = Math.max(sevenDayPeakPct, q.used_pct);
    if (q.used_pct >= 100) limitHits++;
  }

  const topConsumers = Array.from(sessionTokenMap.entries())
    .map(([sessionId, val]) => ({ sessionId, agent: val.agent, tokens: val.tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

  // 3. Top Waste Patterns (Findings)
  const findingRows = db.prepare(`
    SELECT rule, count(*) as count, sum(est_tokens_week) as estTokensWeek, confidence_reason as description
    FROM findings
    WHERE last_seen >= ? AND last_seen <= ?
    GROUP BY rule
    ORDER BY estTokensWeek DESC
  `).all(bounds.startTs, bounds.endTs) as any[];

  const topWastePatterns = findingRows.map((f) => ({
    rule: f.rule,
    count: f.count,
    estTokensWeek: f.estTokensWeek || 0,
    description: f.description || f.rule,
  }));

  // 4. Recommendations Status
  const recsRows = db.prepare(`
    SELECT status, count(*) as count
    FROM recommendations
    GROUP BY status
  `).all() as any[];

  const recCounts: Record<string, number> = {};
  for (const r of recsRows) recCounts[r.status] = r.count;

  // 5. Top 3 Actions for Next Week
  const topActionRows = db.prepare(`
    SELECT r.title, r.action, r.action_snippet as actionSnippet, f.est_tokens_week as estSavingsTokens
    FROM recommendations r
    LEFT JOIN findings f ON f.rule = r.finding_rule
    WHERE r.status = 'open'
    ORDER BY r.score DESC, r.id ASC
    LIMIT 3
  `).all() as any[];

  const topActions = topActionRows.map((r) => ({
    title: r.title,
    action: r.action,
    actionSnippet: r.actionSnippet || undefined,
    estSavingsTokens: r.estSavingsTokens || 0,
  }));

  const data: WeeklyReportData = {
    week: bounds.week,
    generatedAt: Date.now(),
    startDate: new Date(bounds.startTs).toISOString().slice(0, 10),
    endDate: new Date(bounds.endTs).toISOString().slice(0, 10),
    summary: {
      totalTokens: currTokens,
      tokensDeltaPct,
      totalCost: Number(currCost.toFixed(2)),
      costDeltaPct,
      activeSessions: currSessions.size,
      sessionsDeltaPct,
    },
    byAgent: byAgentList,
    byProject: byProjectList,
    quotaInsights: {
      fiveHourPeakPct,
      sevenDayPeakPct,
      limitHits,
      topConsumers,
    },
    topWastePatterns,
    recommendations: {
      newOpen: recCounts['open'] || 0,
      accepted: recCounts['accepted'] || 0,
      verified: recCounts['verified'] || 0,
      regressed: recCounts['regressed'] || 0,
    },
    topActions,
  };

  const markdown = renderMarkdown(data);
  const html = renderHtml(data, markdown);

  const filePathMd = join(reportsDir, `${bounds.week}.md`);
  const filePathHtml = join(reportsDir, `${bounds.week}.html`);

  writeFileSync(filePathMd, markdown, 'utf-8');
  writeFileSync(filePathHtml, html, 'utf-8');

  return { data, markdown, html, filePathMd, filePathHtml };
}

function fmtTok(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString();
}

function fmtDelta(d: number): string {
  if (d === 0) return '0%';
  return d > 0 ? `+${d}%` : `${d}%`;
}

function renderMarkdown(d: WeeklyReportData): string {
  const lines: string[] = [];
  lines.push(`# agentlens Weekly Usage Report: ${d.week}`);
  lines.push(`> Period: ${d.startDate} to ${d.endDate} · Generated: ${new Date(d.generatedAt).toLocaleString()}`);
  lines.push('');

  // Overview Summary Table
  lines.push(`| Metric | Value (measured) | WoW Delta |`);
  lines.push(`|---|---|---|`);
  lines.push(`| Total Tokens | ${fmtTok(d.summary.totalTokens)} | ${fmtDelta(d.summary.tokensDeltaPct)} |`);
  lines.push(`| Estimated API Cost | $${d.summary.totalCost.toFixed(2)} | ${fmtDelta(d.summary.costDeltaPct)} |`);
  lines.push(`| Active Sessions | ${d.summary.activeSessions} | ${fmtDelta(d.summary.sessionsDeltaPct)} |`);
  lines.push('');

  // Section 1
  lines.push(`## 1. Week-over-Week Trends`);
  lines.push(`### By Agent`);
  if (d.byAgent.length === 0) {
    lines.push(`*No agent sessions recorded this week.*`);
  } else {
    lines.push(`| Agent | Tokens (measured) | Est. Cost | Sessions | WoW Change |`);
    lines.push(`|---|---|---|---|---|`);
    for (const a of d.byAgent) {
      lines.push(`| ${a.agent} | ${fmtTok(a.tokens)} | $${a.cost.toFixed(2)} | ${a.sessions} | ${fmtDelta(a.deltaPct)} |`);
    }
  }
  lines.push('');

  lines.push(`### By Project`);
  if (d.byProject.length === 0) {
    lines.push(`*No project sessions recorded this week.*`);
  } else {
    lines.push(`| Project | Tokens (measured) | Est. Cost | Sessions | WoW Change |`);
    lines.push(`|---|---|---|---|---|`);
    for (const p of d.byProject) {
      lines.push(`| ${p.name} | ${fmtTok(p.tokens)} | $${p.cost.toFixed(2)} | ${p.sessions} | ${fmtDelta(p.deltaPct)} |`);
    }
  }
  lines.push('');

  // Section 2
  lines.push(`## 2. Quota Near-Misses & Limit Hits`);
  lines.push(`- **5-Hour Window Peak:** ${d.quotaInsights.fiveHourPeakPct}%`);
  lines.push(`- **7-Day Window Peak:** ${d.quotaInsights.sevenDayPeakPct}%`);
  lines.push(`- **Limit Hits Recorded:** ${d.quotaInsights.limitHits}`);
  if (d.quotaInsights.topConsumers.length > 0) {
    lines.push('');
    lines.push(`**Top Consumer Sessions in Quota Windows:**`);
    for (const s of d.quotaInsights.topConsumers) {
      lines.push(`- \`${s.sessionId}\` (${s.agent}): ${fmtTok(s.tokens)} tokens`);
    }
  }
  lines.push('');

  // Section 3
  lines.push(`## 3. Biggest Token-Wasting Patterns`);
  if (d.topWastePatterns.length === 0) {
    lines.push(`*No token-wasting patterns detected this week. Workflows were efficient!*`);
  } else {
    lines.push(`| Pattern Rule | Occurrences | Est. Weekly Waste | Description |`);
    lines.push(`|---|---|---|---|`);
    for (const w of d.topWastePatterns) {
      lines.push(`| \`${w.rule}\` | ${w.count} | ~${fmtTok(w.estTokensWeek)} tokens | ${w.description} |`);
    }
  }
  lines.push('');

  // Section 4
  lines.push(`## 4. Recommendation Status`);
  lines.push(`- **Open Opportunities:** ${d.recommendations.newOpen}`);
  lines.push(`- **Currently Tracking / Measuring:** ${d.recommendations.accepted}`);
  lines.push(`- **Verified Savings:** ${d.recommendations.verified}`);
  lines.push(`- **Regressions / Blocked:** ${d.recommendations.regressed}`);
  lines.push('');

  // Section 5
  lines.push(`## 5. Tool Picks & Optimizations`);
  lines.push(`- **Fast In-Process Compaction:** Port hot context into skills or rules to avoid re-sending large repetitive files.`);
  lines.push(`- **Targeted Model Selection:** Reserve flagship Opus/Sonnet 3.5 models for planning and architecture; use lighter models for small single-turn edits.`);
  lines.push('');

  // Section 6
  lines.push(`## 6. Top Three Actions for Next Week`);
  if (d.topActions.length === 0) {
    lines.push(`*No pending high-priority actions. Check back next week!*`);
  } else {
    for (let i = 0; i < d.topActions.length; i++) {
      const act = d.topActions[i];
      lines.push(`### ${i + 1}. ${act.title}`);
      lines.push(`- **Action:** \`${act.action}\``);
      if (act.actionSnippet) lines.push(`- **Suggested Command:** \`${act.actionSnippet}\``);
      if (act.estSavingsTokens > 0) lines.push(`- **Est. Potential Savings:** ~${fmtTok(act.estSavingsTokens)} tokens/week`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function renderHtml(d: WeeklyReportData, md: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>agentlens Weekly Report: ${d.week}</title>
  <style>
    :root {
      --bg: #0e1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-dim: #8b949e;
      --accent: #58a6ff;
      --success: #3fb950;
      --warning: #d29922;
      --danger: #f85149;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f6f8fa;
        --card-bg: #ffffff;
        --border: #d0d7de;
        --text: #24292f;
        --text-dim: #57606a;
        --accent: #0969da;
        --success: #1a7f37;
        --warning: #9a6700;
        --danger: #cf222e;
      }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      max-width: 900px;
      margin: 0 auto;
      padding: 32px 16px;
    }
    h1, h2, h3 { color: var(--text); }
    h1 { border-bottom: 1px solid var(--border); padding-bottom: 12px; }
    h2 { margin-top: 32px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
    }
    .badge-positive { background: rgba(63, 185, 80, 0.15); color: var(--success); }
    .badge-negative { background: rgba(248, 81, 73, 0.15); color: var(--danger); }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
    }
    th, td {
      padding: 10px 14px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    th { background: rgba(0,0,0,0.05); color: var(--text-dim); font-size: 13px; }
    code {
      background: rgba(127,127,127,0.15);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 85%;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin: 20px 0;
    }
    .tile {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
    }
    .tile-val { font-size: 24px; font-weight: bold; margin: 4px 0; }
    .tile-lbl { color: var(--text-dim); font-size: 13px; }
  </style>
</head>
<body>
  <h1>agentlens Weekly Usage Report</h1>
  <p style="color: var(--text-dim);">Period: <strong>${d.startDate}</strong> to <strong>${d.endDate}</strong> (${d.week})</p>

  <div class="grid">
    <div class="tile">
      <div class="tile-lbl">Tokens (measured)</div>
      <div class="tile-val">${fmtTok(d.summary.totalTokens)}</div>
      <div class="tile-lbl">${fmtDelta(d.summary.tokensDeltaPct)} vs prev week</div>
    </div>
    <div class="tile">
      <div class="tile-lbl">API-equivalent cost (estimated)</div>
      <div class="tile-val">$${d.summary.totalCost.toFixed(2)}</div>
      <div class="tile-lbl">${fmtDelta(d.summary.costDeltaPct)} vs prev week</div>
    </div>
    <div class="tile">
      <div class="tile-lbl">Active Sessions</div>
      <div class="tile-val">${d.summary.activeSessions}</div>
      <div class="tile-lbl">${fmtDelta(d.summary.sessionsDeltaPct)} vs prev week</div>
    </div>
    <div class="tile">
      <div class="tile-lbl">5h Peak Quota</div>
      <div class="tile-val">${d.quotaInsights.fiveHourPeakPct}%</div>
      <div class="tile-lbl">${d.quotaInsights.limitHits} limit hits</div>
    </div>
  </div>

  <h2>1. Week-over-Week Trends</h2>
  <table>
    <thead><tr><th>Agent</th><th>Tokens</th><th>Est. Cost</th><th>Sessions</th><th>WoW</th></tr></thead>
    <tbody>
      ${d.byAgent.map((a) => `<tr><td><strong>${a.agent}</strong></td><td>${fmtTok(a.tokens)}</td><td>$${a.cost.toFixed(2)}</td><td>${a.sessions}</td><td>${fmtDelta(a.deltaPct)}</td></tr>`).join('')}
    </tbody>
  </table>

  <h2>2. Quota Near-Misses & Limit Hits</h2>
  <div class="card">
    <p>5-Hour Peak: <strong>${d.quotaInsights.fiveHourPeakPct}%</strong> · 7-Day Peak: <strong>${d.quotaInsights.sevenDayPeakPct}%</strong> · Limit Hits: <strong>${d.quotaInsights.limitHits}</strong></p>
    ${d.quotaInsights.topConsumers.length > 0 ? `
      <h4>Top Consumers in Window:</h4>
      <ul>${d.quotaInsights.topConsumers.map((c) => `<li><code>${c.sessionId}</code> (${c.agent}) — ${fmtTok(c.tokens)} tokens</li>`).join('')}</ul>
    ` : ''}
  </div>

  <h2>3. Biggest Token-Wasting Patterns</h2>
  ${d.topWastePatterns.length > 0 ? `
    <table>
      <thead><tr><th>Rule</th><th>Count</th><th>Est. Weekly Waste</th><th>Description</th></tr></thead>
      <tbody>
        ${d.topWastePatterns.map((w) => `<tr><td><code>${w.rule}</code></td><td>${w.count}</td><td>~${fmtTok(w.estTokensWeek)}</td><td>${w.description}</td></tr>`).join('')}
      </tbody>
    </table>
  ` : '<p>No token-wasting patterns detected this week.</p>'}

  <h2>4. Recommendation Status</h2>
  <div class="card">
    <p>Open: <strong>${d.recommendations.newOpen}</strong> · Measuring: <strong>${d.recommendations.accepted}</strong> · Verified: <strong>${d.recommendations.verified}</strong> · Regressed: <strong>${d.recommendations.regressed}</strong></p>
  </div>

  <h2>5. Top Three Actions for Next Week</h2>
  ${d.topActions.map((act, i) => `
    <div class="card">
      <h3>${i + 1}. ${act.title}</h3>
      <p>Action: <code>${act.action}</code> ${act.estSavingsTokens > 0 ? `· Est. Savings: <strong>~${fmtTok(act.estSavingsTokens)} tokens/week</strong>` : ''}</p>
      ${act.actionSnippet ? `<pre><code>${act.actionSnippet}</code></pre>` : ''}
    </div>
  `).join('')}
</body>
</html>`;
}
