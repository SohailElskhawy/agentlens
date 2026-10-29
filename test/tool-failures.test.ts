import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, upsertEvents, upsertProject, upsertSessions } from '../src/db.ts';
import type { DB } from '../src/db.ts';
import { toolFailures } from '../src/queries.ts';
import { startServer } from '../src/server.ts';

// seed: one Bash call that fails, an assistant turn, then an identical retry that succeeds; an
// erroring one-off call (no retry); a Read call repeated without errors; all across 2 projects.
function seed(db: DB) {
  const a = upsertProject(db, '/work/a', 'alpha');
  const b = upsertProject(db, '/work/b', 'beta');
  upsertSessions(db, [{ id: 's1', agent: 'claude', projectId: a, cwd: '/work/a' }, { id: 's2', agent: 'codex', projectId: b, cwd: '/work/b' }]);
  upsertEvents(db, [
    { id: 'a1', sessionId: 's1', agent: 'claude', ts: 1000, kind: 'assistant', input: 100, output: 50, cacheRead: 25 },
    { id: 'c1', sessionId: 's1', agent: 'claude', ts: 2000, kind: 'tool_call', tool: 'Bash', argsHash: 'h1' },
    { id: 'c1:result', sessionId: 's1', agent: 'claude', ts: 2100, kind: 'tool_result', isError: true },
    { id: 'a2', sessionId: 's1', agent: 'claude', ts: 3000, kind: 'assistant', output: 200 },
    { id: 'c2', sessionId: 's1', agent: 'claude', ts: 4000, kind: 'tool_call', tool: 'Bash', argsHash: 'h1' },
    { id: 'c2:result', sessionId: 's1', agent: 'claude', ts: 4100, kind: 'tool_result', isError: false },
    { id: 'c3', sessionId: 's2', agent: 'codex', ts: 1000, kind: 'tool_call', tool: 'Bash', argsHash: 'h2' },
    { id: 'c3:result', sessionId: 's2', agent: 'codex', ts: 1100, kind: 'tool_result', isError: true },
    { id: 'c4', sessionId: 's1', agent: 'claude', ts: 100, kind: 'tool_call', tool: 'Read', argsHash: 'h3' },
    { id: 'c4:result', sessionId: 's1', agent: 'claude', ts: 150, kind: 'tool_result', isError: false },
    { id: 'c5', sessionId: 's1', agent: 'claude', ts: 200, kind: 'tool_call', tool: 'Read', argsHash: 'h3' },
    { id: 'c5:result', sessionId: 's1', agent: 'claude', ts: 250, kind: 'tool_result', isError: false },
  ]);
  return { a, b };
}

test('aggregates errors, retries and wasted tokens by tool and project', () => {
  const db = openDb(':memory:');
  const { a, b } = seed(db);
  const r = toolFailures(db);
  assert.deepEqual(r.failures, [
    { tool: 'Bash', projectId: a, project: 'alpha', calls: 2, errors: 1, retries: 1, wastedTokens: 200 },
    { tool: 'Bash', projectId: b, project: 'beta', calls: 1, errors: 1, retries: 0, wastedTokens: 0 },
    { tool: 'Read', projectId: a, project: 'alpha', calls: 2, errors: 0, retries: 1, wastedTokens: 0 },
  ]);
  assert.deepEqual(r.totals, { calls: 5, errors: 2, retries: 2, wastedTokens: 200 });
});

test('filters narrow by project and agent', () => {
  const db = openDb(':memory:');
  const { a } = seed(db);
  assert.deepEqual(toolFailures(db, { projectId: a }).failures.map((f) => `${f.tool}:${f.project}`), ['Bash:alpha', 'Read:alpha']);
  assert.deepEqual(toolFailures(db, { agent: 'codex' }).failures.map((f) => f.project), ['beta']);
});

test('empty db yields empty failures and zeroed totals', () => {
  const db = openDb(':memory:');
  assert.deepEqual(toolFailures(db), { failures: [], totals: { calls: 0, errors: 0, retries: 0, wastedTokens: 0 } });
});

test('GET /api/analytics/tool-failures serves the aggregation and honors ?project', async () => {
  const db = openDb(':memory:');
  const { a } = seed(db);
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
  const all = await get('/api/analytics/tool-failures');
  assert.equal(all.status, 200);
  assert.equal(all.body.totals.errors, 2);
  assert.equal(all.body.failures[0].tool, 'Bash');
  const one = await get(`/api/analytics/tool-failures?project=${a}`);
  assert.deepEqual(one.body.failures.map((f: any) => f.project), ['alpha', 'alpha']);
});
