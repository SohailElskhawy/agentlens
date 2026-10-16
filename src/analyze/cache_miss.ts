import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';
import { CACHE_TTL_MS } from './constants.ts';

export function detectCacheMisses(db: DB, options?: { sessionId?: string; projectId?: number }): Finding[] {
  let sql = `
    SELECT e.id,
           e.session_id AS sessionId,
           s.project_id AS projectId,
           e.ts,
           e.input,
           e.cache_read AS cacheRead
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
  sql += ' ORDER BY e.session_id, e.ts ASC';

  const rows = db.prepare(sql).all(...params) as any[];
  const findings: Finding[] = [];

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];
    if (curr.sessionId !== prev.sessionId) continue;

    const gapMs = curr.ts - prev.ts;
    if (gapMs >= CACHE_TTL_MS && curr.input >= 20_000 && (curr.cacheRead === 0 || curr.cacheRead / (curr.input + curr.cacheRead) < 0.2)) {
      const idleMinutes = Math.round(gapMs / 60_000);
      const estTokensWeek = Math.round(curr.input * 0.9);
      const confidence = curr.input >= 50_000 ? 'high' : 'medium';
      const confidenceReason = `${idleMinutes} min idle gap caused cold cache miss of ${(curr.input / 1000).toFixed(0)}k tokens`;

      findings.push({
        id: `cache_miss:${curr.id}`,
        rule: 'cache_miss',
        projectId: curr.projectId ?? null,
        sessionId: curr.sessionId,
        evidence: {
          eventId: curr.id,
          idleMinutes,
          inputTokens: curr.input,
          cacheReadTokens: curr.cacheRead,
        },
        confidence,
        confidenceReason,
        estTokensWeek,
        firstSeen: curr.ts,
        lastSeen: curr.ts,
      });
    }
  }

  return findings;
}
