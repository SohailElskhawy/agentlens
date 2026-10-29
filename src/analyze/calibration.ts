import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';
import { CALIBRATION_WINDOW_MS } from './constants.ts';

export interface ScopeBudgets {
  session: Map<string, number>;
  project: Map<number, number>;
  global: number;
}

/**
 * Weekly trailing-window token budgets, loaded with one grouped query over the events index.
 * LEFT JOIN sessions keeps orphan events (session not ingested) in global/session totals;
 * events whose session has no project count toward the global total only.
 */
export function loadScopeBudgets(db: DB, now: number): ScopeBudgets {
  const from = now - CALIBRATION_WINDOW_MS;
  const rows = db.prepare(`
    SELECT e.session_id AS sessionId, s.project_id AS projectId,
           sum(e.input + e.output + e.cache_read + e.cache_write) AS tokens
    FROM events e
    LEFT JOIN sessions s ON s.id = e.session_id
    WHERE e.ts >= ? AND e.ts <= ?
    GROUP BY e.session_id, s.project_id
  `).all(from, now) as Array<{ sessionId: string; projectId: number | null; tokens: number | null }>;

  const session = new Map<string, number>();
  const project = new Map<number, number>();
  let global = 0;
  for (const r of rows) {
    const tokens = r.tokens ?? 0;
    session.set(r.sessionId, (session.get(r.sessionId) ?? 0) + tokens);
    global += tokens;
    if (r.projectId != null) project.set(r.projectId, (project.get(r.projectId) ?? 0) + tokens);
  }
  return { session, project, global };
}

/** Narrowest scope wins; a scope with no weekly events has budget zero, no broader fallback. */
function scopeBudget(f: Pick<Finding, 'sessionId' | 'projectId'>, budgets: ScopeBudgets): number {
  if (f.sessionId != null) return budgets.session.get(f.sessionId) ?? 0;
  if (f.projectId != null) return budgets.project.get(f.projectId) ?? 0;
  return budgets.global;
}

/** Cap formula: min(max(0, raw), budget), each finding independently (caps do not de-duplicate). */
export function calibrateFindings(findings: Finding[], budgets: ScopeBudgets): void {
  for (const f of findings) {
    f.estTokensWeek = Math.min(Math.max(0, f.estTokensWeek ?? 0), scopeBudget(f, budgets));
  }
}

/** Stale values can only fall; recovery requires a fresh estimate from their producer on a later run. */
export function capStoredFindings(db: DB, budgets: ScopeBudgets): void {
  const rows = db.prepare(
    'SELECT id, session_id AS sessionId, project_id AS projectId, est_tokens_week AS est FROM findings'
  ).all() as Array<{ id: string; sessionId: string | null; projectId: number | null; est: number }>;
  const st = db.prepare('UPDATE findings SET est_tokens_week = ? WHERE id = ?');
  for (const r of rows) {
    const capped = Math.min(Math.max(0, r.est ?? 0), scopeBudget(r, budgets));
    if (capped !== r.est) st.run(capped, r.id);
  }
}
