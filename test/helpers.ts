import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const tmp = () => mkdtempSync(join(tmpdir(), 'agentlens-'));

export function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

export const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

let n = 0;
export const cAssistant = (o: { msg: string; req?: string; session?: string; cwd?: string; ts?: string; out?: number; model?: string; content?: unknown[] }) => ({
  type: 'assistant', uuid: `ua${n++}`, sessionId: o.session ?? 's1', cwd: o.cwd ?? '/tmp/agentlens-proj',
  timestamp: o.ts ?? '2026-10-15T10:00:00.000Z', requestId: o.req ?? 'r1', isSidechain: false,
  message: {
    id: o.msg, model: o.model ?? 'claude-opus-5-5', role: 'assistant', content: o.content ?? [{ type: 'text', text: 'ok' }],
    usage: {
      input_tokens: 2, output_tokens: o.out ?? 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 50 }, output_tokens_details: { thinking_tokens: 3 },
    },
  },
});

export const cUser = (o: { uuid: string; content: unknown; session?: string; cwd?: string; ts?: string }) => ({
  type: 'user', uuid: o.uuid, sessionId: o.session ?? 's1', cwd: o.cwd ?? '/tmp/agentlens-proj',
  timestamp: o.ts ?? '2026-10-15T10:00:01.000Z', isSidechain: false, message: { role: 'user', content: o.content },
});
