import { existsSync, globSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { readLines } from '../jsonl.ts';
import { hash } from '../util.ts';
import type { Adapter, Cursor, NormalizedEvent, ReadResult, SessionInfo } from '../types.ts';

export function getGeminiCandidateRoots(home: string): string[] {
  const roots: string[] = [join(home, '.gemini')];
  if (process.platform === 'darwin') {
    roots.push(join(home, 'Library/Application Support/gemini'), join(home, 'Library/Application Support/Google/Gemini'));
  } else if (process.platform === 'win32') {
    if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'gemini'));
    if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'gemini'));
  } else {
    roots.push(join(home, '.config/gemini'));
  }
  return Array.from(new Set(roots));
}

export const gemini: Adapter = {
  agent: 'gemini',
  root: (home) => join(home, '.gemini'),
  discover: (root) => {
    const candidateRoots = Array.from(new Set([root, ...getGeminiCandidateRoots(homedir())]));
    const results: string[] = [];

    for (const r of candidateRoots) {
      if (!existsSync(r)) continue;
      const patterns = [
        'sessions/*.jsonl',
        'sessions/*.json',
        'chats/*.jsonl',
        'chats/*.json',
        'logs/*.jsonl',
        'history/*.jsonl',
        '*.jsonl',
      ];
      for (const pat of patterns) {
        try {
          const files = globSync(pat, { cwd: r }).map((f) => join(r, f));
          results.push(...files);
        } catch {}
      }
    }

    return Array.from(new Set(results));
  },

  read(path: string, cursor: Cursor): ReadResult {
    const ext = extname(path).toLowerCase();
    const events: NormalizedEvent[] = [];
    const sessions = new Map<string, SessionInfo>();
    let errors = 0;

    if (ext === '.json') {
      let offset = 0;
      try {
        const content = readFileSync(path, 'utf8');
        offset = content.length;
        const parsed = JSON.parse(content);
        const records = Array.isArray(parsed) ? parsed : parsed.sessions || [parsed];
        for (const r of records) {
          const sid = r.sessionId || r.id || basename(path, '.json');
          const ts = r.timestamp ? (typeof r.timestamp === 'number' ? r.timestamp : Date.parse(r.timestamp)) : Date.now();
          if (!sessions.has(sid)) {
            sessions.set(sid, { id: sid, agent: 'gemini', cwd: r.cwd || r.projectPath });
          }
          const input = r.inputTokens ?? r.promptTokens ?? r.tokens?.prompt ?? 0;
          const output = r.outputTokens ?? r.candidateTokens ?? r.tokens?.candidates ?? 0;
          const cacheRead = r.cacheReadTokens ?? r.tokens?.cached ?? 0;
          const model = r.model ?? 'gemini-2.5-flash';

          events.push({
            id: `gemini:${sid}:${events.length + 1}`,
            agent: 'gemini',
            sessionId: sid,
            ts: Number.isNaN(ts) ? Date.now() : ts,
            kind: 'assistant',
            model,
            input,
            output,
            cacheRead,
            reasoning: r.thinkingTokens ?? 0,
          });

          if (Array.isArray(r.tools)) {
            for (const t of r.tools) {
              events.push({
                id: `gemini:${sid}:tool:${events.length + 1}`,
                agent: 'gemini',
                sessionId: sid,
                ts: Number.isNaN(ts) ? Date.now() : ts,
                kind: 'tool_call',
                tool: typeof t === 'string' ? t : t.name,
                argsHash: hash(JSON.stringify(t.args || {})),
              });
            }
          }
        }
      } catch {
        errors++;
      }
      return {
        events,
        sessions: Array.from(sessions.values()),
        quotas: [],
        cursor: { offset, state: {} },
        errors,
        skipped: 0,
      };
    }

    // JSONL parser
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

      const sid = r.sessionId || r.id || basename(path, '.jsonl');
      const ts = r.timestamp ? (typeof r.timestamp === 'number' ? r.timestamp : Date.parse(r.timestamp)) : Date.now();
      if (!sessions.has(sid)) {
        sessions.set(sid, { id: sid, agent: 'gemini', cwd: r.cwd || r.projectPath });
      }

      const input = r.inputTokens ?? r.promptTokens ?? r.tokens?.prompt ?? 0;
      const output = r.outputTokens ?? r.candidateTokens ?? r.tokens?.candidates ?? 0;
      const cacheRead = r.cacheReadTokens ?? r.tokens?.cached ?? 0;
      const model = r.model ?? 'gemini-2.5-flash';

      events.push({
        id: `gemini:${sid}:${events.length + 1}`,
        agent: 'gemini',
        sessionId: sid,
        ts: Number.isNaN(ts) ? Date.now() : ts,
        kind: 'assistant',
        model,
        input,
        output,
        cacheRead,
        reasoning: r.thinkingTokens ?? 0,
      });

      if (Array.isArray(r.tools)) {
        for (const t of r.tools) {
          events.push({
            id: `gemini:${sid}:tool:${events.length + 1}`,
            agent: 'gemini',
            sessionId: sid,
            ts: Number.isNaN(ts) ? Date.now() : ts,
            kind: 'tool_call',
            tool: typeof t === 'string' ? t : t.name,
            argsHash: hash(JSON.stringify(t.args || {})),
          });
        }
      }
    });

    return {
      events,
      sessions: Array.from(sessions.values()),
      quotas: [],
      cursor: { offset, state: {} },
      errors,
      skipped: dropped,
    };
  },
};
