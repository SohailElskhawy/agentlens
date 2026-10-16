import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Adapter, Cursor, NormalizedEvent, ReadResult, SessionInfo } from '../types.ts';

function runCcusageSession(): any {
  try {
    const raw = execFileSync('ccusage', ['antigravity', 'session', '--json'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export interface AntigravityAdapter extends Adapter {
  read(path: string, cursor: Cursor, ccusageRunner?: () => any): ReadResult;
}

export const antigravity: AntigravityAdapter = {
  agent: 'antigravity',
  root(home: string): string {
    return join(home, '.gemini');
  },
  discover(root: string): string[] {
    const candidates = [
      join(root, 'antigravity-cli/conversation_summaries.db'),
      join(root, 'antigravity/conversation_summaries.db'),
    ];
    return candidates.filter((p) => existsSync(p));
  },
  read(path: string, cursor: Cursor, ccusageRunner = runCcusageSession): ReadResult {
    let errors = 0;
    const sessions: SessionInfo[] = [];
    const events: NormalizedEvent[] = [];

    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const rows = db.prepare(
        'SELECT conversation_id, title, workspace_uris, last_modified_time, parent_conversation_id FROM conversation_summaries',
      ).all() as {
        conversation_id: string;
        title: string;
        workspace_uris: string;
        last_modified_time: string;
        parent_conversation_id: string;
      }[];

      for (const r of rows) {
        let cwd: string | undefined;
        try {
          const uris = JSON.parse(r.workspace_uris);
          if (Array.isArray(uris) && uris.length > 0 && typeof uris[0] === 'string') {
            if (uris[0].startsWith('file://')) {
              cwd = fileURLToPath(uris[0]);
            } else {
              cwd = uris[0];
            }
          }
        } catch {
          // workspace_uris was not valid JSON
        }

        sessions.push({
          id: r.conversation_id,
          agent: 'antigravity',
          cwd,
          parentId: r.parent_conversation_id ? r.parent_conversation_id : undefined,
        });
      }
    } catch {
      errors++;
    } finally {
      if (db) {
        try {
          db.close();
        } catch {}
      }
    }

    // Attempt token retrieval via ccusage
    try {
      const ccusageData = ccusageRunner();
      if (ccusageData && Array.isArray(ccusageData.sessions)) {
        for (const s of ccusageData.sessions) {
          if (!s.sessionId) continue;
          const ts = new Date(s.lastActivity || s.firstActivity || Date.now()).getTime();
          events.push({
            id: `antigravity:${s.sessionId}`,
            agent: 'antigravity',
            sessionId: s.sessionId,
            ts: Number.isNaN(ts) ? Date.now() : ts,
            kind: 'assistant',
            model: s.modelsUsed?.[0] ?? 'gemini-3.8-flash-high',
            input: s.inputTokens ?? 0,
            output: s.outputTokens ?? 0,
            cacheRead: s.cacheReadTokens ?? 0,
            cacheWrite: s.cacheCreationTokens ?? 0,
          });
        }
      }
    } catch {
      // ccusage bridge failed, session metadata is still preserved
    }

    let offset = 0;
    try {
      offset = statSync(path).size;
      try { offset += statSync(`${path}-wal`).size; } catch {}
    } catch {}

    return {
      events,
      sessions,
      quotas: [],
      cursor: { offset, state: {} },
      errors,
      skipped: 0,
    };
  },
};
