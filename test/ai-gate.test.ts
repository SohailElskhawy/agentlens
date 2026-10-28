import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, setSetting } from '../src/db.ts';
import { aiStatus, assertAiAllowed, reserveAiCall, finalizeAiCall } from '../src/ai/gate.ts';
import { tmp } from './helpers.ts';

test('AI is off by default even when legacy agent launch is enabled', () => {
  const db = openDb(':memory:');
  setSetting(db, 'allow_agent_launch', 'true');
  assert.equal(aiStatus(db).enabled, false);
  assert.equal(aiStatus(db).agent, 'auto');
  assert.equal(aiStatus(db).model, null);
  assert.equal(aiStatus(db).maxCallsPerDay, 20);
  assert.throws(() => assertAiAllowed(db), { code: 'AI_DISABLED' });
  db.close();
});

test('separate database connections share reservations and successful finalization', () => {
  const path = join(tmp(), 'calls.db');
  const first = openDb(path);
  const second = openDb(path);
  try {
    setSetting(first, 'ai_enabled', 'true');
    setSetting(first, 'ai_max_calls_per_day', '1');
    const call = { kind: 'diagnose', agent: 'claude' as const, inputHash: 'c'.repeat(64) };
    const id = reserveAiCall(first, call);
    assert.throws(() => reserveAiCall(second, call), { code: 'AI_DAILY_LIMIT' });
    finalizeAiCall(second, id, true, 10);
    assert.deepEqual({ ...first.prepare('SELECT ok, duration_ms FROM ai_calls WHERE id = ?').get(id) }, { ok: 1, duration_ms: 10 });
    assert.throws(() => finalizeAiCall(first, id, false, 20));
  } finally {
    first.close();
    second.close();
  }
});

test('reservations reject raw content in place of metadata', () => {
  const db = openDb(':memory:');
  setSetting(db, 'ai_enabled', 'true');
  assert.throws(() => reserveAiCall(db, { kind: 'diagnose', agent: 'claude', inputHash: 'a prompt' }));
  assert.throws(() => reserveAiCall(db, { kind: 'a prompt', agent: 'claude', inputHash: 'a'.repeat(64) }));
  assert.equal(aiStatus(db).callsToday, 0);
  db.close();
});

test('legacy databases acquire AI metadata without enabling AI', () => {
  const path = join(tmp(), 'legacy.db');
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO settings VALUES ('allow_agent_launch', 'true');");
  legacy.close();
  const db = openDb(path);
  assert.equal(aiStatus(db).enabled, false);
  assert.throws(() => assertAiAllowed(db), { code: 'AI_DISABLED' });
  db.close();
});

test('reservations count immediately, including failures, and cap simultaneous admissions', () => {
  const db = openDb(':memory:');
  setSetting(db, 'ai_enabled', 'true');
  setSetting(db, 'ai_max_calls_per_day', '1');
  const now = new Date(2026, 9, 28, 12).getTime();
  const id = reserveAiCall(db, { kind: 'diagnose', agent: 'claude', inputHash: 'a'.repeat(64) }, now);
  assert.equal(aiStatus(db, now).callsToday, 1);
  assert.throws(() => reserveAiCall(db, { kind: 'diagnose', agent: 'claude', inputHash: 'b'.repeat(64) }, now), { code: 'AI_DAILY_LIMIT' });
  finalizeAiCall(db, id, false, 42);
  assert.throws(() => assertAiAllowed(db, now), { code: 'AI_DAILY_LIMIT' });
  assert.deepEqual({ ...db.prepare('SELECT kind, agent, input_hash, ok, duration_ms FROM ai_calls').get() },
    { kind: 'diagnose', agent: 'claude', input_hash: 'a'.repeat(64), ok: 0, duration_ms: 42 });
  db.close();
});

test('cap follows local calendar days across a DST transition', () => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  const db = openDb(':memory:');
  try {
    setSetting(db, 'ai_enabled', 'true');
    setSetting(db, 'ai_max_calls_per_day', '2');
    reserveAiCall(db, { kind: 'diagnose', agent: 'claude', inputHash: 'a'.repeat(64) }, Date.parse('2026-03-08T04:59:59Z'));
    reserveAiCall(db, { kind: 'diagnose', agent: 'claude', inputHash: 'b'.repeat(64) }, Date.parse('2026-03-08T05:00:00Z'));
    assert.equal(aiStatus(db, Date.parse('2026-03-09T03:59:59Z')).callsToday, 1);
    assert.equal(aiStatus(db, Date.parse('2026-03-09T04:00:00Z')).callsToday, 0);
  } finally {
    db.close();
    if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz;
  }
});

test('invalid stored options fail closed and zero prevents spending', () => {
  const db = openDb(':memory:');
  setSetting(db, 'ai_enabled', 'true');
  for (const [key, value] of [['ai_max_calls_per_day', '-1'], ['ai_max_calls_per_day', '1.5'],
    ['ai_max_calls_per_day', ''], ['ai_max_calls_per_day', '9007199254740992'], ['ai_agent', 'other'],
    ['ai_enabled', 'TRUE'], ['ai_model', 'bad\nmodel']]) {
    setSetting(db, key, value);
    assert.throws(() => assertAiAllowed(db), { code: 'AI_INVALID_SETTINGS' }, `${key}=${value}`);
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    setSetting(db, 'ai_enabled', 'true');
  }
  setSetting(db, 'ai_max_calls_per_day', '0');
  assert.throws(() => assertAiAllowed(db), { code: 'AI_DAILY_LIMIT' });
  db.close();
});

test('failed or contended reservations leave no row and no open transaction', () => {
  const path = join(tmp(), 'busy.db');
  const first = openDb(path);
  const second = openDb(path);
  const call = { kind: 'diagnose', agent: 'claude' as const, inputHash: 'd'.repeat(64) };
  try {
    assert.throws(() => reserveAiCall(first, call), { code: 'AI_DISABLED' });
    assert.equal(first.isTransaction, false);
    setSetting(first, 'ai_enabled', 'true');
    first.exec('BEGIN IMMEDIATE');
    assert.throws(() => reserveAiCall(second, call), /locked/);
    assert.equal(second.isTransaction, false);
    first.exec('ROLLBACK');
    assert.equal(aiStatus(second).callsToday, 0);
    assert.ok(reserveAiCall(second, call) > 0);
  } finally {
    first.close();
    second.close();
  }
});
