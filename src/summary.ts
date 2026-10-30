import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DB } from './db.ts';
import { getRecommendations, insertQuotas, tx } from './db.ts';
import { detectAnomalies, formatLocalDay, type AnomalyResult } from './anomaly.ts';
import { generateFixPrompt } from './fix-prompts.ts';
import { costOf } from './pricing.ts';
import { projectName, projectRoot } from './project.ts';
import type { QuotaSnapshot } from './types.ts';
import { computeQuotaForecasts, type QuotaForecastResult } from './quota-forecast.ts';
import { aiStatus } from './ai/gate.ts';
import { cachedRecommendations } from './ai/recommendations.ts';
import { parseExplanation } from './ai/explain.ts';
import { parseDiagnosis } from './ai/diagnose.ts';

export interface ProjectSummary {
  projectId: number;
  root: string;
  name: string;
  tokensToday: number;
  costToday?: number;
  contextWarning?: string;
}

export interface SummaryRecommendation {
  id: string;
  rule: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  action: string;
  estTokensSavedWeek: number;
  projectId?: number;
  projectName: string;
  prompt: string;
}

export interface SummaryAgentToday {
  agent: string;
  tokens: number;
  cost: number;
  sessions: number;
}

export interface SummaryLiveAlert {
  id: string;
  rule: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  projectName: string | null;
  wastedTokens: number;
  detectedAt: number;
}

export interface SummaryDailyBucket {
  day: string;
  tokens: number;
  cost: number;
}

export interface SummaryModelRow {
  model: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cost: number;
}

export interface SummaryProjectBudget {
  projectId: number;
  name: string;
  path: string;
  tokensToday: number;
  costToday: number;
  weeklyTokenBudget: number | null;
  weeklyTokensUsed: number;
  budgetUsedPct: number | null;
}

export interface SummaryData {
  updatedAt: number;
  totals: {
    tokensToday: number;
    costToday: number;
    burnRateTokensPerHour: number;
    activeSessions: number;
  };
  projects: Record<string, ProjectSummary>;
  quotas: {
    claude?: { '5h'?: number; '7d'?: number };
    codex?: { '5h'?: number; '7d'?: number };
  };
  forecasts?: QuotaForecastResult[];
  statuslineForecast?: string;
  topRecommendation?: SummaryRecommendation | null;
  topInsight?: string | null;
  recommendations?: SummaryRecommendation[];
  byAgentToday?: SummaryAgentToday[];
  liveAlerts?: SummaryLiveAlert[];
  daily7d?: SummaryDailyBucket[];
  topModels?: SummaryModelRow[];
  projectList?: SummaryProjectBudget[];
  anomalies?: AnomalyResult;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function spoolQuota(spoolPath: string, stdinJson: string): void {
  try {
    const data = JSON.parse(stdinJson);
    const rl = data?.rate_limits;
    if (!rl) return;

    mkdirSync(dirname(spoolPath), { recursive: true });
    const now = Date.now();
    const snapshots: QuotaSnapshot[] = [];

    if (rl.five_hour && typeof rl.five_hour.used_percentage === 'number') {
      const resets = rl.five_hour.resets_at;
      const resetsAt = typeof resets === 'number' ? resets : new Date(resets).getTime();
      snapshots.push({
        agent: 'claude',
        ts: now,
        window: '5h',
        usedPct: rl.five_hour.used_percentage,
        resetsAt: Number.isNaN(resetsAt) ? now + 5 * 3600_000 : resetsAt,
        source: 'claude-statusline',
      });
    }

    if (rl.seven_day && typeof rl.seven_day.used_percentage === 'number') {
      const resets = rl.seven_day.resets_at;
      const resetsAt = typeof resets === 'number' ? resets : new Date(resets).getTime();
      snapshots.push({
        agent: 'claude',
        ts: now,
        window: '7d',
        usedPct: rl.seven_day.used_percentage,
        resetsAt: Number.isNaN(resetsAt) ? now + 7 * 86400_000 : resetsAt,
        source: 'claude-statusline',
      });
    }

    if (snapshots.length > 0) {
      appendFileSync(spoolPath, snapshots.map((s) => JSON.stringify(s) + '\n').join(''));
    }
  } catch {
    // Malformed JSON or invalid rate_limits payload ignored safely
  }
}

export function drainQuotaSpool(db: DB, spoolPath: string): void {
  if (!existsSync(spoolPath)) return;
  const stagingPath = `${spoolPath}.drain.${process.pid}.${Date.now()}`;
  try {
    renameSync(spoolPath, stagingPath);
  } catch {
    return;
  }

  let content = '';
  try {
    content = readFileSync(stagingPath, 'utf8');
  } catch {
    try { unlinkSync(stagingPath); } catch {}
    return;
  }
  if (!content.trim()) {
    try { unlinkSync(stagingPath); } catch {}
    return;
  }

  const snapshots: QuotaSnapshot[] = [];
  const lines = content.split('\n');
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      snapshots.push(JSON.parse(l));
    } catch {}
  }

  if (snapshots.length > 0) {
    tx(db, () => insertQuotas(db, snapshots));
  }

  try {
    unlinkSync(stagingPath);
  } catch {}
}

