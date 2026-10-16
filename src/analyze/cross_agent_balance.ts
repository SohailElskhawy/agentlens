import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';
import { CROSS_AGENT_HEADROOM_DIFF, CROSS_AGENT_TIGHT_THRESHOLD } from './constants.ts';
import { computeQuotaForecasts } from '../quota-forecast.ts';

export function formatResetTime(epochMs: number): string {
  const d = new Date(epochMs);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayName = days[d.getDay()];
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${dayName} ${hours}:${minutes}`;
}

export function capitalize(str: string): string {
  if (!str) return '';
  const lower = str.toLowerCase();
  if (lower === 'claude') return 'Claude';
  if (lower === 'codex') return 'Codex';
  if (lower === 'opencode') return 'OpenCode';
  if (lower === 'antigravity') return 'Antigravity';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function detectCrossAgentBalance(db: DB, options?: { projectId?: number }): Finding[] {
  const sql = `
    SELECT q.agent, q.win, q.used_pct AS usedPct, q.resets_at AS resetsAt, q.ts
    FROM quota_snapshots q
    WHERE q.ts = (SELECT max(ts) FROM quota_snapshots WHERE agent = q.agent AND win = q.win)
  `;
  const rows = db.prepare(sql).all() as Array<{
    agent: string;
    win: '5h' | '7d';
    usedPct: number;
    resetsAt: number;
    ts: number;
  }>;

  if (rows.length < 2) {
    return [];
  }

  const forecasts = computeQuotaForecasts(db);
  const findings: Finding[] = [];
  const processedPairs = new Set<string>();

  // Check 7d first, then 5h
  const windows: Array<'7d' | '5h'> = ['7d', '5h'];

  for (const win of windows) {
    const windowRows = rows.filter((r) => r.win === win);
    if (windowRows.length < 2) continue;

    for (const tight of windowRows) {
      const tightForecast = forecasts.find((f) => f.agent === tight.agent && f.window === win);
      const isTight = tight.usedPct >= CROSS_AGENT_TIGHT_THRESHOLD || tightForecast?.willExhaustBeforeReset === true;
      if (!isTight) continue;

      // Find candidates with headroom
      const candidates = windowRows.filter(
        (alt) =>
          alt.agent !== tight.agent &&
          tight.usedPct - alt.usedPct >= CROSS_AGENT_HEADROOM_DIFF &&
          alt.usedPct <= 60.0
      );

      if (candidates.length === 0) continue;

      // Sort by lowest utilization (most headroom)
      candidates.sort((a, b) => a.usedPct - b.usedPct);
      const bestAlt = candidates[0];

      const pairKey = `${tight.agent}:${bestAlt.agent}:${win}`;
      if (processedPairs.has(pairKey)) continue;
      processedPairs.add(pairKey);

      const resetFormatted = formatResetTime(tight.resetsAt);
      const tightName = capitalize(tight.agent);
      const altName = capitalize(bestAlt.agent);

      findings.push({
        id: `cross_agent_balance:${tight.agent}:${bestAlt.agent}:${win}`,
        rule: 'cross_agent_balance',
        projectId: options?.projectId ?? null,
        sessionId: null,
        evidence: {
          tightAgent: tight.agent,
          altAgent: bestAlt.agent,
          window: win,
          tightUsedPct: tight.usedPct,
          altUsedPct: bestAlt.usedPct,
          resetsAt: tight.resetsAt,
          resetFormatted,
          suggestion: `Use ${altName} for this project until ${resetFormatted}.`,
        },
        confidence: tight.usedPct >= 85 || tightForecast?.willExhaustBeforeReset ? 'high' : 'medium',
        confidenceReason: `${tightName}'s ${win} window is tight (${Math.round(tight.usedPct)}% used), while ${altName} has headroom (${Math.round(bestAlt.usedPct)}% used). Use ${altName} until ${resetFormatted}.`,
        estTokensWeek: 50_000,
        firstSeen: tight.ts,
        lastSeen: tight.ts,
      });
    }
  }

  return findings;
}
