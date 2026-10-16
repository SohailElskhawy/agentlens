import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';
import { QUOTA_PRESSURE_THRESHOLD } from './constants.ts';
import { computeQuotaForecasts } from '../quota-forecast.ts';

export function detectQuotaPressure(db: DB): Finding[] {
  const sevenDaysAgo = Date.now() - 7 * 86400_000;
  const sql = `
    SELECT q.agent, q.win, q.used_pct AS usedPct, q.resets_at AS resetsAt, q.ts,
           (SELECT min(ts) FROM quota_snapshots WHERE agent = q.agent AND win = q.win AND ts >= ?) AS firstTs
    FROM quota_snapshots q
    WHERE q.ts >= ?
      AND q.ts = (SELECT max(ts) FROM quota_snapshots WHERE agent = q.agent AND win = q.win)
  `;
  const rows = db.prepare(sql).all(sevenDaysAgo, sevenDaysAgo) as any[];
  const forecasts = computeQuotaForecasts(db);
  const findings: Finding[] = [];

  for (const q of rows) {
    const f = forecasts.find((x) => x.agent === q.agent && x.window === q.win);
    const isOverThreshold = q.usedPct >= QUOTA_PRESSURE_THRESHOLD;
    const isProjectedExhaustion = f?.willExhaustBeforeReset === true;

    // Fire if currently >= 80% OR projected to exhaust before reset
    if (!isOverThreshold && !isProjectedExhaustion) {
      continue;
    }

    const isLimitHit = q.usedPct >= 100.0;
    let confidence: 'high' | 'medium' = 'medium';
    let confidenceReason = '';

    if (isLimitHit) {
      confidence = 'high';
      confidenceReason = `${q.agent} ${q.win} quota exhausted (100% used)`;
    } else if (isProjectedExhaustion && f?.message) {
      // High confidence if projected to exhaust within 45 minutes or already > 75%
      confidence = (f.projectedExhaustionTs && f.projectedExhaustionTs - Date.now() < 45 * 60_000) || q.usedPct >= 75 ? 'high' : 'medium';
      confidenceReason = `${q.agent} ${q.win} quota under pressure (${f.message}, currently ${Math.round(q.usedPct)}% used)`;
    } else {
      confidence = q.usedPct >= 90 ? 'high' : 'medium';
      confidenceReason = `${q.agent} ${q.win} quota under pressure (${q.usedPct.toFixed(0)}% used)`;
    }

    findings.push({
      id: `quota_pressure:${q.agent}:${q.win}`,
      rule: 'quota_pressure',
      projectId: null,
      sessionId: null,
      evidence: {
        agent: q.agent,
        window: q.win,
        usedPct: q.usedPct,
        resetsAt: q.resetsAt,
        projectedExhaustionTs: f?.projectedExhaustionTs ?? null,
        burnRatePctPerHour: f?.burnRatePctPerHour ?? 0,
        forecastMessage: f?.message,
      },
      confidence,
      confidenceReason,
      estTokensWeek: 0,
      firstSeen: q.firstTs ?? q.ts,
      lastSeen: q.ts,
    });
  }

  return findings;
}
