import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DB } from './db.ts';
import { insertQuotas, tx } from './db.ts';
import { projectName, projectRoot } from './project.ts';
import type { QuotaSnapshot } from './types.ts';

export interface ProjectSummary {
  projectId: number;
  root: string;
  name: string;
  tokensToday: number;
}

export interface SummaryData {
  updatedAt: number;
  totals: {
    tokensToday: number;
  };
  projects: Record<string, ProjectSummary>;
  quotas: {
    claude?: { '5h'?: number; '7d'?: number };
    codex?: { '5h'?: number; '7d'?: number };
  };
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
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const startOfToday = midnight.getTime();

  const projectRows = db.prepare(`
    SELECT coalesce(s.project_id, 0) AS projectId,
           coalesce(p.root, '') AS root,
           coalesce(p.name, 'unknown') AS name,
           coalesce(sum(e.input + e.output + e.cache_read + e.cache_write), 0) AS tokens
    FROM events e
    JOIN sessions s ON s.id = e.session_id
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE e.ts >= ?
    GROUP BY s.project_id
  `).all(startOfToday) as { projectId: number; root: string; name: string; tokens: number }[];

  let totalTokensToday = 0;
  const projects: Record<string, ProjectSummary> = {};
  for (const r of projectRows) {
    totalTokensToday += r.tokens;
    if (r.root) {
      projects[r.root] = {
        projectId: r.projectId,
        root: r.root,
        name: r.name,
        tokensToday: r.tokens,
      };
    }
  }

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

  const data: SummaryData = {
    updatedAt: Date.now(),
    totals: { tokensToday: totalTokensToday },
    projects,
    quotas,
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

  return `${name} · ${tokensTodayStr} · 5h ${h5Str} · 7d ${d7Str}`;
}
