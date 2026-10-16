import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';
import { COMPACTION_CHURN_THRESHOLD } from './constants.ts';

export function detectCompactionChurn(
  db: DB,
  options?: { sessionId?: string; projectId?: number }
): Finding[] {
  let sessionSql = `
    SELECT DISTINCT e.session_id AS sessionId, s.project_id AS projectId, s.agent
    FROM events e
    LEFT JOIN sessions s ON s.id = e.session_id
    WHERE e.kind = 'assistant'
  `;
  const params: any[] = [];
  if (options?.sessionId) {
    sessionSql += ' AND e.session_id = ?';
    params.push(options.sessionId);
  }
  if (options?.projectId != null) {
    sessionSql += ' AND s.project_id = ?';
    params.push(options.projectId);
  }

  const sessions = db.prepare(sessionSql).all(...params) as Array<{
    sessionId: string;
    projectId: number | null;
    agent: string;
  }>;

  const findings: Finding[] = [];

  for (const s of sessions) {
    const turns = db.prepare(`
      SELECT (input + cache_read) AS contextSize, ts, kind
      FROM events
      WHERE session_id = ? AND kind = 'assistant'
      ORDER BY ts ASC
    `).all(s.sessionId) as Array<{ contextSize: number; ts: number; kind: string }>;

    if (turns.length < COMPACTION_CHURN_THRESHOLD + 1) continue;

    let compactions = 0;
    let prevContext = turns[0].contextSize;

    for (let i = 1; i < turns.length; i++) {
      const currContext = turns[i].contextSize;
      // Compaction detected if context was sizable (>= 30k) and dropped by > 40%
      if (prevContext >= 30_000 && currContext < prevContext * 0.6) {
        compactions++;
      }
      prevContext = currContext;
    }

    if (compactions >= COMPACTION_CHURN_THRESHOLD) {
      const confidence = compactions >= 5 ? 'high' : 'medium';
      findings.push({
        id: `compaction_churn:${s.sessionId}`,
        rule: 'compaction_churn',
        projectId: s.projectId ?? null,
        sessionId: s.sessionId,
        evidence: {
          sessionId: s.sessionId,
          agent: s.agent,
          compactions,
          turnsCount: turns.length,
        },
        confidence,
        confidenceReason: `Session ${s.sessionId} underwent ${compactions} compactions, indicating high context churn and task scope instability.`,
        estTokensWeek: compactions * 15_000,
        firstSeen: turns[0].ts,
        lastSeen: turns[turns.length - 1].ts,
      });
    }
  }

  return findings;
}
