import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { readLines } from '../jsonl.ts';
import { hash } from '../util.ts';
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

function readAntigravityModel(baseDir: string): string {
  try {
    const settingsPath = join(baseDir, 'settings.json');
    if (existsSync(settingsPath)) {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (parsed && typeof parsed.model === 'string' && parsed.model.trim()) {
        return parsed.model.trim();
      }
    }
  } catch {}
  return 'Gemini 4 Argon (High)';
}

function readTranscriptJsonl(path: string, cursor: Cursor): ReadResult {
  let errors = 0;
  const events: NormalizedEvent[] = [];
  // Path layout: <baseDir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl
  const logsDir = dirname(path);
  const sysGenDir = dirname(logsDir);
  const convDir = dirname(sysGenDir);
  const brainDir = dirname(convDir);
  const baseDir = dirname(brainDir);
  const convId = basename(convDir);
  const defaultModel = readAntigravityModel(baseDir);
  let explicitCwd: string | undefined;
  let fallbackFileCwd: string | undefined;

  const { offset, dropped } = readLines(path, cursor.offset, (line) => {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      errors++;
      return;
    }
    if (!r || typeof r !== 'object') {
      errors++;
      return;
    }

    const parsedTs = r.created_at ? Date.parse(r.created_at) : Date.now();
    const ts = Number.isNaN(parsedTs) ? Date.now() : parsedTs;
    const stepIdx = r.step_index ?? events.length;

    if (r.type === 'USER_INPUT') {
      const content = typeof r.content === 'string' ? r.content : '';
      events.push({
        id: `antigravity:${convId}:step:${stepIdx}`,
        agent: 'antigravity',
        sessionId: convId,
        ts,
        kind: 'user',
        textHash: content ? hash(content) : undefined,
        textLen: content.length,
      });
    } else if (r.type === 'PLANNER_RESPONSE') {
      const thinking = typeof r.thinking === 'string' ? r.thinking : '';
      const input = Number(r.input_tokens ?? 0);
      const output = Number(r.output_tokens ?? 0);
      const cacheRead = Number(r.cache_read_tokens ?? 0);
      const cacheWrite = Number(r.cache_write_tokens ?? 0);
      const reasoning = Number(r.thinking_tokens ?? (thinking ? Math.ceil(thinking.length / 4) : 0));

      events.push({
        id: `antigravity:${convId}:step:${stepIdx}`,
        agent: 'antigravity',
        sessionId: convId,
        ts,
        kind: 'assistant',
        model: typeof r.model === 'string' && r.model ? r.model : defaultModel,
        input,
        output,
        cacheRead,
        cacheWrite,
        reasoning,
      });

      if (Array.isArray(r.tool_calls)) {
        for (let ti = 0; ti < r.tool_calls.length; ti++) {
          const tc = r.tool_calls[ti];
          if (!tc || typeof tc !== 'object') continue;
          const toolName = tc.name || tc.tool_name || 'unknown';
          const args = tc.args || tc.arguments || {};
          if (args && typeof args === 'object') {
            if (!explicitCwd && typeof args.Cwd === 'string' && args.Cwd.startsWith('/')) {
              explicitCwd = args.Cwd;
            } else if (!fallbackFileCwd) {
              if (typeof args.AbsolutePath === 'string' && args.AbsolutePath.startsWith('/')) {
                fallbackFileCwd = dirname(args.AbsolutePath);
              } else if (typeof args.TargetFile === 'string' && args.TargetFile.startsWith('/')) {
                fallbackFileCwd = dirname(args.TargetFile);
              }
            }
          }
          events.push({
            id: `antigravity:${convId}:step:${stepIdx}:tc:${ti}`,
            agent: 'antigravity',
            sessionId: convId,
            ts,
            kind: 'tool_call',
            tool: String(toolName),
            argsHash: hash(JSON.stringify(args)),
          });
        }
      }
    } else if (r.type === 'GENERIC' && r.source === 'MODEL') {
      const content = typeof r.content === 'string' ? r.content : '';
      events.push({
        id: `antigravity:${convId}:step:${stepIdx}`,
        agent: 'antigravity',
        sessionId: convId,
        ts,
        kind: 'tool_result',
        resultBytes: Buffer.byteLength(content, 'utf8'),
        isError: r.status === 'ERROR',
        textHash: content ? hash(content) : undefined,
        textLen: content.length,
      });
    }
  });

  const inferredCwd = explicitCwd || fallbackFileCwd;
  return {
    events,
    sessions: [{ id: convId, agent: 'antigravity', cwd: inferredCwd }],
    quotas: [],
    cursor: { offset, state: {} },
    errors,
    skipped: dropped,
  };
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
    const baseDirs = [
      join(root, 'antigravity-cli'),
      join(root, 'antigravity'),
    ];
    if (process.platform === 'darwin') {
      const macSupport = join(homedir(), 'Library/Application Support');
      baseDirs.push(
        join(macSupport, 'Google/Antigravity'),
        join(macSupport, 'antigravity'),
        join(macSupport, 'antigravity-cli'),
      );
    }

    const discovered: string[] = [];
    for (const baseDir of baseDirs) {
      const dbPath = join(baseDir, 'conversation_summaries.db');
      if (existsSync(dbPath)) {
        discovered.push(dbPath);
      }
      const brainDir = join(baseDir, 'brain');
      if (existsSync(brainDir)) {
        try {
          for (const entry of readdirSync(brainDir)) {
            const transcriptPath = join(brainDir, entry, '.system_generated', 'logs', 'transcript.jsonl');
            if (existsSync(transcriptPath)) {
              discovered.push(transcriptPath);
            }
          }
        } catch {}
      }
    }
    return discovered;
  },
  read(path: string, cursor: Cursor, ccusageRunner = runCcusageSession): ReadResult {
    if (path.endsWith('.jsonl')) {
      return readTranscriptJsonl(path, cursor);
    }

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

    // Only invoke external ccusage fallback if a custom runner is provided (e.g. unit tests)
    // or if no native brain/ transcript directory exists alongside conversation_summaries.db.
    const hasNativeBrain = existsSync(join(dirname(path), 'brain'));
    if (ccusageRunner !== runCcusageSession || !hasNativeBrain) {
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
