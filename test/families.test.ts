import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, upsertEvents, upsertProject, upsertSessions } from '../src/db.ts';
import type { DB } from '../src/db.ts';
import type { Agent } from '../src/types.ts';
import { sessionFamilies } from '../src/queries.ts';
import { startServer } from '../src/server.ts';

// Seed events at two timestamps so the days/date-window filter can be asserted.
const OLD_TS = 1000;
const NEW_TS = 9_000_000;

interface SeedSession { id: string; parentId?: string; agent?: Agent; project?: number | null }
interface SeedEvent { sessionId: string; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number; model?: string; ts?: number }

function seedFamily(db: DB, sessions: SeedSession[], events: SeedEvent[]) {
  upsertSessions(db, sessions.map((s) => ({ id: s.id, agent: s.agent ?? 'claude', projectId: null, parentId: s.parentId })));
  upsertEvents(db, events.map((e, i) => ({
    id: `${e.sessionId}-e${i}`, sessionId: e.sessionId, agent: 'claude' as const, ts: e.ts ?? NEW_TS,
    kind: 'assistant' as const, model: e.model ?? 'm-x', // 'm-x' is not in prices.json → unpriced
    input: e.input ?? 0, output: e.output ?? 0,
    cacheRead: e.cacheRead ?? 0, cacheWrite: e.cacheWrite ?? 0, cacheWrite1h: e.cacheWrite1h ?? 0,
  })));
}

test('groups parent/child/grandchild into one family; root counted once; descendants included', () => {
  const db = openDb(':memory:');
  seedFamily(db, [{ id: 's_p' }, { id: 's_c', parentId: 's_p' }, { id: 's_g', parentId: 's_c' }, { id: 's_i' }], [
    { sessionId: 's_p', input: 100 },
    { sessionId: 's_c', input: 200 },
    { sessionId: 's_g', input: 300 },
    { sessionId: 's_i', input: 50 },
  ]);
  const families = sessionFamilies(db);
  assert.deepEqual(families, [
    { root: 's_p', sessions: 3, childSessions: 2, totalSessions: 3, tokens: 600, cost: 0, pricedSessions: 0 },
    { root: 's_i', sessions: 1, childSessions: 0, totalSessions: 1, tokens: 50, cost: 0, pricedSessions: 0 },
  ]);
});

test('a parent_id referencing a missing session row makes the session its own root (no crash)', () => {
  const db = openDb(':memory:');
  seedFamily(db, [{ id: 's_orphan', parentId: 'ghost' }], [{ sessionId: 's_orphan', input: 42 }]);
  const families = sessionFamilies(db);
  assert.equal(families.length, 1);
  assert.equal(families[0].root, 's_orphan');
  assert.equal(families[0].sessions, 1);
  assert.equal(families[0].tokens, 42);
});

test('injected cycle (A<->B) terminates, each session counted once, no hang', () => {
  const db = openDb(':memory:');
  seedFamily(db, [{ id: 'A', parentId: 'B' }, { id: 'B', parentId: 'A' }], [
    { sessionId: 'A', input: 10 },
    { sessionId: 'B', input: 20 },
  ]);
  const families = sessionFamilies(db); // must not throw or loop forever
  assert.equal(families.reduce((t, f) => t + f.totalSessions, 0), 2); // counted at most once each
  assert.equal(families.reduce((t, f) => t + f.tokens, 0), 30); // each event counted exactly once
  for (const f of families) assert.ok(Number.isFinite(f.tokens) && Number.isFinite(f.cost));
});

test('project filter excludes other projects; date window excludes outside-window events', () => {
  const db = openDb(':memory:');
  const p1 = upsertProject(db, '/work/p1', 'proj1');
  const p2 = upsertProject(db, '/work/p2', 'proj2');
  upsertSessions(db, [
    { id: 's1', agent: 'claude', projectId: p1 },
    { id: 's2', agent: 'claude', projectId: p2 },
  ]);
  upsertEvents(db, [
    { id: 'e1', sessionId: 's1', agent: 'claude', ts: NEW_TS, kind: 'assistant', model: 'm-x', input: 11 },
    { id: 'e2', sessionId: 's2', agent: 'claude', ts: NEW_TS, kind: 'assistant', model: 'm-x', input: 22 },
    { id: 'e3', sessionId: 's1', agent: 'claude', ts: OLD_TS, kind: 'assistant', model: 'm-x', input: 33 },
  ]);
  // Project filter keeps all of that project's events (e1 + e3), excludes proj2's.
  assert.deepEqual(sessionFamilies(db, { projectId: p1 }).map((f) => ({ root: f.root, tokens: f.tokens })), [{ root: 's1', tokens: 44 }]);
  // Date window: e3 (ts 1000) is outside [OLD_TS + 1, ∞) and drops out; e3 is inside from OLD_TS.
  assert.deepEqual(sessionFamilies(db, { from: OLD_TS + 1 }).map((f) => ({ root: f.root, tokens: f.tokens })), [{ root: 's2', tokens: 22 }, { root: 's1', tokens: 11 }]);
  assert.deepEqual(sessionFamilies(db, { from: OLD_TS }).map((f) => ({ root: f.root, tokens: f.tokens })), [{ root: 's1', tokens: 44 }, { root: 's2', tokens: 22 }]);
});

test('empty db yields an empty list with no NaN', () => {
  const db = openDb(':memory:');
  assert.deepEqual(sessionFamilies(db), []);
});

test('unpriced model: tokens counted, cost 0, pricedSessions excludes; priced model uses costOf prices', () => {
  const db = openDb(':memory:');
  const p = upsertProject(db, '/work/p3', 'proj3');
  upsertSessions(db, [
    { id: 'sU', agent: 'claude', projectId: p },
    { id: 'sP', agent: 'claude', projectId: p },
  ]);
  upsertEvents(db, [
    { id: 'eu', sessionId: 'sU', agent: 'claude', ts: NEW_TS, kind: 'assistant', model: 'no-such-model', input: 123 },
    // priced: gemini-3.8-flash-high, input 3e-7, output 2.5e-6 per token (prices.json)
    { id: 'ep', sessionId: 'sP', agent: 'claude', ts: NEW_TS, kind: 'assistant', model: 'gemini-3.8-flash-high', input: 1000, output: 100 },
  ]);
  const families = sessionFamilies(db);
  const u = families.find((f) => f.root === 'sU')!;
  const pr = families.find((f) => f.root === 'sP')!;
  assert.equal(u.tokens, 123);
  assert.equal(u.cost, 0);
  assert.equal(u.pricedSessions, 0);
  assert.equal(pr.tokens, 1100); // input + output
  assert.ok(Math.abs(pr.cost - 0.00055) < 1e-9);
  assert.equal(pr.pricedSessions, 1);
});

test('GET /api/analytics/families serves the families list', async () => {
  const db = openDb(':memory:');
  seedFamily(db, [{ id: 's_p' }, { id: 's_c', parentId: 's_p' }], [
    { sessionId: 's_p', input: 100 },
    { sessionId: 's_c', input: 200 },
  ]);
  const server = await startServer(db, 0);
  after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const get = (path: string) => new Promise<any>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    }).on('error', reject).end();
  });
  const all = await get('/api/analytics/families');
  assert.equal(all.status, 200);
  assert.ok(Array.isArray(all.body.families));
  assert.equal(all.body.families[0].root, 's_p');
  assert.equal(all.body.families[0].tokens, 300);
});
