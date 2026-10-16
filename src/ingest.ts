import { statSync } from 'node:fs';
import { antigravity } from './adapters/antigravity.ts';
import { claude } from './adapters/claude.ts';
import { codex } from './adapters/codex.ts';
import { opencode } from './adapters/opencode.ts';
import { type DB, getCursor, insertQuotas, setCursor, tx, upsertEvents, upsertProject, upsertSessions } from './db.ts';
import { projectName, projectRoot } from './project.ts';
import type { Adapter, Cursor, ReadResult } from './types.ts';

export const ADAPTERS: Adapter[] = [claude, codex, opencode, antigravity];

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
      if (size < cursor.offset) cursor = { offset: 0, state: {} };

      let r: ReadResult;
      try { r = a.read(path, cursor); } catch (e) {
        console.error(`agentlens: could not read ${path}: ${(e as Error).message}`);
        stats.errors++;
        continue;
      }
      try {
        tx(db, () => {
          upsertEvents(db, r.events);
          upsertSessions(db, r.sessions.map((s) => {
            const root = typeof s.cwd === 'string' && s.cwd ? projectRoot(s.cwd) : undefined; // logs are untrusted: cwd may not be a string (or may be empty)
            return { ...s, projectId: root ? upsertProject(db, root, projectName(root)) : null };
          }));
          insertQuotas(db, r.quotas);
          setCursor(db, path, a.agent, r.cursor, r.errors);
        });
      } catch (e) { // one bad file must not wedge every later file and adapter
        console.error(`agentlens: could not ingest ${path}: ${(e as Error).message}`);
        stats.errors++;
        continue;
      }
      stats.read++;
      stats.events += r.events.length;
      stats.errors += r.errors;
      stats.skipped += r.skipped;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return stats;
}
