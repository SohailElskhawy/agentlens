import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';
import { QUOTA_PRESSURE_THRESHOLD } from './constants.ts';

export function detectQuotaPressure(db: DB): Finding[] {
  const sql = `
    SELECT agent, win, used_pct AS usedPct, resets_at AS resetsAt, ts
    FROM quota_snapshots
    WHERE used_pct >= ?
    ORDER BY ts DESC LIMIT 20
  `;
  const rows = db.prepare(sql).all(QUOTA_PRESSURE_THRESHOLD) as any[];
  const findings: Finding[] = [];

  for (const q of rows) {
    const isLimitHit = q.usedPct >= 100.0;
    const confidence = isLimitHit ? 'high' : 'medium';
    const confidenceReason = isLimitHit
      ? `${q.agent} ${q.win} quota exhausted (100% used)`
      : `${q.agent} ${q.win} quota under pressure (${q.usedPct.toFixed(0)}% used)`;

    findings.push({
      id: `quota_pressure:${q.agent}:${q.win}:${q.ts}`,
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
      firstSeen: q.ts,
      lastSeen: q.ts,
    });
  }

  return findings;
}
