import type { DB } from '../db.ts';
import { getAllSettings } from '../db.ts';
import type { AnalystAgent } from './runner.ts';

export type AiAgent = 'auto' | AnalystAgent;
export type AiErrorCode = 'AI_DISABLED' | 'AI_DAILY_LIMIT' | 'AI_INVALID_SETTINGS';

export interface AiStatus {
  enabled: boolean;
  agent: AiAgent | null;
  model: string | null;
  maxCallsPerDay: number | null;
  callsToday: number;
  allowed: boolean;
  error: AiErrorCode | null;
}

export function validAiSetting(key: string, value: string): boolean {
  if (key === 'ai_enabled') return value === 'true' || value === 'false';
  if (key === 'ai_agent') return ['auto', 'claude', 'codex', 'gemini', 'opencode'].includes(value);
  if (key === 'ai_model') return value === '' || (value.length <= 200 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value));
  if (key === 'ai_max_calls_per_day') return /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));
  return false;
}

export function aiStatus(db: DB, now = Date.now()): AiStatus {
  const settings = getAllSettings(db);
  const enabled = settings.ai_enabled ?? 'false';
  const agent = settings.ai_agent ?? 'auto';
  const model = settings.ai_model ?? '';
  const limit = settings.ai_max_calls_per_day ?? '20';
  const valid = validAiSetting('ai_enabled', enabled) && validAiSetting('ai_agent', agent)
    && validAiSetting('ai_model', model) && validAiSetting('ai_max_calls_per_day', limit);
  const date = new Date(now);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  const callsToday = (db.prepare('SELECT count(*) AS count FROM ai_calls WHERE created_at >= ? AND created_at < ?')
    .get(start, end) as { count: number }).count;
  const error: AiErrorCode | null = !valid ? 'AI_INVALID_SETTINGS' : enabled !== 'true' ? 'AI_DISABLED'
    : callsToday >= Number(limit) ? 'AI_DAILY_LIMIT' : null;
  return {
    enabled: enabled === 'true', agent: validAiSetting('ai_agent', agent) ? agent as AiAgent : null,
    model: validAiSetting('ai_model', model) ? model || null : null,
    maxCallsPerDay: validAiSetting('ai_max_calls_per_day', limit) ? Number(limit) : null,
    callsToday, allowed: error === null, error,
  };
}

export function assertAiAllowed(db: DB, now = Date.now()): void {
  const status = aiStatus(db, now);
  if (status.error) throw Object.assign(new Error(status.error), { code: status.error });
}

export function reserveAiCall(db: DB, call: { kind: string; agent: AnalystAgent; inputHash: string }, now = Date.now()): number {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(call.kind) || !['claude', 'codex', 'gemini', 'opencode'].includes(call.agent)
    || !/^[a-f0-9]{64}$/.test(call.inputHash)) throw new Error('Invalid AI call metadata');
  db.exec('BEGIN IMMEDIATE');
  try {
    assertAiAllowed(db, now);
    const result = db.prepare('INSERT INTO ai_calls (kind, agent, created_at, input_hash) VALUES (?, ?, ?, ?)')
      .run(call.kind, call.agent, now, call.inputHash);
    db.exec('COMMIT');
    return Number(result.lastInsertRowid);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function finalizeAiCall(db: DB, id: number, ok: boolean, durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) throw new Error('Invalid AI call duration');
  const result = db.prepare('UPDATE ai_calls SET ok = ?, duration_ms = ? WHERE id = ? AND ok IS NULL')
    .run(ok ? 1 : 0, durationMs, id);
  if (result.changes !== 1) throw new Error('AI call is missing or already finalized');
}
