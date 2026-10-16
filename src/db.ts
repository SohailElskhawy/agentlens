import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditItem, AuditKind, AuditStatus, Cursor, Finding, NormalizedEvent, QuotaSnapshot, Recommendation, SessionInfo } from './types.ts';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursors (
  path TEXT PRIMARY KEY, agent TEXT NOT NULL, byte_offset INTEGER NOT NULL, state TEXT NOT NULL DEFAULT '{}',
  errors INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, root TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, project_id INTEGER REFERENCES projects(id), cwd TEXT, parent_id TEXT);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, model TEXT,
  input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0, cache_write_1h INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
  tool TEXT, args_hash TEXT, result_bytes INTEGER, is_error INTEGER, text_hash TEXT, text_len INTEGER);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, ts);
CREATE TABLE IF NOT EXISTS quota_snapshots (
  agent TEXT NOT NULL, ts INTEGER NOT NULL, win TEXT NOT NULL, used_pct REAL NOT NULL, resets_at INTEGER NOT NULL,
  source TEXT NOT NULL, PRIMARY KEY (agent, win, ts));
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY, rule TEXT NOT NULL, project_id INTEGER REFERENCES projects(id),
  session_id TEXT, evidence TEXT NOT NULL, confidence TEXT NOT NULL, confidence_reason TEXT NOT NULL,
  est_tokens_week INTEGER NOT NULL DEFAULT 0, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS findings_project ON findings(project_id);
