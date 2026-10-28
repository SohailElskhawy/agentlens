import type { DB } from '../db.ts';
import type { AnalystAgent } from './runner.ts';

export async function cached(db: DB, kind: string, inputHash: string, fn: () => Promise<{ ok: boolean; text: string }>,
  opts: { agent: AnalystAgent; model?: string | null } = { agent: 'claude' }): Promise<{ ok: boolean; text: string }> {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(kind) || !/^[a-f0-9]{64}$/.test(inputHash)) throw new Error('Invalid AI cache metadata');
  const model = opts.model ?? '';
  const row = db.prepare('SELECT text FROM ai_notes WHERE kind = ? AND input_hash = ? AND agent = ? AND model = ?')
    .get(kind, inputHash, opts.agent, model) as { text: string } | undefined;
  if (row) return { ok: true, text: row.text };
  const result = await fn();
  if (result.ok) db.prepare('INSERT OR REPLACE INTO ai_notes (kind, input_hash, agent, model, created_at, text) VALUES (?, ?, ?, ?, ?, ?)')
    .run(kind, inputHash, opts.agent, model, Date.now(), result.text);
  return result;
}
