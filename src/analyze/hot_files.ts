import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';
import { HOT_FILE_READ_THRESHOLD } from './constants.ts';

const READ_TOOLS = new Set([
  'Read', 'View', 'ReadFile', 'readFile', 'read_file', 'cat', 'file_search', 'search_for_pattern', 'read_url_content',
]);

export function detectHotFiles(db: DB, options?: { sessionId?: string; projectId?: number }): Finding[] {
  let sql = `
    SELECT e.tool,
           e.args_hash AS argsHash,
           s.project_id AS projectId,
           count(*) AS cnt,
           count(DISTINCT e.session_id) AS sessionCnt,
           min(e.ts) AS firstTs,
           max(e.ts) AS lastTs,
           max(e.session_id) AS sampleSessionId
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
    GROUP BY e.tool, e.args_hash, s.project_id
    HAVING count(*) >= ?
    ORDER BY count(*) DESC
  `;
  params.push(HOT_FILE_READ_THRESHOLD);

  const rows = db.prepare(sql).all(...params) as any[];
  const findings: Finding[] = [];

  for (const r of rows) {
    if (!READ_TOOLS.has(r.tool) && !r.tool.toLowerCase().includes('read') && !r.tool.toLowerCase().includes('view')) {
      continue;
    }

    const estTokensWeek = Math.max(1, r.cnt - 1) * 2000;
    const confidence = r.cnt >= 5 ? 'high' : 'medium';
    const confidenceReason = `Read ${r.cnt} times across ${r.sessionCnt} session(s)`;

    findings.push({
      id: `hot_files:${r.projectId ?? 'global'}:${r.tool}:${r.argsHash}`,
      rule: 'hot_files',
      projectId: r.projectId ?? null,
      sessionId: r.sessionCnt === 1 ? r.sampleSessionId : null,
      evidence: {
        tool: r.tool,
        argsHash: r.argsHash,
        reads: r.cnt,
        sessionCount: r.sessionCnt,
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