CREATE INDEX IF NOT EXISTS findings_rule ON findings(rule);
CREATE TABLE IF NOT EXISTS recommendations (
  id TEXT PRIMARY KEY, finding_rule TEXT NOT NULL, project_id INTEGER REFERENCES projects(id),
  action TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, action_snippet TEXT, catalog_ref TEXT,
  status TEXT NOT NULL DEFAULT 'open', accepted_at INTEGER, result TEXT, score INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS recs_project ON recommendations(project_id);
CREATE INDEX IF NOT EXISTS recs_status ON recommendations(status);
CREATE INDEX IF NOT EXISTS recs_score ON recommendations(score);
CREATE TABLE IF NOT EXISTS audit_items (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, project_id INTEGER REFERENCES projects(id),
  kind TEXT NOT NULL, name TEXT NOT NULL, source_path TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0,
  invocations_30d INTEGER NOT NULL DEFAULT 0, last_invoked INTEGER, status TEXT NOT NULL DEFAULT 'active',
  details TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS audit_project ON audit_items(project_id);
CREATE INDEX IF NOT EXISTS audit_kind ON audit_items(kind);
CREATE INDEX IF NOT EXISTS audit_status ON audit_items(status);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  try { db.exec('ALTER TABLE recommendations ADD COLUMN action_snippet TEXT;'); } catch {}
  try { db.exec('ALTER TABLE recommendations ADD COLUMN score INTEGER NOT NULL DEFAULT 0;'); } catch {}
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// node:sqlite rejects undefined bindings, so every optional field becomes null or 0.
export function upsertEvents(db: DB, events: NormalizedEvent[]) {
  const st = db.prepare(`
    INSERT INTO events (id, agent, session_id, ts, kind, model, input, output, cache_read, cache_write, cache_write_1h,
      reasoning, tool, args_hash, result_bytes, is_error, text_hash, text_len)
    VALUES ($id, $agent, $session, $ts, $kind, $model, $input, $output, $cacheRead, $cacheWrite, $cacheWrite1h,
      $reasoning, $tool, $argsHash, $resultBytes, $isError, $textHash, $textLen)
    ON CONFLICT(id) DO UPDATE SET
      input = max(input, excluded.input), output = max(output, excluded.output),
      cache_read = max(cache_read, excluded.cache_read), cache_write = max(cache_write, excluded.cache_write),
      cache_write_1h = max(cache_write_1h, excluded.cache_write_1h), reasoning = max(reasoning, excluded.reasoning)`);
  for (const e of events) {
    st.run({
      id: e.id, agent: e.agent, session: e.sessionId, ts: e.ts, kind: e.kind, model: e.model ?? null,
      input: e.input ?? 0, output: e.output ?? 0, cacheRead: e.cacheRead ?? 0, cacheWrite: e.cacheWrite ?? 0,
      cacheWrite1h: e.cacheWrite1h ?? 0, reasoning: e.reasoning ?? 0, tool: e.tool ?? null, argsHash: e.argsHash ?? null,
      resultBytes: e.resultBytes ?? null, isError: e.isError == null ? null : e.isError ? 1 : 0,
      textHash: e.textHash ?? null, textLen: e.textLen ?? null,
    });
  }
}

export function upsertSessions(db: DB, sessions: (SessionInfo & { projectId: number | null })[]) {
  const st = db.prepare(`
    INSERT INTO sessions (id, agent, project_id, cwd, parent_id) VALUES ($id, $agent, $projectId, $cwd, $parentId)
    ON CONFLICT(id) DO UPDATE SET project_id = coalesce(project_id, excluded.project_id),
      cwd = coalesce(cwd, excluded.cwd), parent_id = coalesce(parent_id, excluded.parent_id)`);
  for (const s of sessions) st.run({ id: s.id, agent: s.agent, projectId: s.projectId, cwd: s.cwd ?? null, parentId: s.parentId ?? null });
}

export function upsertProject(db: DB, root: string, name: string): number {
  db.prepare('INSERT INTO projects (root, name) VALUES (?, ?) ON CONFLICT(root) DO NOTHING').run(root, name);
  return (db.prepare('SELECT id FROM projects WHERE root = ?').get(root) as { id: number }).id;
}

export function insertQuotas(db: DB, quotas: QuotaSnapshot[]) {
  const st = db.prepare(`INSERT OR IGNORE INTO quota_snapshots (agent, ts, win, used_pct, resets_at, source)
    VALUES ($agent, $ts, $win, $usedPct, $resetsAt, $source)`);
  for (const q of quotas) st.run({ agent: q.agent, ts: q.ts, win: q.window, usedPct: q.usedPct, resetsAt: q.resetsAt, source: q.source });
}

export function getCursor(db: DB, path: string): Cursor | undefined {
  const r = db.prepare('SELECT byte_offset, state FROM cursors WHERE path = ?').get(path) as { byte_offset: number; state: string } | undefined;
  return r && { offset: r.byte_offset, state: JSON.parse(r.state) };
}

export function setCursor(db: DB, path: string, agent: string, cursor: Cursor, errors: number) {
  db.prepare(`INSERT INTO cursors (path, agent, byte_offset, state, errors, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET byte_offset = excluded.byte_offset, state = excluded.state,
      errors = errors + excluded.errors, updated_at = excluded.updated_at`)
    .run(path, agent, cursor.offset, JSON.stringify(cursor.state), errors, Date.now());
}

export function upsertFindings(db: DB, findings: Finding[]): void {
  const st = db.prepare(`
    INSERT INTO findings (id, rule, project_id, session_id, evidence, confidence, confidence_reason, est_tokens_week, first_seen, last_seen)
    VALUES ($id, $rule, $projectId, $sessionId, $evidence, $confidence, $confidenceReason, $estTokensWeek, $firstSeen, $lastSeen)
    ON CONFLICT(id) DO UPDATE SET
      evidence = excluded.evidence,
      confidence = excluded.confidence,
      confidence_reason = excluded.confidence_reason,
      est_tokens_week = max(findings.est_tokens_week, excluded.est_tokens_week),
      last_seen = excluded.last_seen
  `);
  for (const f of findings) {
    st.run({
      id: f.id,
      rule: f.rule,
      projectId: f.projectId ?? null,
      sessionId: f.sessionId ?? null,
      evidence: JSON.stringify(f.evidence ?? {}),
      confidence: f.confidence,
      confidenceReason: f.confidenceReason,
      estTokensWeek: f.estTokensWeek ?? 0,
      firstSeen: f.firstSeen,
      lastSeen: f.lastSeen,
    });
  }
}

export function getFindings(db: DB, filter?: { projectId?: number; rule?: string }): Finding[] {
  let sql = 'SELECT id, rule, project_id AS projectId, session_id AS sessionId, evidence, confidence, confidence_reason AS confidenceReason, est_tokens_week AS estTokensWeek, first_seen AS firstSeen, last_seen AS lastSeen FROM findings WHERE 1=1';
  const params: any[] = [];
  if (filter?.projectId != null) {
    sql += ' AND project_id = ?';
    params.push(filter.projectId);
  }
  if (filter?.rule != null) {
    sql += ' AND rule = ?';
    params.push(filter.rule);
  }
  sql += ' ORDER BY est_tokens_week DESC, last_seen DESC';
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map((r) => ({
    ...r,
    evidence: JSON.parse(r.evidence || '{}'),
  }));
}

export function upsertRecommendations(db: DB, recs: Recommendation[]): void {
  const st = db.prepare(`
    INSERT INTO recommendations (id, finding_rule, project_id, action, title, body, action_snippet, catalog_ref, status, accepted_at, result, score)
    VALUES ($id, $findingRule, $projectId, $action, $title, $body, $actionSnippet, $catalogRef, $status, $acceptedAt, $result, $score)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      body = excluded.body,
      action_snippet = excluded.action_snippet,
      catalog_ref = excluded.catalog_ref,
      score = excluded.score,
      result = coalesce(excluded.result, recommendations.result)
  `);
  for (const r of recs) {
    st.run({
      id: r.id,
      findingRule: r.findingRule,
      projectId: r.projectId ?? null,
      action: r.action,
      title: r.title,
      body: r.body,
      actionSnippet: r.actionSnippet ?? null,
      catalogRef: r.catalogRef ?? null,
      status: r.status ?? 'open',
      acceptedAt: r.acceptedAt ?? null,
      result: r.result ? JSON.stringify(r.result) : null,
      score: r.score ?? 0,
    });
  }
}

export function getRecommendations(db: DB, filter?: { projectId?: number; status?: string }): Recommendation[] {
  let sql = 'SELECT id, finding_rule AS findingRule, project_id AS projectId, action, title, body, action_snippet AS actionSnippet, catalog_ref AS catalogRef, status, accepted_at AS acceptedAt, result, score FROM recommendations WHERE 1=1';
  const params: any[] = [];
  if (filter?.projectId != null) {
    sql += ' AND project_id = ?';
    params.push(filter.projectId);
  }
  if (filter?.status != null) {
    sql += ' AND status = ?';
    params.push(filter.status);
  }
  sql += ' ORDER BY score DESC, id ASC';
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map((r) => ({
    ...r,
    actionSnippet: r.actionSnippet ?? undefined,
    result: r.result ? JSON.parse(r.result) : undefined,
  }));
}

export function updateRecommendationStatus(db: DB, id: string, status: string): boolean {
  const acceptedAt = status === 'accepted' ? Date.now() : null;
  const res = db.prepare(`
    UPDATE recommendations
    SET status = ?, accepted_at = coalesce(?, accepted_at)
    WHERE id = ?
  `).run(status, acceptedAt, id);
  return res.changes > 0;
}

export function upsertAuditItems(db: DB, items: AuditItem[]): void {
  const st = db.prepare(`
    INSERT INTO audit_items (id, agent, project_id, kind, name, source_path, tokens, invocations_30d, last_invoked, status, details, updated_at)
    VALUES ($id, $agent, $projectId, $kind, $name, $sourcePath, $tokens, $invocations30d, $lastInvoked, $status, $details, $updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      tokens = excluded.tokens,
      invocations_30d = excluded.invocations_30d,
      last_invoked = excluded.last_invoked,
      status = excluded.status,
      details = excluded.details,
      updated_at = excluded.updated_at
  `);
  tx(db, () => {
    for (const item of items) {
      st.run({
        id: item.id,
        agent: item.agent,
        projectId: item.projectId ?? null,
        kind: item.kind,
        name: item.name,
        sourcePath: item.sourcePath,
        tokens: item.tokens,
        invocations30d: item.invocations30d,
        lastInvoked: item.lastInvoked ?? null,
        status: item.status,
        details: JSON.stringify(item.details ?? {}),
        updatedAt: item.updatedAt,
      });
    }
  });
}

export function getAuditItems(
  db: DB,
  filter?: {
    projectId?: number;
    includeGlobal?: boolean;
    agent?: string;
    kind?: AuditKind;
    status?: AuditStatus;
  }
): AuditItem[] {
  let sql = 'SELECT id, agent, project_id AS projectId, kind, name, source_path AS sourcePath, tokens, invocations_30d AS invocations30d, last_invoked AS lastInvoked, status, details, updated_at AS updatedAt FROM audit_items WHERE 1=1';
  const params: any[] = [];
  if (filter?.projectId != null) {
    if (filter.includeGlobal) {
      sql += ' AND (project_id = ? OR project_id IS NULL)';
    } else {
      sql += ' AND project_id = ?';
    }
    params.push(filter.projectId);
  }
  if (filter?.agent != null) {
    sql += ' AND (agent = ? OR agent = \'all\')';
    params.push(filter.agent);
  }
  if (filter?.kind != null) {
    sql += ' AND kind = ?';
    params.push(filter.kind);
  }
  if (filter?.status != null) {
    sql += ' AND status = ?';
    params.push(filter.status);
  }
  sql += ' ORDER BY tokens DESC, name ASC';
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map((r) => ({
    ...r,
    details: JSON.parse(r.details || '{}'),
  }));
}

export function getSetting(db: DB, key: string, defaultValue = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : defaultValue;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function getAllSettings(db: DB): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const res: Record<string, string> = {};
  for (const r of rows) res[r.key] = r.value;
  return res;
}

