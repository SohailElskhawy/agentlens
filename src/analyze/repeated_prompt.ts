import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';

export function detectRepeatedPrompts(db: DB, options?: { sessionId?: string; projectId?: number }): Finding[] {
  let sql = `
    SELECT e.text_hash AS textHash,
           s.project_id AS projectId,
           count(DISTINCT e.session_id) AS sessionCnt,
           count(*) AS totalCnt,
           max(e.text_len) AS textLen,
           min(e.ts) AS firstTs,
           max(e.ts) AS lastTs,
           max(e.session_id) AS sampleSessionId
    FROM events e
    LEFT JOIN sessions s ON s.id = e.session_id
    WHERE e.kind = 'user' AND e.text_hash IS NOT NULL AND e.text_len > 10
  `;
  const params: any[] = [];
  if (options?.projectId != null) {
    sql += ' AND s.project_id = ?';
    params.push(options.projectId);
  }
  sql += `
    GROUP BY e.text_hash, s.project_id
    HAVING count(DISTINCT e.session_id) >= 3
    ORDER BY count(DISTINCT e.session_id) DESC
  `;

  const rows = db.prepare(sql).all(...params) as any[];
  const findings: Finding[] = [];

  for (const r of rows) {
    const estTokensWeek = Math.max(1, r.sessionCnt - 1) * 3000;
    const confidence = r.sessionCnt >= 5 ? 'high' : 'medium';
    const confidenceReason = `Identical prompt used across ${r.sessionCnt} separate sessions`;

    findings.push({
      id: `repeated_prompt:${r.projectId ?? 'global'}:${r.textHash}`,
      rule: 'repeated_prompt',
      projectId: r.projectId ?? null,
      sessionId: r.sampleSessionId,
      evidence: {
        textHash: r.textHash,
        sessionCount: r.sessionCnt,
        totalCount: r.totalCnt,
        textLen: r.textLen,
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
