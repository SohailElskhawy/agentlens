import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';
import { HANDOFF_WINDOW_MS } from './constants.ts';

export function detectHandoffs(db: DB, options?: { sessionId?: string; projectId?: number }): Finding[] {
  let sql = `
    SELECT s.id,
           s.agent,
           s.project_id AS projectId,
           min(e.ts) AS startTs,
           max(e.ts) AS endTs,
           sum(e.input) AS inputTokens
    FROM sessions s
    JOIN events e ON e.session_id = s.id
    WHERE s.project_id IS NOT NULL
  `;
  const params: any[] = [];
  if (options?.projectId != null) {
    sql += ' AND s.project_id = ?';
    params.push(options.projectId);
  }
  sql += `
    GROUP BY s.id, s.agent, s.project_id
    ORDER BY s.project_id, min(e.ts) ASC
  `;

  const rows = db.prepare(sql).all(...params) as any[];
  const findings: Finding[] = [];

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];
    if (curr.projectId !== prev.projectId) continue;

    const gapMs = curr.startTs - prev.endTs;
    if (curr.agent !== prev.agent && gapMs >= 0 && gapMs <= HANDOFF_WINDOW_MS) {
      const minutes = Math.round(gapMs / 60_000);
      const estTokensWeek = Math.max(5000, Math.round(curr.inputTokens * 0.5));
      const confidence = 'medium';
      const confidenceReason = `Switched from ${prev.agent} to ${curr.agent} within ${minutes}m on same project`;

      findings.push({
        id: `handoff:${curr.id}`,
        rule: 'handoff',
        projectId: curr.projectId,
        sessionId: curr.id,
        evidence: {
          previousSessionId: prev.id,
          previousAgent: prev.agent,
          currentAgent: curr.agent,
          gapMinutes: minutes,
        },
        confidence,
        confidenceReason,
        estTokensWeek,
        firstSeen: curr.startTs,
        lastSeen: curr.startTs,
      });
    }
  }

  return findings;
}
