import { existsSync, globSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readLines } from '../jsonl.ts';
import { hash } from '../util.ts';
import type { Adapter, NormalizedEvent, QuotaSnapshot } from '../types.ts';

const WINDOWS: Record<number, '5h' | '7d'> = { 300: '5h', 10080: '7d' };

// ~40% of codex bytes are record types the adapter discards (item_completed, reasoning, world_state, ...);
// parsing only what is used keeps a full-history backfill inside the 200M service memory cap.
// A head with no type marker at all is parsed anyway, so a reordered schema degrades to full parsing, never to lost data.
const WANTED = /"(?:session_meta|turn_context|token_count|user_message|function_call|custom_tool_call|function_call_output|custom_tool_call_output)"/;
const HEAD = 300; // covers timestamp + ordinal + type + payload type with 2x margin

export const codex: Adapter = {
  agent: 'codex',
  // The env override only applies to the real home; a custom source home (AGENTLENS_SOURCE_HOME, tests) is honored as given.
  root: (home) => join(home === homedir() && process.env.CODEX_HOME ? process.env.CODEX_HOME : join(home, '.codex'), 'sessions'),
  discover: (root) => existsSync(root) ? globSync('**/rollout-*.jsonl', { cwd: root }).map((p) => join(root, p)) : [],

  read(path, cursor) {
    // The id is in the file name, so a read that starts mid-file still knows its session.
    // ponytail: forked rollouts that copy history could double count; the M2 ccusage cross-check will flag drift.
    const sessionId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path)?.[1] ?? basename(path);
    const state = { ...cursor.state }; // { model, cwd } carried across incremental reads
    const events: NormalizedEvent[] = [];
    const quotas: QuotaSnapshot[] = [];
    let errors = 0;

    const { offset, dropped } = readLines(path, cursor.offset, (line) => {
      const head = line.slice(0, HEAD);
      if (head.includes('"type":"') && !WANTED.test(head)) return;
      let r: any;
      try { r = JSON.parse(line); } catch { errors++; return; }
      if (!r || typeof r !== 'object') { errors++; return; }
      const p = r.payload ?? {};
      const ts = Date.parse(r.timestamp);
      if (Number.isNaN(ts)) return;
      const base = { agent: 'codex' as const, sessionId, ts };

      if (r.type === 'session_meta' || r.type === 'turn_context') {
        if (p.cwd) state.cwd ??= p.cwd;
        if (p.model) state.model = p.model;
      } else if (r.type === 'event_msg' && p.type === 'token_count') {
        const u = p.info?.last_token_usage;
        const total = p.info?.total_token_usage?.total_tokens;
        if (u && total != null) {
          const cached = u.cached_input_tokens ?? 0;
          events.push({
            ...base, id: `codex:${sessionId}:${total}`, kind: 'assistant', model: state.model,
            input: Math.max(0, (u.input_tokens ?? 0) - cached), output: u.output_tokens ?? 0, cacheRead: cached,
            cacheWrite: u.cache_write_input_tokens ?? 0, reasoning: u.reasoning_output_tokens ?? 0,
          });
        }
        for (const w of [p.rate_limits?.primary, p.rate_limits?.secondary]) {
          const window = WINDOWS[w?.window_minutes];
          if (window && typeof w.used_percent === 'number') {
            quotas.push({ agent: 'codex', ts, window, usedPct: w.used_percent, resetsAt: (w.resets_at ?? 0) * 1000, source: 'codex-log' });
          }
        }
      } else if (r.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
        events.push({ ...base, id: `codex:${sessionId}:user:${ts}`, kind: 'user', textHash: hash(p.message), textLen: p.message.length });
      } else if (r.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
        events.push({ ...base, id: `codex:${p.call_id}`, kind: 'tool_call', tool: p.name, argsHash: hash(String(p.arguments ?? p.input ?? '')) });
      } else if (r.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
        const body = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
        events.push({ ...base, id: `codex:${p.call_id}:result`, kind: 'tool_result', resultBytes: Buffer.byteLength(body) });
      }
    });

    return { events, sessions: [{ id: sessionId, agent: 'codex', cwd: state.cwd }], quotas, cursor: { offset, state }, errors, skipped: dropped };
  },
};
