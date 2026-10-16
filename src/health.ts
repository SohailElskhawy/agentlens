import { execFileSync } from 'node:child_process';
import type { DB } from './db.ts';

export interface SourceHealth {
  agent: string;
  files: number;
  badLines: number;
  lastIngest: number | null;
}

export interface CrossCheckResult {
  agent: string;
  date: string;
  agentlensTokens: number;
  ccusageTokens: number;
  diffPct: number;
  warning: boolean;
}

export interface HealthReport {
  status: 'healthy' | 'warning' | 'degraded';
  sources: SourceHealth[];
  events: Array<{ agent: string; events: number; latestEvent: number | null }>;
  crossCheck: CrossCheckResult[];
  ccusageAvailable: boolean;
  warnings: string[];
}

function runCcusageDaily(agent: string): any {
  try {
    const raw = execFileSync('ccusage', [agent, 'daily', '--json'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

let cachedCrossCheck: { time: number; data: CrossCheckResult[] } | null = null;

function probeCcusage(runner: (agent: string) => any): boolean {
  if (runner === runCcusageDaily) {
    try {
      execFileSync('ccusage', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      return true;
    } catch {
      return false;
    }
  }
  try {
    const probe = runner('__probe__');
    return probe !== null;
  } catch {
    return false;
  }
}

export function checkHealth(db: DB, ccusageRunner = runCcusageDaily): HealthReport {
  const sources = db.prepare(`
    SELECT agent, count(*) AS files, coalesce(sum(errors), 0) AS badLines, max(updated_at) AS lastIngest
    FROM cursors GROUP BY agent
  `).all() as { agent: string; files: number; badLines: number; lastIngest: number | null }[];

  const events = db.prepare(`
    SELECT agent, count(*) AS events, max(ts) AS latestEvent
    FROM events GROUP BY agent
  `).all() as { agent: string; events: number; latestEvent: number | null }[];

  const warnings: string[] = [];
  let status: 'healthy' | 'warning' | 'degraded' = 'healthy';

  for (const s of sources) {
    if (s.badLines > 0) {
      warnings.push(`Agent '${s.agent}' has ${s.badLines} bad lines skipped during ingest.`);
      status = 'warning';
    }
  }

  const ccusageAvailable = probeCcusage(ccusageRunner);
  const crossCheck: CrossCheckResult[] = [];
  const sevenDaysAgo = Date.now() - 7 * 86400_000;

  if (!ccusageAvailable) {
    let hasAntigravity = sources.some((s) => s.agent === 'antigravity') || events.some((e) => e.agent === 'antigravity');
    if (!hasAntigravity) {
      try {
        const count = (db.prepare("SELECT count(*) as c FROM sessions WHERE agent = 'antigravity'").get() as { c: number })?.c;
        if (count > 0) hasAntigravity = true;
      } catch {}
    }
    if (hasAntigravity) {
      warnings.push(
        "ccusage binary not found in PATH: Antigravity sessions will show zero tokens until ccusage is installed (run 'npm i -g ccusage')."
      );
      if (status === 'healthy') status = 'warning';
    }
  }

  if (ccusageAvailable) {
    const isDefaultRunner = ccusageRunner === runCcusageDaily;
    if (isDefaultRunner && cachedCrossCheck && Date.now() - cachedCrossCheck.time < 300_000) {
      crossCheck.push(...cachedCrossCheck.data);
    } else {
      const agentRows = db.prepare(`SELECT DISTINCT agent FROM events WHERE ts >= ?`).all(sevenDaysAgo) as { agent: string }[];
      for (const { agent } of agentRows) {
        let ccusageOutput: any;
        try {
          ccusageOutput = ccusageRunner(agent);
        } catch {
          continue;
        }
        if (!ccusageOutput || !Array.isArray(ccusageOutput.daily)) continue;

        const ccusageByDate = new Map<string, number>();
        for (const d of ccusageOutput.daily) {
          if (d.date && typeof d.totalTokens === 'number') {
            ccusageByDate.set(d.date, d.totalTokens);
          }
        }

        const dailyRows = db.prepare(`
          SELECT date(ts/1000, 'unixepoch', 'localtime') AS d,
                 sum(input + output + cache_read + cache_write) AS tokens
          FROM events
          WHERE agent = ? AND kind = 'assistant' AND ts >= ?
          GROUP BY d
          ORDER BY d
        `).all(agent, sevenDaysAgo) as { d: string; tokens: number }[];

        for (const row of dailyRows) {
          const ccTokens = ccusageByDate.get(row.d);
          if (ccTokens != null) {
            const maxTokens = Math.max(row.tokens, ccTokens);
            const diff = Math.abs(row.tokens - ccTokens);
            const diffPct = maxTokens > 0 ? (diff / maxTokens) * 100 : 0;
            const isWarning = diffPct > 5.0;
            crossCheck.push({
              agent,
              date: row.d,
              agentlensTokens: row.tokens,
              ccusageTokens: ccTokens,
              diffPct: Math.round(diffPct * 10) / 10,
              warning: isWarning,
            });
          }
        }
      }
      if (isDefaultRunner) {
        cachedCrossCheck = { time: Date.now(), data: [...crossCheck] };
      }
    }

    for (const c of crossCheck) {
      if (c.warning) {
        warnings.push(
          `Token drift for ${c.agent} on ${c.date}: agentlens=${c.agentlensTokens}, ccusage=${c.ccusageTokens} (${c.diffPct.toFixed(1)}% diff)`,
        );
        if (status === 'healthy') status = 'warning';
      }
    }
  }

  return {
    status,
    sources,
    events,
    crossCheck,
    ccusageAvailable,
    warnings,
  };
}
