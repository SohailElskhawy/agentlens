import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';
import { LARGE_TOOL_OUTPUT_BYTES } from './constants.ts';

export function detectLargeToolOutput(db: DB, options?: { sessionId?: string; projectId?: number }): Finding[] {
  let sql = `
    SELECT e.id,
           e.session_id AS sessionId,
           s.project_id AS projectId,
           e.result_bytes AS resultBytes,
           e.ts
    FROM events e
    LEFT JOIN sessions s ON s.id = e.session_id
    WHERE e.kind = 'tool_result' AND e.result_bytes > ?
  `;
  const params: any[] = [LARGE_TOOL_OUTPUT_BYTES];
  if (options?.sessionId) {
    sql += ' AND e.session_id = ?';
    params.push(options.sessionId);
  }
  if (options?.projectId != null) {
    sql += ' AND s.project_id = ?';
    params.push(options.projectId);
  }
  sql += ' ORDER BY e.result_bytes DESC LIMIT 100';

  const rows = db.prepare(sql).all(...params) as any[];
  const findings: Finding[] = [];

  for (const r of rows) {
    // 1 token ~= 4 bytes. Waste is output beyond 10KB baseline
    const excessBytes = Math.max(0, r.resultBytes - 10_000);
    const estTokens = Math.round(excessBytes / 4);
    const confidence = r.resultBytes >= 200_000 ? 'high' : 'medium';
    const confidenceReason = `Tool output was ${(r.resultBytes / 1024).toFixed(1)} KB (expected < 10 KB)`;

    findings.push({
      id: `large_tool_output:${r.id}`,
      rule: 'large_tool_output',
      projectId: r.projectId ?? null,
      sessionId: r.sessionId,
      evidence: {
        eventId: r.id,
        resultBytes: r.resultBytes,
        estTokens,
      },
      confidence,
      confidenceReason,
      estTokensWeek: estTokens,
      firstSeen: r.ts,
      lastSeen: r.ts,
    });
  }

  return findings;
}
