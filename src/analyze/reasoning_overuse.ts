import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';
import {
  REASONING_MAX_OUTPUT,
  REASONING_MIN_TOKENS,
  REASONING_OVERUSE_RATIO,
} from './constants.ts';

export function detectReasoningOveruse(
  db: DB,
  options?: { sessionId?: string; projectId?: number }
): Finding[] {
  let sql = `
    SELECT e.session_id AS sessionId,
           s.project_id AS projectId,
           s.agent,
           count(e.id) AS overuseTurns,
           sum(e.reasoning) AS totalReasoning,
           sum(e.output) AS totalOutput,
           min(e.ts) AS firstTs,
           max(e.ts) AS lastTs
    FROM events e
    LEFT JOIN sessions s ON s.id = e.session_id
    WHERE e.kind = 'assistant'
      AND e.reasoning >= ?
      AND e.output <= ?
      AND e.reasoning >= e.output * ?
  `;
  const params: any[] = [
    REASONING_MIN_TOKENS,
    REASONING_MAX_OUTPUT,
    REASONING_OVERUSE_RATIO,
  ];

  if (options?.sessionId) {
    sql += ' AND e.session_id = ?';
    params.push(options.sessionId);
  }
  if (options?.projectId != null) {
    sql += ' AND s.project_id = ?';
    params.push(options.projectId);
  }

  sql += ' GROUP BY e.session_id, s.project_id, s.agent';

  const rows = db.prepare(sql).all(...params) as Array<{
    sessionId: string;
    projectId: number | null;
    agent: string;
    overuseTurns: number;
    totalReasoning: number;
    totalOutput: number;
    firstTs: number;
    lastTs: number;
  }>;

  const findings: Finding[] = [];

  for (const r of rows) {
    const ratio = Math.round(r.totalReasoning / Math.max(1, r.totalOutput));
    const confidence = r.totalReasoning >= 20_000 || ratio >= 10 ? 'high' : 'medium';
    findings.push({
      id: `reasoning_overuse:${r.sessionId}`,
      rule: 'reasoning_overuse',
      projectId: r.projectId ?? null,
      sessionId: r.sessionId,
      evidence: {
        sessionId: r.sessionId,
        agent: r.agent,
        overuseTurns: r.overuseTurns,
        totalReasoningTokens: r.totalReasoning,
        totalOutputTokens: r.totalOutput,
        ratio,
      },
      confidence,
      confidenceReason: `${r.totalReasoning.toLocaleString()} reasoning tokens consumed for only ${r.totalOutput.toLocaleString()} output tokens (${ratio}x ratio) on short turn(s).`,
      estTokensWeek: Math.round(r.totalReasoning * 0.7),
      firstSeen: r.firstTs,
      lastSeen: r.lastTs,
    });
  }

  return findings;
}