export function writeSummary(db: DB, targetPath: string): void {
  const now = Date.now();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const startOfToday = midnight.getTime();

  const startOf7dDate = new Date(midnight.getTime());
  startOf7dDate.setDate(startOf7dDate.getDate() - 6);
  const startOf7d = startOf7dDate.getTime();

  const projectRows = db.prepare(`
    SELECT coalesce(s.project_id, 0) AS projectId,
           coalesce(p.root, '') AS root,
           coalesce(p.name, 'unknown') AS name,
           e.model AS model,
           coalesce(sum(e.input), 0) AS input,
           coalesce(sum(e.output), 0) AS output,
           coalesce(sum(e.cache_read), 0) AS cacheRead,
           coalesce(sum(e.cache_write), 0) AS cacheWrite,
           coalesce(sum(e.cache_write_1h), 0) AS cacheWrite1h
    FROM events e
    JOIN sessions s ON s.id = e.session_id
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE e.ts >= ?
    GROUP BY s.project_id, e.model
  `).all(startOfToday) as {
    projectId: number;
    root: string;
    name: string;
    model: string | null;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h: number;
  }[];

  let totalTokensToday = 0;
  let totalCostToday = 0;
  const projectsRaw: Record<string, { projectId: number; root: string; name: string; tokensToday: number; costTodayRaw: number }> = {};
  for (const r of projectRows) {
    const tokens = r.input + r.output + r.cacheRead + r.cacheWrite;
    const cost = costOf(r.model ?? undefined, {
      input: r.input,
      output: r.output,
      cacheRead: r.cacheRead,
      cacheWrite: r.cacheWrite,
      cacheWrite1h: r.cacheWrite1h,
    }) ?? 0;
    totalTokensToday += tokens;
    totalCostToday += cost;
    if (r.root) {
      const existing = projectsRaw[r.root];
      if (existing) {
        existing.tokensToday += tokens;
        existing.costTodayRaw += cost;
      } else {
        projectsRaw[r.root] = {
          projectId: r.projectId,
          root: r.root,
          name: r.name,
          tokensToday: tokens,
          costTodayRaw: cost,
        };
      }
    }
  }

  const projects: Record<string, ProjectSummary> = {};
  for (const [rootKey, p] of Object.entries(projectsRaw)) {
    projects[rootKey] = {
      projectId: p.projectId,
      root: p.root,
      name: p.name,
      tokensToday: p.tokensToday,
      costToday: Number(p.costTodayRaw.toFixed(4)),
    };
  }

  const activeSessions = db.prepare(`
    SELECT DISTINCT s.id AS sessionId, p.id AS projectId, p.root AS root, p.name AS name
    FROM events e
    JOIN sessions s ON s.id = e.session_id
    JOIN projects p ON p.id = s.project_id
    WHERE e.ts >= ? AND p.root IS NOT NULL AND p.root != ''
  `).all(now - 900_000) as { sessionId: string; projectId: number; root: string; name: string }[];

  const turnStmt = db.prepare(`
    SELECT (input + cache_read + cache_write) AS contextSize
    FROM events
    WHERE session_id = ? AND kind = 'assistant'
    ORDER BY ts DESC, id DESC
    LIMIT 2
  `);

  for (const session of activeSessions) {
    const turns = turnStmt.all(session.sessionId) as { contextSize: number }[];
    if (turns.length === 2 && turns[0].contextSize >= 120_000 && (turns[0].contextSize - turns[1].contextSize) >= 20_000) {
      const rootKey = session.root;
      if (projects[rootKey]) {
        projects[rootKey].contextWarning = '[COMPACT RECOMMENDED]';
      } else {
        projects[rootKey] = {
          projectId: session.projectId,
          root: rootKey,
          name: session.name,
          tokensToday: 0,
          costToday: 0,
          contextWarning: '[COMPACT RECOMMENDED]',
        };
      }
    }
  }

  // Active agents today
  const agentModelRows = db.prepare(`
    SELECT e.agent AS agent,
           e.model AS model,
           coalesce(sum(e.input), 0) AS input,
           coalesce(sum(e.output), 0) AS output,
           coalesce(sum(e.cache_read), 0) AS cacheRead,
           coalesce(sum(e.cache_write), 0) AS cacheWrite,
           coalesce(sum(e.cache_write_1h), 0) AS cacheWrite1h
    FROM events e
    WHERE e.ts >= ?
    GROUP BY e.agent, e.model
  `).all(startOfToday) as {
    agent: string;
    model: string | null;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h: number;
  }[];

  const agentSessionRows = db.prepare(`
    SELECT agent, count(DISTINCT session_id) AS sessions
    FROM events
    WHERE ts >= ?
    GROUP BY agent
  `).all(startOfToday) as { agent: string; sessions: number }[];
  const sessionsByAgent = new Map<string, number>();
  for (const r of agentSessionRows) sessionsByAgent.set(r.agent, r.sessions);

  const agentTotalsMap = new Map<string, { tokens: number; cost: number }>();
  for (const r of agentModelRows) {
    const tokens = r.input + r.output + r.cacheRead + r.cacheWrite;
    const cost = costOf(r.model ?? undefined, {
      input: r.input,
      output: r.output,
      cacheRead: r.cacheRead,
      cacheWrite: r.cacheWrite,
      cacheWrite1h: r.cacheWrite1h,
    }) ?? 0;
    const cur = agentTotalsMap.get(r.agent) ?? { tokens: 0, cost: 0 };
    cur.tokens += tokens;
    cur.cost += cost;
    agentTotalsMap.set(r.agent, cur);
  }

  const byAgentToday: SummaryAgentToday[] = Array.from(agentTotalsMap.entries())
    .filter(([, v]) => v.tokens > 0)
    .map(([agent, v]) => ({
      agent,
      tokens: v.tokens,
      cost: Number(v.cost.toFixed(4)),
      sessions: sessionsByAgent.get(agent) ?? 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const burnRow = db.prepare(`
    SELECT coalesce(sum(input + output + cache_read + cache_write), 0) AS tokensLastHour
    FROM events
    WHERE ts >= ?
  `).get(now - 3600_000) as { tokensLastHour: number } | undefined;

  const activeRow = db.prepare(`
    SELECT count(DISTINCT session_id) AS activeSessions
    FROM events
    WHERE ts >= ?
  `).get(now - 900_000) as { activeSessions: number } | undefined;

  const quotaRows = db.prepare(`
    SELECT agent, win, used_pct AS usedPct
    FROM quota_snapshots q
    WHERE ts = (SELECT max(ts) FROM quota_snapshots WHERE agent = q.agent AND win = q.win)
  `).all() as { agent: string; win: '5h' | '7d'; usedPct: number }[];

  const quotas: SummaryData['quotas'] = {};
  for (const q of quotaRows) {
    const a = q.agent as 'claude' | 'codex';
    quotas[a] ??= {};
    quotas[a]![q.win] = q.usedPct;
  }

  const forecasts = computeQuotaForecasts(db);
  const activeExhaustion = forecasts.find((f) => f.willExhaustBeforeReset && f.message);
  const statuslineForecast = activeExhaustion?.message;

  // Top 5 open recommendations
  const recRows = db.prepare(`
    SELECT r.id,
           r.finding_rule AS findingRule,
           r.project_id AS projectId,
           r.action,
           r.title,
           r.body,
           r.score,
           coalesce(p.name, 'global') AS projectName,
           coalesce(p.root, '') AS projectRoot
    FROM recommendations r
    LEFT JOIN projects p ON p.id = r.project_id
    WHERE r.status = 'open'
    ORDER BY r.score DESC, r.id ASC
    LIMIT 5
  `).all() as {
    id: string;
    findingRule: string;
    projectId: number | null;
    action: string;
    title: string;
    body: string;
    score: number;
    projectName: string;
    projectRoot: string;
  }[];

  const findFindingStmt = db.prepare(`
    SELECT evidence, coalesce(est_tokens_week, 0) AS estTokensWeek
    FROM findings
    WHERE rule = ? AND (project_id IS ? OR (? IS NULL AND project_id IS NULL))
    ORDER BY est_tokens_week DESC, last_seen DESC
    LIMIT 1
  `);

  const recommendations: SummaryRecommendation[] = recRows.map((recRow) => {
    const findingRow = findFindingStmt.get(recRow.findingRule, recRow.projectId, recRow.projectId) as
      | { evidence: string; estTokensWeek: number }
      | undefined;

    let evidence: Record<string, any> = {};
    if (findingRow?.evidence) {
      try {
        evidence = JSON.parse(findingRow.evidence);
      } catch {}
    }

    const severity: 'high' | 'medium' | 'low' =
      recRow.score >= 80 ? 'high' : recRow.score >= 50 ? 'medium' : 'low';

    return {
      id: recRow.id,
      rule: recRow.findingRule,
      severity,
      title: recRow.title,
      action: recRow.body || recRow.action,
      estTokensSavedWeek: findingRow?.estTokensWeek ?? 0,
      projectId: recRow.projectId ?? undefined,
      projectName: recRow.projectName,
      prompt: generateFixPrompt({
        rule: recRow.findingRule,
        title: recRow.title,
        projectName: recRow.projectName,
        projectRoot: recRow.projectRoot,
        evidence,
      }),
    };
  });

  const topRecommendation: SummaryRecommendation | null = recommendations[0] ?? null;

  // Live alerts: findings seen in the last 30 minutes
  const alertRows = db.prepare(`
    SELECT f.id,
           f.rule,
           f.confidence,
           f.confidence_reason AS confidenceReason,
           coalesce(f.est_tokens_week, 0) AS estTokensWeek,
           f.last_seen AS lastSeen,
           p.name AS projectName
    FROM findings f
    LEFT JOIN projects p ON p.id = f.project_id
    WHERE f.last_seen >= ?
    ORDER BY f.est_tokens_week DESC, f.last_seen DESC
    LIMIT 3
  `).all(now - 30 * 60_000) as {
    id: string;
    rule: string;
    confidence: string;
    confidenceReason: string;
    estTokensWeek: number;
    lastSeen: number;
    projectName: string | null;
  }[];

  const liveAlerts: SummaryLiveAlert[] = alertRows.map((a) => ({
    id: a.id,
    rule: a.rule,
    severity: a.confidence === 'high' ? 'high' : a.confidence === 'medium' ? 'medium' : 'low',
    title: a.rule.replace(/_/g, ' '),
    detail: a.confidenceReason || '',
    projectName: a.projectName ?? null,
    wastedTokens: a.estTokensWeek,
    detectedAt: a.lastSeen,
  }));

  // 7-day daily buckets & top models
  const dayBucketsMap = new Map<string, { tokens: number; cost: number }>();
  for (let i = 0; i < 7; i++) {
    const d = new Date(startOf7dDate.getTime());
    d.setDate(d.getDate() + i);
    dayBucketsMap.set(formatLocalDay(d), { tokens: 0, cost: 0 });
  }

  const dailyModelRows = db.prepare(`
    SELECT date(e.ts/1000, 'unixepoch', 'localtime') AS day,
           e.model AS model,
           coalesce(sum(e.input), 0) AS input,
           coalesce(sum(e.output), 0) AS output,
           coalesce(sum(e.cache_read), 0) AS cacheRead,
           coalesce(sum(e.cache_write), 0) AS cacheWrite,
           coalesce(sum(e.cache_write_1h), 0) AS cacheWrite1h
    FROM events e
    WHERE e.kind = 'assistant' AND e.ts >= ?
    GROUP BY day, e.model
  `).all(startOf7d) as {
    day: string;
    model: string | null;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h: number;
  }[];

  const modelAggMap = new Map<string, { tokens: number; inputTokens: number; outputTokens: number; cacheTokens: number; cost: number }>();
  for (const r of dailyModelRows) {
    const tokens = r.input + r.output + r.cacheRead + r.cacheWrite;
    if (tokens <= 0) continue;
    const cost = costOf(r.model ?? undefined, {
      input: r.input,
      output: r.output,
      cacheRead: r.cacheRead,
      cacheWrite: r.cacheWrite,
      cacheWrite1h: r.cacheWrite1h,
    }) ?? 0;

    const dayBucket = dayBucketsMap.get(r.day);
    if (dayBucket) {
      dayBucket.tokens += tokens;
      dayBucket.cost += cost;
    }

    const modelName = r.model || 'unknown';
    const mCur = modelAggMap.get(modelName) ?? { tokens: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: 0 };
    mCur.tokens += tokens;
    mCur.inputTokens += r.input;
    mCur.outputTokens += r.output;
    mCur.cacheTokens += r.cacheRead + r.cacheWrite;
    mCur.cost += cost;
    modelAggMap.set(modelName, mCur);
  }

  const daily7d: SummaryDailyBucket[] = Array.from(dayBucketsMap.entries()).map(([day, b]) => ({
    day,
    tokens: b.tokens,
    cost: Number(b.cost.toFixed(4)),
  }));

  const topModels: SummaryModelRow[] = Array.from(modelAggMap.entries())
    .map(([model, m]) => ({
      model,
      tokens: m.tokens,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheTokens: m.cacheTokens,
      cost: Number(m.cost.toFixed(4)),
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

  // Project list with weekly budgets
  const settingsRows = db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'budget_tokens_%'`).all() as Array<{ key: string; value: string }>;
  const tokenBudgets = new Map<number, number>();
  for (const s of settingsRows) {
    const pid = Number(s.key.replace('budget_tokens_', ''));
    const limit = Number(s.value);
    if (pid > 0 && limit > 0) tokenBudgets.set(pid, limit);
  }

  const weeklyProjRows = db.prepare(`
    SELECT p.id AS projectId,
           p.name AS name,
           p.root AS root,
           coalesce(sum(e.input + e.output + e.cache_read + e.cache_write), 0) AS weeklyTokens
    FROM projects p
    LEFT JOIN sessions s ON s.project_id = p.id
    LEFT JOIN events e ON e.session_id = s.id AND e.ts >= ?
    GROUP BY p.id
  `).all(startOf7d) as { projectId: number; name: string; root: string; weeklyTokens: number }[];

  const projectList: SummaryProjectBudget[] = weeklyProjRows
    .map((wp) => {
      const todayEntry = projects[wp.root];
      const weeklyBudget = tokenBudgets.get(wp.projectId) ?? null;
      const budgetUsedPct = weeklyBudget ? Math.round((wp.weeklyTokens / weeklyBudget) * 100) : null;
      return {
        projectId: wp.projectId,
        name: wp.name,
        path: wp.root,
        tokensToday: todayEntry?.tokensToday ?? 0,
        costToday: todayEntry?.costToday ?? 0,
        weeklyTokenBudget: weeklyBudget,
        weeklyTokensUsed: wp.weeklyTokens,
        budgetUsedPct,
      };
    })
    .filter((p) => p.tokensToday > 0 || p.weeklyTokensUsed > 0 || p.weeklyTokenBudget !== null)
    .sort((a, b) => b.tokensToday - a.tokensToday || b.weeklyTokensUsed - a.weeklyTokensUsed)
    .slice(0, 5);

  const anomalies = detectAnomalies(db, {}, now);

  let topInsight: string | null = null;
  const status = aiStatus(db, now);
  if (status.enabled && !status.error && status.agent) {
    if (recRows[0]) {
      const enriched = cachedRecommendations(db, getRecommendations(db), 5);
      const match = enriched.find((r) => r.id === recRows[0].id);
      if (match?.aiBody && typeof match.aiBody === 'string' && match.aiBody.trim().length > 0) {
        topInsight = match.aiBody.trim();
      }
    }

    if (!topInsight) {
      const agent = status.agent === 'auto' ? 'claude' : status.agent;
      const model = status.model ?? '';
      const cachedNotes = db.prepare(`
        SELECT kind, text
        FROM ai_notes
        WHERE agent = ? AND model = ? AND kind IN ('explain', 'diagnose')
        ORDER BY created_at DESC, rowid DESC
        LIMIT 10
      `).all(agent, model) as { kind: string; text: string }[];

      for (const row of cachedNotes) {
        if (row.kind === 'explain') {
          const parsed = parseExplanation(row.text);
          if (parsed?.explanation) {
            topInsight = parsed.explanation;
            break;
          }
        } else if (row.kind === 'diagnose') {
          const parsed = parseDiagnosis(row.text);
          if (parsed?.summary && parsed.summary.trim().length > 0) {
            topInsight = parsed.summary.trim();
            break;
          }
        }
      }
    }
  }

  if (!topInsight) {
    if (topRecommendation !== null) {
      topInsight = topRecommendation.action || topRecommendation.title;
    } else if (anomalies.anomalies.length > 0) {
      const topAnomaly = anomalies.anomalies[0];
      const projectLabel = topAnomaly.project || 'global';
      topInsight = `${topAnomaly.agent} (${projectLabel}) spiked to ${formatTokens(topAnomaly.tokens)} on ${topAnomaly.day} (${topAnomaly.ratio}x median)`;
    } else if (liveAlerts.length > 0) {
      topInsight = liveAlerts[0].detail || liveAlerts[0].title;
    } else {
      topInsight = null;
    }
  }

  const data: SummaryData = {
    updatedAt: now,
    totals: {
      tokensToday: totalTokensToday,
      costToday: Number(totalCostToday.toFixed(4)),
      burnRateTokensPerHour: burnRow?.tokensLastHour ?? 0,
      activeSessions: activeRow?.activeSessions ?? 0,
    },
    projects,
    quotas,
    forecasts,
    statuslineForecast,
    topRecommendation,
    topInsight,
    recommendations,
    byAgentToday,
    liveAlerts,
    daily7d,
    topModels,
    projectList,
    anomalies,
  };

  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(data));
  renameSync(tmpPath, targetPath);
}

export type StatuslineFormat = 'default' | 'starship' | 'raw';

export function formatStatusline(
  summaryPath: string,
  projectCwd: string,
  format: StatuslineFormat = 'default',
): string {
  const root = projectRoot(projectCwd);
  const name = projectName(root);

  let data: SummaryData | undefined;
  if (existsSync(summaryPath)) {
    try {
      data = JSON.parse(readFileSync(summaryPath, 'utf8'));
    } catch {}
  }

  const proj = data?.projects?.[root];
  const tokensTodayStr = proj ? formatTokens(proj.tokensToday) : '--';

  const claude5h = data?.quotas?.claude?.['5h'];
  const claude7d = data?.quotas?.claude?.['7d'];

  const h5Str = claude5h != null ? `${Math.round(claude5h)}%` : '--';
  const d7Str = claude7d != null ? `${Math.round(claude7d)}%` : '--';

  if (format === 'starship') {
    let line = `⚡ ${h5Str} 5h | ${tokensTodayStr}/d`;
    if (data?.statuslineForecast) {
      line += ` | ${data.statuslineForecast}`;
    }
    if (proj?.contextWarning) {
      line += ` | ${proj.contextWarning}`;
    }
    return line;
  }

  if (format === 'raw') {
    return [name, tokensTodayStr, h5Str, d7Str, data?.statuslineForecast ?? '', proj?.contextWarning ?? ''].join('\t');
  }

  const base = `${name} · ${tokensTodayStr} · 5h ${h5Str} · 7d ${d7Str}`;
  let line = base;
  if (data?.statuslineForecast) {
    line += ` · ${data.statuslineForecast}`;
  }
  if (proj?.contextWarning) {
    line += ` · ${proj.contextWarning}`;
  }
  return line;
}
