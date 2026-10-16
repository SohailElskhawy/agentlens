import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';

export function detectModelFit(db: DB, options?: { sessionId?: string; projectId?: number }): Finding[] {
  let sql = `
    SELECT e.session_id AS sessionId,
           s.project_id AS projectId,
           e.model,
           count(*) AS turnCount,
           (SELECT count(*) FROM events WHERE session_id = e.session_id AND kind = 'assistant') AS sessionTurns,
           sum(e.input) AS totalInput,
           sum(e.output) AS totalOutput,
           min(e.ts) AS firstTs,
           max(e.ts) AS lastTs
    FROM events e
    LEFT JOIN sessions s ON s.id = e.session_id
    WHERE e.kind = 'assistant' AND e.model IS NOT NULL
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
    GROUP BY e.session_id, s.project_id, e.model
    HAVING sessionTurns = 1 AND sum(e.output) < 100 AND (
      lower(e.model) LIKE '%opus%' OR lower(e.model) LIKE '%o1%' OR lower(e.model) LIKE '%o3%' OR lower(e.model) LIKE '%gpt-4o%'
    )
  `;

  const rows = db.prepare(sql).all(...params) as any[];
  const findings: Finding[] = [];

  for (const r of rows) {
    const estTokensWeek = 5000;
    const confidence = 'medium';
    const confidenceReason = `Flagship model '${r.model}' used on short single-turn query (${r.totalOutput} tokens output)`;

    findings.push({
      id: `model_fit:${r.sessionId}`,
      rule: 'model_fit',
      projectId: r.projectId ?? null,
      sessionId: r.sessionId,
      evidence: {
        model: r.model,
        turnCount: r.turnCount,
        inputTokens: r.totalInput,
        outputTokens: r.totalOutput,
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
