import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';
import { ABANDONED_SESSION_TOKEN_THRESHOLD, ABANDONED_SESSION_WINDOW_MS } from './constants.ts';
import { readGitNumstat } from './outcome_efficiency.ts';

const FILE_EDIT_TOOL_REGEX = /(edit|write|replace|patch|apply|notebook)/i;

export function detectAbandonedSessions(
  db: DB,
  options?: { sessionId?: string; projectId?: number; gitReader?: typeof readGitNumstat }
): Finding[] {
  const gitReader = options?.gitReader ?? readGitNumstat;
  let sql = `
    SELECT s.id AS sessionId,
           s.agent,
           s.project_id AS projectId,
           p.root AS projectRoot,
           count(e.id) AS turns,
           count(DISTINCT e.tool) AS toolCalls,
           sum(e.input + e.output + e.cache_read + e.cache_write) AS tokens,
           min(e.ts) AS started,
           max(e.ts) AS ended
    FROM sessions s
    LEFT JOIN projects p ON p.id = s.project_id
    JOIN events e ON e.session_id = s.id
    WHERE 1 = 1
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
    GROUP BY s.id
    HAVING sum(e.input + e.output + e.cache_read + e.cache_write) >= ?
  `;
  params.push(ABANDONED_SESSION_TOKEN_THRESHOLD);

  const candidateSessions = db.prepare(sql).all(...params) as Array<{
    sessionId: string;
    agent: string;
    projectId: number | null;
    projectRoot: string | null;
    turns: number;
    toolCalls: number;
    tokens: number;
    started: number;
    ended: number;
  }>;

  const findings: Finding[] = [];

  for (const s of candidateSessions) {
    // 1. Check if session used any file editing / writing tools
    const toolRows = db.prepare(`
      SELECT DISTINCT tool
      FROM events
      WHERE session_id = ? AND tool IS NOT NULL
    `).all(s.sessionId) as Array<{ tool: string }>;

    const hasFileEdit = toolRows.some((t) => FILE_EDIT_TOOL_REGEX.test(t.tool));
    if (hasFileEdit) {
      continue; // Session modified files, not abandoned
    }

    // 2. Check if a git commit occurred during or in the 30-minute window following the session
    let hasCommit = false;
    if (s.projectRoot) {
      const commits = gitReader(s.projectRoot);
      hasCommit = commits.some(
        (c) => c.ts >= s.started - 60_000 && c.ts <= s.ended + ABANDONED_SESSION_WINDOW_MS
      );
    }

    if (hasCommit) {
      continue; // A commit occurred shortly after or during the session
    }

    const confidence = s.tokens >= 100_000 ? 'high' : 'medium';
    findings.push({
      id: `abandoned_session:${s.sessionId}`,
      rule: 'abandoned_session',
      projectId: s.projectId ?? null,
      sessionId: s.sessionId,
      evidence: {
        sessionId: s.sessionId,
        agent: s.agent,
        tokens: s.tokens,
        turns: s.turns,
        toolCalls: s.toolCalls,
      },
      confidence,
      confidenceReason: `Session ${s.sessionId} consumed ${Math.round(s.tokens / 1000)}k tokens over ${s.turns} turns without producing file edits or commits.`,
      estTokensWeek: s.tokens,
      firstSeen: s.ended,
      lastSeen: s.ended,
    });
  }

  return findings;
}
