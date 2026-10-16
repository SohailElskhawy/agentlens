import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';
import { QUOTA_PRESSURE_THRESHOLD } from './constants.ts';

export function detectQuotaPressure(db: DB): Finding[] {
  const sevenDaysAgo = Date.now() - 7 * 86400_000;
  const sql = `
    SELECT q.agent, q.win, q.used_pct AS usedPct, q.resets_at AS resetsAt, q.ts,
           (SELECT min(ts) FROM quota_snapshots WHERE agent = q.agent AND win = q.win AND used_pct >= ? AND ts >= ?) AS firstTs
    FROM quota_snapshots q
    WHERE q.used_pct >= ?
      AND q.ts >= ?
      AND q.ts = (SELECT max(ts) FROM quota_snapshots WHERE agent = q.agent AND win = q.win)
  `;
  const rows = db.prepare(sql).all(QUOTA_PRESSURE_THRESHOLD, sevenDaysAgo, QUOTA_PRESSURE_THRESHOLD, sevenDaysAgo) as any[];
  const findings: Finding[] = [];

  for (const q of rows) {
    const isLimitHit = q.usedPct >= 100.0;
    const confidence = isLimitHit ? 'high' : 'medium';
    const confidenceReason = isLimitHit
      ? `${q.agent} ${q.win} quota exhausted (100% used)`
      : `${q.agent} ${q.win} quota under pressure (${q.usedPct.toFixed(0)}% used)`;

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
