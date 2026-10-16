import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';
import { RETRY_LOOP_THRESHOLD } from './constants.ts';

export function detectRetryLoops(db: DB, options?: { sessionId?: string; projectId?: number }): Finding[] {
  let sql = `
    SELECT e.session_id AS sessionId,
           s.project_id AS projectId,
           e.tool,
           e.args_hash AS argsHash,
           count(*) AS cnt,
           sum(CASE WHEN e.is_error = 1 THEN 1 ELSE 0 END) AS errCnt,
           min(e.ts) AS firstTs,
           max(e.ts) AS lastTs
    FROM events e
    LEFT JOIN sessions s ON s.id = e.session_id
    WHERE e.tool IS NOT NULL AND e.args_hash IS NOT NULL
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
    GROUP BY e.session_id, s.project_id, e.tool, e.args_hash
    HAVING count(*) >= ? OR (sum(CASE WHEN e.is_error = 1 THEN 1 ELSE 0 END) > 0 AND count(*) >= 2)
    ORDER BY count(*) DESC
  `;
  params.push(RETRY_LOOP_THRESHOLD);

  const rows = db.prepare(sql).all(...params) as any[];
  const findings: Finding[] = [];

  for (const r of rows) {
    const isErrorRetry = r.errCnt > 0;
    const confidence = isErrorRetry && r.cnt >= 3 ? 'high' : r.cnt >= 3 ? 'medium' : 'low';
    const confidenceReason = isErrorRetry
      ? `${r.cnt} calls to '${r.tool}' with ${r.errCnt} error retries`
      : `${r.cnt} identical calls to '${r.tool}' in session`;
    // Estimate ~1,500 tokens per repeated turn beyond the first call
    const estTokensWeek = Math.max(1, r.cnt - 1) * 1500;

    findings.push({
      id: `retry_loop:${r.sessionId}:${r.tool}:${r.argsHash}`,
      rule: 'retry_loop',
      projectId: r.projectId ?? null,
      sessionId: r.sessionId,
      evidence: {
        tool: r.tool,
        argsHash: r.argsHash,
        count: r.cnt,
        errorCount: r.errCnt,
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
