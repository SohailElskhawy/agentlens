import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';
import { SUBAGENT_MAX_OUTPUT, SUBAGENT_MIN_INPUT } from './constants.ts';

export function detectSubagentShare(db: DB, options?: { sessionId?: string; projectId?: number }): Finding[] {
  let sql = `
    SELECT s.id,
           s.parent_id AS parentId,
           s.project_id AS projectId,
           sum(e.input + e.cache_read) AS totalInput,
           sum(e.output) AS totalOutput,
           min(e.ts) AS firstTs,
           max(e.ts) AS lastTs
    FROM sessions s
    JOIN events e ON e.session_id = s.id
    WHERE s.parent_id IS NOT NULL
  `;
  const params: any[] = [];
  if (options?.sessionId) {
    sql += ' AND s.id = ?';
    params.push(options.sessionId);
  }
  if (options?.projectId != null) {
    sql += ' AND s.project_id = ?';
    params.push(options.projectId);
  }
  sql += `
    GROUP BY s.id, s.parent_id, s.project_id
    HAVING sum(e.input + e.cache_read) >= ? AND sum(e.output) <= ?
  `;
  params.push(SUBAGENT_MIN_INPUT, SUBAGENT_MAX_OUTPUT);

  const rows = db.prepare(sql).all(...params) as any[];
  const findings: Finding[] = [];

  for (const r of rows) {
    const estTokensWeek = Math.round(r.totalInput * 0.7);
    const confidence = 'low';
    const confidenceReason = `Subagent consumed ${(r.totalInput / 1000).toFixed(0)}k tokens but only produced ${r.totalOutput} output tokens`;

    findings.push({
      id: `subagent_share:${r.id}`,
      rule: 'subagent_share',
      projectId: r.projectId ?? null,
      sessionId: r.id,
      evidence: {
        parentSessionId: r.parentId,
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
