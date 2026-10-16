import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Adapter, Cursor, NormalizedEvent, ReadResult, SessionInfo } from '../types.ts';

export function getCursorCandidateRoots(home: string): string[] {
  const roots: string[] = [];
  if (process.platform === 'darwin') {
    roots.push(
      join(home, 'Library/Application Support/Cursor/User/globalStorage'),
      join(home, '.config/Cursor/User/globalStorage')
    );
  } else if (process.platform === 'win32') {
    if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'Cursor/User/globalStorage'));
    roots.push(join(home, 'AppData/Roaming/Cursor/User/globalStorage'));
  } else {
    roots.push(
      join(home, '.config/Cursor/User/globalStorage'),
      join(home, 'Library/Application Support/Cursor/User/globalStorage')
    );
  }
  return Array.from(new Set(roots));
}

export const cursor: Adapter = {
  agent: 'cursor',
  root: (home) => join(home, '.config/Cursor/User/globalStorage'),
  discover: (root) => {
    const candidateRoots = Array.from(new Set([root, ...getCursorCandidateRoots(homedir())]));
    const results: string[] = [];

    for (const r of candidateRoots) {
      const dbPath = join(r, 'state.vscdb');
      if (existsSync(dbPath)) results.push(dbPath);
    }
    return results;
  },

  read(path: string, cursorState: Cursor): ReadResult {
    let errors = 0;
    const events: NormalizedEvent[] = [];
    const sessions = new Map<string, SessionInfo>();

    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const rows = db.prepare(
        "SELECT key, value FROM ItemTable WHERE key LIKE '%composer%' OR key LIKE '%aichat%'"
      ).all() as { key: string; value: string }[];

      for (const row of rows) {
        if (!row.value) continue;
        try {
          const parsed = JSON.parse(row.value);
          const composers = parsed.allComposers || parsed.composers || (Array.isArray(parsed) ? parsed : [parsed]);

          for (const c of composers) {
            if (!c || typeof c !== 'object') continue;
            const sid = c.composerId || c.conversationId || c.id;
            if (!sid) continue;

            let cwd: string | undefined;
            if (c.workspaceUri) {
              try {
                cwd = c.workspaceUri.startsWith('file://') ? fileURLToPath(c.workspaceUri) : c.workspaceUri;
              } catch {}
            } else if (c.workspace || c.projectPath) {
              cwd = c.workspace || c.projectPath;
            }

            if (!sessions.has(sid)) {
              sessions.set(sid, { id: sid, agent: 'cursor', cwd });
            }

            const conversation = Array.isArray(c.conversation)
              ? c.conversation
              : Array.isArray(c.messages)
              ? c.messages
              : [];

            for (let i = 0; i < conversation.length; i++) {
              const msg = conversation[i];
              if (!msg || typeof msg !== 'object') continue;
              const isAi = msg.type === 'ai' || msg.role === 'assistant' || msg.bubbleId?.includes('ai');
              if (!isAi) continue;

              const ts = msg.createdAt || msg.timestamp || c.lastUpdatedAt || c.createdAt || Date.now();
              const model = msg.modelType || msg.model || c.model || 'cursor-small';
              const tok = msg.tokenCount || msg.tokens || {};
              const input = tok.inputTokens ?? tok.input ?? msg.inputTokens ?? 0;
              const output = tok.outputTokens ?? tok.output ?? msg.outputTokens ?? 0;
              const cacheRead = tok.cacheReadTokens ?? tok.cacheRead ?? 0;

              events.push({
                id: `cursor:${sid}:${msg.bubbleId || msg.id || i + 1}`,
                agent: 'cursor',
                sessionId: sid,
                ts: typeof ts === 'number' ? ts : Date.parse(ts) || Date.now(),
                kind: 'assistant',
                model,
                input,
                output,
                cacheRead,
              });
            }
          }
        } catch {
          // Bad JSON entry
        }
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

    let offset = 0;
    try {
      offset = statSync(path).size;
      try {
        offset += statSync(`${path}-wal`).size;
      } catch {}
    } catch {}

    return {
      events,
      sessions: Array.from(sessions.values()),
      quotas: [],
      cursor: { offset, state: {} },
      errors,
      skipped: 0,
    };
  },
};
