import type { DB } from './db.ts';
import type { Agent } from './types.ts';

export interface QuotaForecastResult {
  agent: Agent;
  window: '5h' | '7d';
  usedPct: number;
  resetsAt: number;
  burnRatePctPerHour: number;
  projectedExhaustionTs: number | null;
  willExhaustBeforeReset: boolean;
  message?: string;
}

/**
 * Computes burn rate and projected 100% exhaustion timestamp from the last N quota samples.
 */
export function computeQuotaForecasts(db: DB, sampleLimit = 10): QuotaForecastResult[] {
  const pairs: Array<{ agent: Agent; win: '5h' | '7d' }> = [
    { agent: 'claude', win: '5h' },
    { agent: 'claude', win: '7d' },
    { agent: 'codex', win: '5h' },
    { agent: 'codex', win: '7d' },
  ];

  const results: QuotaForecastResult[] = [];
  const now = Date.now();

  for (const { agent, win } of pairs) {
    const rows = db.prepare(`
      SELECT ts, used_pct AS usedPct, resets_at AS resetsAt
      FROM quota_snapshots
      WHERE agent = ? AND win = ?
      ORDER BY ts DESC
      LIMIT ?
    `).all(agent, win, sampleLimit) as Array<{ ts: number; usedPct: number; resetsAt: number }>;

    if (!rows.length) continue;

    const latest = rows[0];
    if (latest.resetsAt <= now) {
      // Window has already reset
      continue;
    }

    // Filter to samples within the same reset window
    const windowSamples = rows
      .filter((r) => r.resetsAt === latest.resetsAt)
      .sort((a, b) => a.ts - b.ts);

    if (latest.usedPct >= 100) {
      results.push({
        agent,
        window: win,
        usedPct: latest.usedPct,
        resetsAt: latest.resetsAt,
        burnRatePctPerHour: 0,
        projectedExhaustionTs: latest.ts,
        willExhaustBeforeReset: true,
        message: `${win} limit currently exhausted`,
      });
      continue;
    }

    if (windowSamples.length < 2) {
      results.push({
        agent,
        window: win,
        usedPct: latest.usedPct,
        resetsAt: latest.resetsAt,
        burnRatePctPerHour: 0,
        projectedExhaustionTs: null,
        willExhaustBeforeReset: false,
      });
      continue;
    }

    const first = windowSamples[0];
    const dtMs = latest.ts - first.ts;
    const dPct = latest.usedPct - first.usedPct;

    // Must have at least 10 seconds between samples and positive usage delta
    if (dtMs < 10_000 || dPct <= 0) {
      results.push({
        agent,
        window: win,
        usedPct: latest.usedPct,
        resetsAt: latest.resetsAt,
        burnRatePctPerHour: 0,
        projectedExhaustionTs: null,
        willExhaustBeforeReset: false,
      });
      continue;
    }

    const burnRatePctPerHour = dPct / (dtMs / 3600_000);
    const remPct = 100 - latest.usedPct;
    const msToExhaustion = (remPct / burnRatePctPerHour) * 3600_000;
    const projectedExhaustionTs = Math.round(latest.ts + msToExhaustion);
    const willExhaustBeforeReset = projectedExhaustionTs < latest.resetsAt;

    let message: string | undefined;
    if (willExhaustBeforeReset) {
      const d = new Date(projectedExhaustionTs);
      const hours = String(d.getHours()).padStart(2, '0');
      const mins = String(d.getMinutes()).padStart(2, '0');
      message = `at this pace you hit the ${win} limit at ${hours}:${mins}`;
    }

    results.push({
      agent,
      window: win,
      usedPct: latest.usedPct,
      resetsAt: latest.resetsAt,
      burnRatePctPerHour,
      projectedExhaustionTs: willExhaustBeforeReset ? projectedExhaustionTs : null,
      willExhaustBeforeReset,
      message,
    });
  }

  return results;
}
