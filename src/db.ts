import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Cursor, NormalizedEvent, QuotaSnapshot, SessionInfo } from './types.ts';

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
`;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
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
