import { statSync } from 'node:fs';
import { antigravity } from './adapters/antigravity.ts';
import { claude } from './adapters/claude.ts';
import { codex } from './adapters/codex.ts';
import { opencode } from './adapters/opencode.ts';
import { gemini } from './adapters/gemini.ts';
import { aider } from './adapters/aider.ts';
import { cursor } from './adapters/cursor.ts';
import { type DB, getCursor, insertQuotas, setCursor, tx, upsertEvents, upsertProject, upsertSessions } from './db.ts';
import { runDetectors } from './analyze/runner.ts';
import { evaluateRecommendations } from './track.ts';
import { projectName, projectRoot } from './project.ts';
import type { Adapter, Cursor, ReadResult } from './types.ts';
import { isAnalystCwd } from './temp-project.ts';
import { refreshRecommendations } from './recommend.ts';

export const ADAPTERS: Adapter[] = [claude, codex, opencode, antigravity, gemini, aider, cursor];

export interface IngestStats { files: number; read: number; events: number; errors: number; skipped: number }

/**
 * Reads only what was appended since the last run (a file that shrank is re-read from 0; upserts keep that
 * idempotent). Yields to the event loop between files so the dashboard stays responsive during the first backfill.
 */
export async function ingest(db: DB, home: string, adapters = ADAPTERS): Promise<IngestStats> {
  const stats: IngestStats = { files: 0, read: 0, events: 0, errors: 0, skipped: 0 };
  for (const a of adapters) {
    for (const path of a.discover(a.root(home))) {
      stats.files++;
      let size: number;
      try {
        size = statSync(path).size;
        if (path.endsWith('.db')) {
          try { size += statSync(`${path}-wal`).size; } catch {}
        }
      } catch { continue; } // deleted between discover and read
      let cursor: Cursor = getCursor(db, path) ?? { offset: 0, state: {} };
      if (size === cursor.offset) continue;
      if (size < cursor.offset) {
        cursor = path.endsWith('.db') ? { offset: 0, state: cursor.state } : { offset: 0, state: {} };
      }

      let r: ReadResult;
      try { r = a.read(path, cursor); } catch (e) {
        console.error(`agentlens: could not read ${path}: ${(e as Error).message}`);
        stats.errors++;
        continue;
      }
      try {
        tx(db, () => {
          const blocked = new Set<string>();
          const known = db.prepare('SELECT cwd FROM sessions WHERE id = ?');
          const ignored = db.prepare('SELECT 1 FROM ignored_analyst_sessions WHERE id = ?');
          const remember = db.prepare('INSERT OR IGNORE INTO ignored_analyst_sessions (id) VALUES (?)');
          for (const s of r.sessions) if (isAnalystCwd(s.cwd)) blocked.add(s.id);
          for (const id of new Set([...r.sessions.map((s) => s.id), ...r.events.map((e) => e.sessionId)])) {
            const row = known.get(id) as { cwd: string | null } | undefined;
            if (isAnalystCwd(row?.cwd) || ignored.get(id)) blocked.add(id);
          }
          for (const id of blocked) remember.run(id);
          const events = r.events.filter((e) => !blocked.has(e.sessionId));
          upsertEvents(db, events);
          upsertSessions(db, r.sessions.filter((s) => !blocked.has(s.id)).map((s) => {
            const root = typeof s.cwd === 'string' && s.cwd ? projectRoot(s.cwd) : undefined; // logs are untrusted: cwd may not be a string (or may be empty)
            return { ...s, projectId: root ? upsertProject(db, root, projectName(root)) : null };
          }));
          insertQuotas(db, r.quotas);
          setCursor(db, path, a.agent, r.cursor, r.errors);
          stats.events += events.length;
        });
      } catch (e) { // one bad file must not wedge every later file and adapter
        console.error(`agentlens: could not ingest ${path}: ${(e as Error).message}`);
        stats.errors++;
        continue;
      }
      stats.read++;
      stats.errors += r.errors;
      stats.skipped += r.skipped;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  if (stats.read > 0) {
    try {
      runDetectors(db);
      refreshRecommendations(db);
      evaluateRecommendations(db);
    } catch (e) {
      console.error(`agentlens: detector error: ${(e as Error).message}`);
    }
  }

  return stats;
}
