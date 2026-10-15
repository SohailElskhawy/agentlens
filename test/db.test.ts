import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertEvents, upsertSessions, upsertProject, insertQuotas, getCursor, setCursor, tx } from '../src/db.ts';
import type { NormalizedEvent } from '../src/types.ts';

test('upsertEvents merges repeated ids with per-field MAX (streamed Claude usage lines)', () => {
  const db = openDb(':memory:');
  const e: NormalizedEvent = { id: 'claude:m1:r1', agent: 'claude', sessionId: 's1', ts: 1, kind: 'assistant', model: 'm', input: 2, output: 10 };
  upsertEvents(db, [e, { ...e, output: 50 }, { ...e, output: 30 }]);
  assert.deepEqual({ ...db.prepare('SELECT count(*) AS n, max(output) AS o, max(input) AS i FROM events').get() }, { n: 1, o: 50, i: 2 });
});

test('upsertProject is idempotent and returns a stable id', () => {
  const db = openDb(':memory:');
  const a = upsertProject(db, '/r/app', 'app');
  assert.equal(upsertProject(db, '/r/app', 'app'), a);
  assert.notEqual(upsertProject(db, '/r/other', 'other'), a);
});

test('upsertSessions keeps the first cwd and project', () => {
  const db = openDb(':memory:');
  const p = upsertProject(db, '/r/app', 'app');
  upsertSessions(db, [{ id: 's1', agent: 'codex', cwd: '/r/app', projectId: p }]);
  upsertSessions(db, [{ id: 's1', agent: 'codex', cwd: '/elsewhere', projectId: null }]);
  assert.deepEqual({ ...db.prepare('SELECT cwd, project_id AS p FROM sessions').get() }, { cwd: '/r/app', p });
});

test('insertQuotas ignores exact duplicates', () => {
  const db = openDb(':memory:');
  const q = { agent: 'codex' as const, ts: 5, window: '5h' as const, usedPct: 12, resetsAt: 9, source: 'codex-log' };
  insertQuotas(db, [q, q]);
  assert.equal((db.prepare('SELECT count(*) AS n FROM quota_snapshots').get() as { n: number }).n, 1);
});

test('cursors round-trip state and accumulate errors', () => {
  const db = openDb(':memory:');
  assert.equal(getCursor(db, '/f'), undefined);
  setCursor(db, '/f', 'codex', { offset: 10, state: { model: 'gpt' } }, 1);
  setCursor(db, '/f', 'codex', { offset: 20, state: { model: 'gpt2' } }, 2);
  assert.deepEqual(getCursor(db, '/f'), { offset: 20, state: { model: 'gpt2' } });
  assert.equal((db.prepare('SELECT errors FROM cursors').get() as { errors: number }).errors, 3);
});

test('tx rolls back on error', () => {
  const db = openDb(':memory:');
  assert.throws(() => tx(db, () => { upsertProject(db, '/x', 'x'); throw new Error('boom'); }));
  assert.equal((db.prepare('SELECT count(*) AS n FROM projects').get() as { n: number }).n, 0);
});
