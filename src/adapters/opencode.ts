import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getOpenCodeDataRoots } from '../paths.ts';
import type { Adapter, Cursor, NormalizedEvent, ReadResult, SessionInfo } from '../types.ts';
import { hash } from '../util.ts';

export function inferHomeFromRoot(root: string): string | undefined {
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const candidateSuffixes = [
    '/.local/share/opencode',
    '/Library/Application Support/opencode',
  ];
  for (const suffix of candidateSuffixes) {
    if (normalized.endsWith(suffix)) {
      return normalized.slice(0, -suffix.length);
    }
  }
  const windowsSuffixes = [
    '/AppData/Roaming/opencode',
    '/AppData/Local/opencode',
  ];
  const lower = normalized.toLowerCase();
  for (const suffix of windowsSuffixes) {
    if (lower.endsWith(suffix.toLowerCase())) {
      return normalized.slice(0, -suffix.length);
    }
  }
  return undefined;
}

export const opencode: Adapter = {
  agent: 'opencode',
  root(home: string): string {
    const candidates = getOpenCodeDataRoots(home);
    for (const candidate of candidates) {
      if (existsSync(join(candidate, 'opencode.db'))) {
        return candidate;
      }
    }
    return candidates[0] ?? join(home, '.local/share/opencode');
  },
  discover(root: string): string[] {
    const dbPath = join(root, 'opencode.db');
    if (existsSync(dbPath)) {
      return [dbPath];
    }
    const targetHome = inferHomeFromRoot(root) ?? root;
    const candidates = getOpenCodeDataRoots(targetHome);
    for (const candidate of candidates) {
      const candidateDb = join(candidate, 'opencode.db');
      if (existsSync(candidateDb)) {
        return [candidateDb];
      }
    }
    return [];
  },
  read(path: string, cursor: Cursor): ReadResult {
    let errors = 0;
    const events: NormalizedEvent[] = [];
    const sessions: SessionInfo[] = [];

    const lastMessageTime = Number(cursor.state.lastMessageTime ?? 0);
    const lastPartTime = Number(cursor.state.lastPartTime ?? 0);
    let maxMessageTime = lastMessageTime;
    let maxPartTime = lastPartTime;

    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });

      // Sessions: opencode doesn't update session directory, so all sessions can be read or queried
      try {
        const sessionRows = db.prepare('SELECT id, directory, parent_id FROM session').all() as {
          id: string;
          directory: string;
          parent_id: string | null;
        }[];
        for (const s of sessionRows) {
          sessions.push({
            id: s.id,
            agent: 'opencode',
            cwd: s.directory ?? undefined,
            parentId: s.parent_id ?? undefined,
          });
        }
      } catch (e) {
        errors++;
      }

      // Messages: incremental by time_created
      const msgEventsById = new Map<string, NormalizedEvent>();
      try {
        const msgRows = db.prepare(
          'SELECT id, session_id, time_created, data FROM message WHERE time_created > ? ORDER BY time_created ASC',
        ).all(lastMessageTime) as { id: string; session_id: string; time_created: number; data: string }[];

        for (const m of msgRows) {
          if (m.time_created > maxMessageTime) maxMessageTime = m.time_created;
          let d: any;
          try {
            d = JSON.parse(m.data);
          } catch {
            errors++;
            continue;
          }

          const ts = typeof d.time?.created === 'number' ? d.time.created : m.time_created;
          if (d.role === 'user') {
            const ev: NormalizedEvent = {
              id: `opencode:${m.id}`,
              agent: 'opencode',
              sessionId: m.session_id,
              ts,
              kind: 'user',
            };
            events.push(ev);
            msgEventsById.set(m.id, ev);
          } else if (d.role === 'assistant') {
            const tokens = d.tokens;
            const ev: NormalizedEvent = {
              id: `opencode:${m.id}`,
              agent: 'opencode',
              sessionId: m.session_id,
              ts,
              kind: 'assistant',
              model: d.modelID ?? undefined,
              input: tokens?.input ?? 0,
              output: tokens?.output ?? 0,
              reasoning: tokens?.reasoning ?? 0,
              cacheRead: tokens?.cache?.read ?? 0,
              cacheWrite: tokens?.cache?.write ?? 0,
            };
            events.push(ev);
            msgEventsById.set(m.id, ev);
          }
        }
      } catch (e) {
        errors++;
      }

      // Parts: tool calls, results, and text prompts
      try {
        const partRows = db.prepare(
          'SELECT id, message_id, session_id, time_created, data FROM part WHERE time_created > ? ORDER BY time_created ASC',
        ).all(lastPartTime) as { id: string; message_id: string; session_id: string; time_created: number; data: string }[];

        for (const p of partRows) {
          if (p.time_created > maxPartTime) maxPartTime = p.time_created;
          let d: any;
          try {
            d = JSON.parse(p.data);
          } catch {
            errors++;
            continue;
          }

          if (d.type === 'text' && typeof d.text === 'string') {
            const userEv = msgEventsById.get(p.message_id);
            if (userEv) {
              userEv.textHash = hash(d.text);
              userEv.textLen = d.text.length;
            }
          } else if (d.type === 'tool') {
            const toolName = d.tool || d.state?.tool || 'unknown';
            const input = d.state?.input ?? {};
            const output = d.state?.output;
            const callId = `opencode:${p.id}`;
            const isError = d.state?.status === 'error' || (typeof d.state?.metadata?.exit === 'number' && d.state.metadata.exit !== 0);
            const resultBytes = typeof output === 'string' ? Buffer.byteLength(output, 'utf8') : 0;

            events.push({
              id: callId,
              agent: 'opencode',
              sessionId: p.session_id,
              ts: p.time_created,
              kind: 'tool_call',
              tool: toolName,
              argsHash: hash(JSON.stringify(input)),
            });

            events.push({
              id: `${callId}:result`,
              agent: 'opencode',
              sessionId: p.session_id,
              ts: p.time_created,
              kind: 'tool_result',
              isError,
              resultBytes,
            });
          }
        }
      } catch (e) {
        errors++;
      }
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
      try { offset += statSync(`${path}-wal`).size; } catch {}
    } catch {}

    return {
      events,
      sessions,
      quotas: [],
      cursor: {
        offset,
        state: {
          lastMessageTime: String(maxMessageTime),
          lastPartTime: String(maxPartTime),
        },
      },
      errors,
      skipped: 0,
    };
  },
};
