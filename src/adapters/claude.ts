import { existsSync, globSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readLines } from '../jsonl.ts';
import { hash } from '../util.ts';
import type { Adapter, NormalizedEvent, SessionInfo } from '../types.ts';

// A third of claude bytes are record types the adapter discards (api-request bodies, attachments, prompt
// snapshots); skipping them before JSON.parse trims the backfill's peak heap. A line is skipped only when
// its head shows a known-discardable type and no user/assistant marker, so reordered logs (type after the
// message object) and unknown record types fall back to full parsing, never to lost data.
const DISCARD = /"type":"(?:api-request|api-request-blob|attachment|prompt_snapshot|skill_listing|hook_success|deferred_tools_delta)"/;
const WANTED = /"type":"(?:user|assistant)"/;

export const claude: Adapter = {
  agent: 'claude',
  // The env override only applies to the real home; a custom source home (AGENTLENS_SOURCE_HOME, tests) is honored as given.
  root: (home) => join(home === homedir() && process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR : join(home, '.claude'), 'projects'),
  discover: (root) => {
    const roots = [root];
    if (process.platform === 'darwin') {
      const macRoot = join(homedir(), 'Library/Application Support/Claude/projects');
      if (existsSync(macRoot) && !roots.includes(macRoot)) roots.push(macRoot);
    }
    const paths: string[] = [];
    for (const r of roots) {
      if (!existsSync(r)) continue;
      paths.push(...[...globSync('*/*.jsonl', { cwd: r }), ...globSync('*/*/subagents/*.jsonl', { cwd: r })].map((p) => join(r, p)));
    }
    return paths;
  },

  read(path, cursor) {
    const events: NormalizedEvent[] = [];
    const sessions = new Map<string, SessionInfo>();
    let errors = 0;

    const { offset, dropped } = readLines(path, cursor.offset, (line) => {
      const head = line.slice(0, 400); // bounds the scan; correctness never depends on this window
      if (DISCARD.test(head) && !WANTED.test(head)) return;
      let r: any;
      try { r = JSON.parse(line); } catch { errors++; return; }
      if (!r || typeof r !== 'object') { errors++; return; }
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
          if (b?.type === 'tool_use') events.push({ ...base, id: `claude:${b.id}`, kind: 'tool_call', tool: b.name, argsHash: hash(JSON.stringify(b.input ?? {})) });
        }
        return;
      }

      if (!r.uuid) return;
      if (typeof content === 'string') {
        events.push({ ...base, id: `claude:${r.uuid}`, kind: 'user', textHash: hash(content), textLen: content.length });
        return;
      }
      if (!Array.isArray(content)) return;
      const text = content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
      if (text) events.push({ ...base, id: `claude:${r.uuid}`, kind: 'user', textHash: hash(text), textLen: text.length });
      for (const b of content) {
        if (b?.type !== 'tool_result') continue;
        const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
        events.push({ ...base, id: `claude:${b.tool_use_id}:result`, kind: 'tool_result', resultBytes: Buffer.byteLength(body), isError: !!b.is_error });
      }
    });

    return { events, sessions: [...sessions.values()], quotas: [], cursor: { offset, state: {} }, errors, skipped: dropped };
  },
};
