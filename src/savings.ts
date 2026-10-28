import type { DB } from './db.ts';
import { tx } from './db.ts';

interface SavingsMetrics {
  sessions: number;
  tokensPerSession: number;
  tokensPerTurn: number | null;
  nonCacheInputShare: number | null;
  cacheReadRatio: number | null;
}

interface SavingsWeek extends SavingsMetrics {
  weekStart: number;
  complete: boolean;
}

interface SavingsOptions {
  projectId?: number;
  weeks?: number;
  now?: number;
}

function weekStart(ts: number) {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  return date;
}

export function getSavings(db: DB, { projectId, weeks = 8, now = Date.now() }: SavingsOptions = {}) {
  if (!Number.isSafeInteger(weeks) || weeks < 1) throw new Error('weeks must be a positive integer');
  const currentWeek = weekStart(now);
  const start = new Date(currentWeek);
  start.setDate(start.getDate() - (weeks - 1) * 7);
  if (!Number.isFinite(start.getTime())) throw new Error('weeks exceeds the supported date range');
  const projects = db.prepare(`SELECT id AS projectId, name, root FROM projects
    WHERE (? IS NULL OR id = ?) ORDER BY root`).all(projectId ?? null, projectId ?? null) as {
    projectId: number; name: string; root: string;
  }[];
  const hasSnapshots = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'savings_baselines'").get();
  const weeklyByProject = new Map<number, SavingsWeek[]>();
  const aggregate = db.prepare(`SELECT s.project_id AS projectId, count(DISTINCT e.session_id) AS sessions,
    sum(e.kind = 'user') AS turns,
    sum(CASE WHEN e.kind = 'assistant' THEN e.input ELSE 0 END) AS input,
    sum(CASE WHEN e.kind = 'assistant' THEN e.output ELSE 0 END) AS output,
    sum(CASE WHEN e.kind = 'assistant' THEN e.cache_read ELSE 0 END) AS cacheRead,
    sum(CASE WHEN e.kind = 'assistant' THEN e.cache_write ELSE 0 END) AS cacheWrite
    FROM events e JOIN sessions s ON s.id = e.session_id
    WHERE e.ts >= ? AND e.ts < ? AND (? IS NULL OR s.project_id = ?)
    GROUP BY s.project_id`);
  for (const date = new Date(start); date.getTime() <= now; date.setDate(date.getDate() + 7)) {
    const from = date.getTime();
    const end = new Date(date);
    end.setDate(end.getDate() + 7);
    const rows = aggregate.all(from, Math.min(end.getTime(), now), projectId ?? null, projectId ?? null) as {
      projectId: number | null; sessions: number; turns: number; input: number; output: number; cacheRead: number; cacheWrite: number;
    }[];
    for (const row of rows) {
      if (row.projectId == null || !row.sessions) continue;
      const input = row.input + row.cacheWrite;
      const totalInput = input + row.cacheRead;
      const tokens = totalInput + row.output;
      const weekly = weeklyByProject.get(row.projectId) ?? [];
      weekly.push({
        weekStart: from, complete: end.getTime() <= now, sessions: row.sessions,
        tokensPerSession: tokens / row.sessions, tokensPerTurn: row.turns ? tokens / row.turns : null,
        nonCacheInputShare: totalInput ? input / totalInput : null,
        cacheReadRatio: totalInput ? row.cacheRead / totalInput : null,
      });
      weeklyByProject.set(row.projectId, weekly);
    }
  }

  return {
    weeks,
    projects: projects.map((project) => {
      const weekly = weeklyByProject.get(project.projectId) ?? [];
      const stored = hasSnapshots ? db.prepare(`SELECT metrics FROM savings_baselines
        WHERE project_id = ? ORDER BY captured_at, id LIMIT 1`).get(project.projectId) as { metrics: string } | undefined : undefined;
      const baseline: SavingsWeek | null = stored ? JSON.parse(stored.metrics) : weekly.find((week) => week.complete) ?? null;
      const latest = weekly.at(-1) ?? null;
      const changePct = baseline && latest ? Object.fromEntries(
        (['sessions', 'tokensPerSession', 'tokensPerTurn', 'nonCacheInputShare', 'cacheReadRatio'] as const).map((key) => {
          const before = baseline[key];
          const after = latest[key];
          return [key, before == null || after == null || before === 0
            ? null : Math.round((after - before) / before * 10000) / 100];
        }),
      ) as Record<keyof SavingsMetrics, number | null> : null;
      return { ...project, weekly, baseline, baselineSource: stored ? 'snapshot' : baseline ? 'week' : null, latest, changePct };
    }),
  };
}

export function snapshotSavings(db: DB, options: SavingsOptions = {}) {
  const now = options.now ?? Date.now();
  const report = getSavings(db, { ...options, now });
  tx(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS savings_baselines (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
      captured_at INTEGER NOT NULL, metrics TEXT NOT NULL)`);
    const insert = db.prepare('INSERT INTO savings_baselines (project_id, captured_at, metrics) VALUES (?, ?, ?)');
    for (const project of report.projects) {
      if (project.latest) insert.run(project.projectId, now, JSON.stringify(project.latest));
    }
  });
  return getSavings(db, { ...options, now });
}
