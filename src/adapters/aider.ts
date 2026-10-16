import { existsSync, globSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { readLines } from '../jsonl.ts';
import type { Adapter, Cursor, NormalizedEvent, ReadResult, SessionInfo } from '../types.ts';

export const aider: Adapter = {
  agent: 'aider',
  root: (home) => join(home, '.aider'),
  discover: (root) => {
    const results: string[] = [];
    const home = homedir();

    // Check ~/.aider/
    if (existsSync(root)) {
      try {
        const files = globSync('**/*.{jsonl,md}', { cwd: root }).map((f) => join(root, f));
        results.push(...files);
      } catch {}
    }

    // Check ~/.aider.analytics.jsonl and ~/.aider.chat.history.md
    const homeAnalytics = join(home, '.aider.analytics.jsonl');
    if (existsSync(homeAnalytics)) results.push(homeAnalytics);
    const homeChat = join(home, '.aider.chat.history.md');
    if (existsSync(homeChat)) results.push(homeChat);

    return Array.from(new Set(results));
  },

  read(path: string, cursor: Cursor): ReadResult {
    const ext = extname(path).toLowerCase();
    const events: NormalizedEvent[] = [];
    const sessions = new Map<string, SessionInfo>();
    let errors = 0;

    // Handle JSONL analytics format
    if (ext === '.jsonl') {
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

        const sid = r.session_id || r.sessionId || basename(path, '.jsonl');
        const ts = r.timestamp ? (typeof r.timestamp === 'number' ? r.timestamp : Date.parse(r.timestamp)) : Date.now();
        if (!sessions.has(sid)) {
          sessions.set(sid, { id: sid, agent: 'aider', cwd: r.cwd || r.project_dir || dirname(path) });
        }

        const input = r.tokens_sent ?? r.input_tokens ?? r.prompt_tokens ?? 0;
        const output = r.tokens_received ?? r.output_tokens ?? r.completion_tokens ?? 0;
        const cacheRead = r.cached_tokens ?? r.cache_read_tokens ?? 0;
        const model = r.model ?? 'gpt-4o';

        events.push({
          id: `aider:${sid}:${events.length + 1}`,
          agent: 'aider',
          sessionId: sid,
          ts: Number.isNaN(ts) ? Date.now() : ts,
          kind: 'assistant',
          model,
          input,
          output,
          cacheRead,
        });

        if (Array.isArray(r.tools_used)) {
          for (const t of r.tools_used) {
            events.push({
              id: `aider:${sid}:tool:${events.length + 1}`,
              agent: 'aider',
              sessionId: sid,
              ts: Number.isNaN(ts) ? Date.now() : ts,
              kind: 'tool_call',
              tool: String(t),
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
    }

    // Handle .aider.chat.history.md format
    let offset = cursor.offset;
    try {
      const fullText = readFileSync(path, 'utf8');
      const newContent = fullText.slice(cursor.offset);
      offset = fullText.length;

      const lines = newContent.split('\n');
      let currentSessionId = cursor.state.sessionId || basename(path);
      let currentModel = cursor.state.model || 'gpt-4o';
      let currentTs = Date.now();

      for (const line of lines) {
        // Check for session start
        const sessionMatch = line.match(/^#\s+aider chat started at\s+([0-9\-:\s]+)/i);
        if (sessionMatch) {
          const parsedTs = Date.parse(sessionMatch[1]);
          if (!Number.isNaN(parsedTs)) currentTs = parsedTs;
          currentSessionId = `aider-${currentTs}`;
          if (!sessions.has(currentSessionId)) {
            sessions.set(currentSessionId, { id: currentSessionId, agent: 'aider', cwd: dirname(path) });
          }
        }

        // Check for model switch
        const modelMatch = line.match(/^\/model\s+([a-zA-Z0-9\-\.\/_]+)/i) || line.match(/^Model:\s*([a-zA-Z0-9\-\.\/_]+)/i);
        if (modelMatch) {
          currentModel = modelMatch[1];
        }

        // Check for token count line
        // Example: Tokens: 1,234 sent, 567 received. Cost: $0.012
        const tokMatch = line.match(/Tokens:\s*([0-9,]+)\s*sent,\s*([0-9,]+)\s*received/i);
        if (tokMatch) {
          const input = parseInt(tokMatch[1].replace(/,/g, ''), 10) || 0;
          const output = parseInt(tokMatch[2].replace(/,/g, ''), 10) || 0;

          if (!sessions.has(currentSessionId)) {
            sessions.set(currentSessionId, { id: currentSessionId, agent: 'aider', cwd: dirname(path) });
          }

          events.push({
            id: `aider:${currentSessionId}:${events.length + 1}`,
            agent: 'aider',
            sessionId: currentSessionId,
            ts: currentTs,
            kind: 'assistant',
            model: currentModel,
            input,
            output,
            cacheRead: 0,
          });
          currentTs += 1000; // Increment slightly for sequence ordering
        }
      }

      return {
        events,
        sessions: Array.from(sessions.values()),
        quotas: [],
        cursor: { offset, state: { sessionId: currentSessionId, model: currentModel } },
        errors,
        skipped: 0,
      };
    } catch {
      errors++;
      return {
        events,
        sessions: Array.from(sessions.values()),
        quotas: [],
        cursor: { offset, state: {} },
        errors,
        skipped: 0,
      };
    }
  },
};
