import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Adapter, Cursor, NormalizedEvent, ReadResult, SessionInfo } from '../types.ts';
import { hash } from '../util.ts';

export const CLINE_EXT_DIR = 'saoudrizwan.claude-dev';

// Cline classic/legacy task layout (T51 evidence, verified against cline/cline v4.1.26):
// tasks/<taskId>/api_conversation_history.json + ui_messages.json, HistoryItem in state/taskHistory.json.
// SDK-era (~/.cline/data/sessions) and Roo Code storage are NOT read: unverified by the evidence.

export function getClineGlobalStorageRoots(home: string): string[] {
  const roots: string[] = [];
  if (process.platform === 'darwin') {
    roots.push(
      join(home, 'Library/Application Support/Code/User/globalStorage'),
      join(home, '.config/Code/User/globalStorage'),
    );
  } else if (process.platform === 'win32') {
    if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'Code/User/globalStorage'));
    roots.push(
      join(home, 'AppData/Roaming/Code/User/globalStorage'),
      join(home, '.config/Code/User/globalStorage'),
    );
  } else {
    roots.push(
      join(home, '.config/Code/User/globalStorage'),
      join(home, 'Library/Application Support/Code/User/globalStorage'),
    );
  }
  return Array.from(new Set(roots));
}

export const cline: Adapter = {
  agent: 'cline',
  root(home: string): string {
    for (const candidate of getClineGlobalStorageRoots(home)) {
      if (existsSync(join(candidate, CLINE_EXT_DIR, 'tasks'))) return candidate;
    }
    return getClineGlobalStorageRoots(home)[0];
  },
  discover(root: string): string[] {
    // Single-level glob under the extension's tasks dir only; never a home-wide glob.
    try {
      return globSync(`${CLINE_EXT_DIR}/tasks/*/api_conversation_history.json`, { cwd: root })
        .map((f) => join(root, f))
        .sort();
    } catch {
      return [];
    }
  },
  // shortcut: cursor keys on the api-history file only, so ui_messages.json rows appended after the
  // last api request are missed until the next api turn; upgrade when the file pair can share a cursor.
  read(path: string, _cursor: Cursor): ReadResult {
    let errors = 0;
    const events: NormalizedEvent[] = [];
    const sessions: SessionInfo[] = [];

    const taskId = basename(dirname(path));
    if (!taskId || taskId.includes('\0')) {
      return { events, sessions, quotas: [], cursor: { offset: 0, state: {} }, errors, skipped: 0 };
    }
    const sid = hash(taskId); // only hashed session/task ids are recorded

    const taskDir = dirname(path);
    const extDir = dirname(dirname(taskDir));
    let model: string | undefined;
    let cwd: string | undefined;
    const historyPath = join(extDir, 'state', 'taskHistory.json');
    if (existsSync(historyPath)) {
      try {
        const items = JSON.parse(readFileSync(historyPath, 'utf8'));
        if (Array.isArray(items)) {
          const item = items.find((h: any) => h && typeof h === 'object' && h.id === taskId);
          if (item && typeof item === 'object') {
            if (typeof item.modelId === 'string' && item.modelId) model = item.modelId;
            if (typeof item.cwdOnTaskInitialization === 'string' && item.cwdOnTaskInitialization) cwd = item.cwdOnTaskInitialization;
          }
        }
      } catch {
        errors++; // corrupt history: session still recorded, without its metadata
      }
    }
    // Cumulative counters on the HistoryItem (tokensIn/tokensOut/...) are client-side sums the UI also
    // derives per request; they are deliberately not read here so usage is never double-counted.

    try {
      const rows = JSON.parse(readFileSync(join(taskDir, 'ui_messages.json'), 'utf8'));
      if (Array.isArray(rows)) {
        const errorSays = new Set(['error', 'diff_error', 'clineignore_error']);
        rows.forEach((row: any, i: number) => {
          try {
            if (!row || typeof row !== 'object' || typeof row.ts !== 'number') return;
            if (row.type === 'say' && row.say === 'api_req_started') {
              // Usage dropped here is per-request deltas of disjoint buckets, exactly as getApiMetrics sums them.
              let info: any;
              try {
                info = typeof row.text === 'string' ? JSON.parse(row.text) : undefined;
              } catch {
                errors++; // partial/streaming row: skip it
                return;
              }
              if (!info || typeof info !== 'object') return;
              const hasUsage = ['tokensIn', 'tokensOut', 'cacheWrites', 'cacheReads'].some(
                (k) => typeof info[k] === 'number',
              );
              if (!hasUsage) return; // started row with no usage yet
              events.push({
                id: `cline:${sid}:req:${i}`,
                agent: 'cline',
                sessionId: sid,
                ts: row.ts,
                kind: 'assistant',
                model,
                input: typeof info.tokensIn === 'number' ? info.tokensIn : 0,
                output: typeof info.tokensOut === 'number' ? info.tokensOut : 0,
                cacheRead: typeof info.cacheReads === 'number' ? info.cacheReads : 0,
                cacheWrite: typeof info.cacheWrites === 'number' ? info.cacheWrites : 0,
              });
            } else if ((row.type === 'say' && typeof row.say === 'string' && errorSays.has(row.say)) || (row.type === 'ask' && row.ask === 'api_req_failed')) {
              // Only the error flag is recorded; row.text (the raw error/prompt message) is never stored.
              events.push({
                id: `cline:${sid}:err:${i}`,
                agent: 'cline',
                sessionId: sid,
                ts: row.ts,
                kind: 'tool_result',
                isError: true,
              });
            }
          } catch {
            errors++; // one bad ui row must not sink the rest of the task
          }
        });
      } else {
        errors++;
      }
    } catch {
      errors++; // missing/corrupt ui_messages.json: usage unknown, but nothing may throw out of ingest
    }

    let offset = 0;
    try {
      offset = statSync(path).size;
    } catch {}

    sessions.push({ id: sid, agent: 'cline', cwd });
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
