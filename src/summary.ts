import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DB } from './db.ts';
import { insertQuotas, tx } from './db.ts';
import { generateFixPrompt } from './fix-prompts.ts';
import { costOf } from './pricing.ts';
import { projectName, projectRoot } from './project.ts';
import type { QuotaSnapshot } from './types.ts';
import { computeQuotaForecasts, type QuotaForecastResult } from './quota-forecast.ts';

export interface ProjectSummary {
  projectId: number;
  root: string;
  name: string;
  tokensToday: number;
  costToday?: number;
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
  const projects: Record<string, ProjectSummary> = {};
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
      const existing = projects[r.root];
      if (existing) {
        existing.tokensToday += tokens;
        existing.costToday = Number(((existing.costToday ?? 0) + cost).toFixed(4));
      } else {
        projects[r.root] = {
          projectId: r.projectId,
          root: r.root,
          name: r.name,
          tokensToday: tokens,
          costToday: Number(cost.toFixed(4)),
        };
      }
    }
  }

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

  const recRow = db.prepare(`
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
    LIMIT 1
  `).get() as {
    id: string;
    findingRule: string;
    projectId: number | null;
    action: string;
    title: string;
    body: string;
    score: number;
    projectName: string;
    projectRoot: string;
  } | undefined;

  let topRecommendation: SummaryRecommendation | null = null;
  if (recRow) {
    const findingRow = db.prepare(`
      SELECT evidence, coalesce(est_tokens_week, 0) AS estTokensWeek
      FROM findings
      WHERE rule = ? AND (project_id IS ? OR (? IS NULL AND project_id IS NULL))
      ORDER BY est_tokens_week DESC, last_seen DESC
      LIMIT 1
    `).get(recRow.findingRule, recRow.projectId, recRow.projectId) as { evidence: string; estTokensWeek: number } | undefined;

    let evidence: Record<string, any> = {};
    if (findingRow?.evidence) {
      try {
        evidence = JSON.parse(findingRow.evidence);
      } catch {}
    }

    const severity: 'high' | 'medium' | 'low' =
      recRow.score >= 80 ? 'high' : recRow.score >= 50 ? 'medium' : 'low';

    topRecommendation = {
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
  };

  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(data));
  renameSync(tmpPath, targetPath);
}

export function formatStatusline(summaryPath: string, projectCwd: string): string {
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

  const base = `${name} · ${tokensTodayStr} · 5h ${h5Str} · 7d ${d7Str}`;
  if (data?.statuslineForecast) {
    return `${base} · ${data.statuslineForecast}`;
  }
  return base;
}
