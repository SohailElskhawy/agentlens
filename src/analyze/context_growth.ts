import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';
import { CONTEXT_GROWTH_THRESHOLD } from './constants.ts';

export function detectContextGrowth(db: DB, options?: { sessionId?: string; projectId?: number }): Finding[] {
  let sql = `
    SELECT e.session_id AS sessionId,
           s.project_id AS projectId,
           count(*) AS turnCount,
           max(e.input + e.cache_read) AS peakTokens,
           min(e.ts) AS firstTs,
           max(e.ts) AS lastTs
    FROM events e
    LEFT JOIN sessions s ON s.id = e.session_id
    WHERE e.kind = 'assistant'
  `;
  const params: any[] = [];
  if (options?.sessionId) {
    sql += ' AND e.session_id = ?';
    params.push(options.sessionId);
  }
  if (options?.projectId != null) {
    sql += ' AND s.project_id = ?';
    params.push(options.projectId);
  }
  sql += `
    GROUP BY e.session_id, s.project_id
    HAVING max(e.input + e.cache_read) >= ?
    ORDER BY max(e.input + e.cache_read) DESC
  `;
  params.push(CONTEXT_GROWTH_THRESHOLD);

  const rows = db.prepare(sql).all(...params) as any[];
  const findings: Finding[] = [];

  for (const r of rows) {
    const baseline = 30_000;
    const peak = r.peakTokens;
    const estTokensWeek = Math.max(0, peak - baseline);
    const confidence = peak >= 150_000 ? 'high' : 'medium';
    const confidenceReason = `Peak context reached ${(peak / 1000).toFixed(0)}k tokens over ${r.turnCount} turns without compaction`;

    findings.push({
      id: `context_growth:${r.sessionId}`,
      rule: 'context_growth',
      projectId: r.projectId ?? null,
      sessionId: r.sessionId,
      evidence: {
        peakTokens: peak,
        turnCount: r.turnCount,
      },
      confidence,
      confidenceReason,
      estTokensWeek,
      firstSeen: r.firstTs,
      lastSeen: r.lastTs,
    });
  }

  return findings;
}
