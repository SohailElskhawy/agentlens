import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, upsertEvents, upsertProject, upsertSessions } from '../src/db.ts';
import type { DB } from '../src/db.ts';
import { modelEfficiency } from '../src/queries.ts';
import { startServer } from '../src/server.ts';

// seed: s1 runs model-a over 2 turns with an erroring and a clean tool call; s2 runs model-b
// over 1 turn with a clean tool call; every turn caches 0 or 150 read tokens.
function seed(db: DB) {
  const p = upsertProject(db, '/work/a', 'alpha');
  upsertSessions(db, [{ id: 's1', agent: 'claude', projectId: p, cwd: '/work/a' }, { id: 's2', agent: 'codex', projectId: p, cwd: '/work/a' }]);
  upsertEvents(db, [
    { id: 'a1', sessionId: 's1', agent: 'claude', ts: 1000, kind: 'assistant', model: 'model-a', input: 100, output: 50, cacheRead: 50 },
    { id: 'a2', sessionId: 's1', agent: 'claude', ts: 2000, kind: 'assistant', model: 'model-a', input: 100, output: 50, cacheRead: 50 },
    { id: 'c1', sessionId: 's1', agent: 'claude', ts: 1500, kind: 'tool_call', tool: 'Bash', argsHash: 'h1' },
    { id: 'c1:result', sessionId: 's1', agent: 'claude', ts: 1600, kind: 'tool_result', isError: true },
    { id: 'c2', sessionId: 's1', agent: 'claude', ts: 2500, kind: 'tool_call', tool: 'Bash', argsHash: 'h2' },
    { id: 'c2:result', sessionId: 's1', agent: 'claude', ts: 2600, kind: 'tool_result', isError: false },
    { id: 'a3', sessionId: 's2', agent: 'codex', ts: 1000, kind: 'assistant', model: 'model-b', input: 200, output: 100 },
    { id: 'c3', sessionId: 's2', agent: 'codex', ts: 1500, kind: 'tool_call', tool: 'Read', argsHash: 'h3' },
    { id: 'c3:result', sessionId: 's2', agent: 'codex', ts: 1600, kind: 'tool_result', isError: false },
  ]);
  return p;
}

test('compares models: sessions, tokens, turns, tool error rate, cache-read ratio', () => {
  const db = openDb(':memory:');
  seed(db);
  assert.deepEqual(modelEfficiency(db), [
    { name: 'model-a', sessions: 1, tokens: 400, tokensPerSession: 400, avgTurns: 2, toolErrorRate: 0.5, cacheReadRatio: 0.25 },
    { name: 'model-b', sessions: 1, tokens: 300, tokensPerSession: 300, avgTurns: 1, toolErrorRate: 0, cacheReadRatio: 0 },
  ]);
});

test('orders by tokens desc and averages across multiple sessions', () => {
  const db = openDb(':memory:');
  const p = seed(db);
  upsertSessions(db, [{ id: 's3', agent: 'claude', projectId: p, cwd: '/work/a' }]);
  upsertEvents(db, [
    { id: 'a4', sessionId: 's3', agent: 'claude', ts: 1000, kind: 'assistant', model: 'model-b', input: 400, output: 100 },
    { id: 'a5', sessionId: 's3', agent: 'claude', ts: 2000, kind: 'assistant', model: 'model-b', input: 400, output: 100 },
    { id: 'a6', sessionId: 's3', agent: 'claude', ts: 3000, kind: 'assistant', model: 'model-b', input: 400, output: 100 },
    { id: 'a7', sessionId: 's3', agent: 'claude', ts: 4000, kind: 'assistant', model: 'model-a', input: 10, output: 10 },
  ]);
  const r = modelEfficiency(db);
  assert.deepEqual(r.map((m) => m.name), ['model-b', 'model-a']);
  assert.deepEqual(r[0], { name: 'model-b', sessions: 2, tokens: 1800, tokensPerSession: 900, avgTurns: 2, toolErrorRate: 0, cacheReadRatio: 0 });
  assert.deepEqual(r[1], { name: 'model-a', sessions: 2, tokens: 420, tokensPerSession: 210, avgTurns: 1.5, toolErrorRate: 0.5, cacheReadRatio: 0.238 });
});

test('attributes a session tool stats to its primary model', () => {
  const db = openDb(':memory:');
  upsertEvents(db, [
    { id: 'a1', sessionId: 's9', agent: 'claude', ts: 1000, kind: 'assistant', model: 'model-a', input: 100 },
    { id: 'a2', sessionId: 's9', agent: 'claude', ts: 2000, kind: 'assistant', model: 'model-b', input: 50 },
    { id: 'c1', sessionId: 's9', agent: 'claude', ts: 3000, kind: 'tool_call', tool: 'Bash', argsHash: 'h9' },
    { id: 'c1:result', sessionId: 's9', agent: 'claude', ts: 3100, kind: 'tool_result', isError: true },
  ]);
  const r = modelEfficiency(db);
  assert.deepEqual(r.map((m) => [m.name, m.sessions, m.toolErrorRate]), [['model-a', 1, 1], ['model-b', 1, 0]]);
});

test('breaks dominant-model ties alphabetically by model name', () => {
  const db = openDb(':memory:');
  upsertEvents(db, [
    { id: 'a1', sessionId: 's1', agent: 'claude', ts: 1000, kind: 'assistant', model: 'model-z', input: 50 },
    { id: 'a2', sessionId: 's1', agent: 'claude', ts: 2000, kind: 'assistant', model: 'model-a', input: 50 },
    { id: 'c1', sessionId: 's1', agent: 'claude', ts: 3000, kind: 'tool_call', tool: 'Bash', argsHash: 'h1' },
    { id: 'c1:result', sessionId: 's1', agent: 'claude', ts: 3100, kind: 'tool_result', isError: true },
  ]);
  const r = modelEfficiency(db);
  assert.deepEqual(r.map((m) => [m.name, m.toolErrorRate]), [['model-a', 1], ['model-z', 0]]);
});

test('filters narrow by agent', () => {
  const db = openDb(':memory:');
  seed(db);
  assert.deepEqual(modelEfficiency(db, { agent: 'codex' }).map((m) => m.name), ['model-b']);
});

test('empty db yields empty list', () => {
  const db = openDb(':memory:');
  assert.deepEqual(modelEfficiency(db), []);
});

test('GET /api/analytics/model-efficiency serves the comparison', async () => {
  const db = openDb(':memory:');
  seed(db);
  const server = await startServer(db, 0);
  after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const body = await new Promise<any>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/api/analytics/model-efficiency' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    }).on('error', reject).end();
  });
  assert.equal(body.status, 200);
  assert.equal(body.body[0].name, 'model-a');
  assert.equal(body.body[1].toolErrorRate, 0);
});
