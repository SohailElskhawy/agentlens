import { existsSync, globSync } from 'node:fs';
import { join } from 'node:path';
import { readLines } from '../jsonl.ts';
import { hash } from '../util.ts';
import type { Adapter, NormalizedEvent, SessionInfo } from '../types.ts';

export const claude: Adapter = {
  agent: 'claude',
  root: (home) => join(process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'projects'),
  discover: (root) => existsSync(root)
    ? [...globSync('*/*.jsonl', { cwd: root }), ...globSync('*/*/subagents/*.jsonl', { cwd: root })].map((p) => join(root, p))
    : [],

  read(path, cursor) {
    const events: NormalizedEvent[] = [];
    const sessions = new Map<string, SessionInfo>();
    let errors = 0;

    const offset = readLines(path, cursor.offset, (line) => {
      let r: any;
      try { r = JSON.parse(line); } catch { errors++; return; }
      if (r.type !== 'user' && r.type !== 'assistant') return;
      // Subagent records keep the parent's id in sessionId and their own in agentId.
      const sub = r.isSidechain && r.agentId;
      const sessionId: string | undefined = sub ? r.agentId : r.sessionId;
      const ts = Date.parse(r.timestamp);
      if (!sessionId || Number.isNaN(ts)) return;
      if (!sessions.has(sessionId)) sessions.set(sessionId, { id: sessionId, agent: 'claude', cwd: r.cwd, parentId: sub ? r.sessionId : undefined });

      const base = { agent: 'claude' as const, sessionId, ts };
      const content = r.message?.content;

      if (r.type === 'assistant') {
        const u = r.message?.usage;
        if (u && r.message.id) {
          events.push({
            ...base, id: `claude:${r.message.id}:${r.requestId ?? ''}`, kind: 'assistant', model: r.message.model,
            input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0, cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
            reasoning: u.output_tokens_details?.thinking_tokens ?? 0,
          });
        }
        for (const b of Array.isArray(content) ? content : []) {
          if (b.type === 'tool_use') events.push({ ...base, id: `claude:${b.id}`, kind: 'tool_call', tool: b.name, argsHash: hash(JSON.stringify(b.input ?? {})) });
        }
        return;
      }

      if (!r.uuid) return;
      if (typeof content === 'string') {
        events.push({ ...base, id: `claude:${r.uuid}`, kind: 'user', textHash: hash(content), textLen: content.length });
        return;
      }
      if (!Array.isArray(content)) return;
      const text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      if (text) events.push({ ...base, id: `claude:${r.uuid}`, kind: 'user', textHash: hash(text), textLen: text.length });
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
        events.push({ ...base, id: `claude:${b.tool_use_id}:result`, kind: 'tool_result', resultBytes: Buffer.byteLength(body), isError: !!b.is_error });
      }
    });

    return { events, sessions: [...sessions.values()], quotas: [], cursor: { offset, state: {} }, errors };
  },
};
