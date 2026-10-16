import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb, upsertSessions, upsertEvents, upsertFindings } from '../src/db.ts';
import { sessionTimeline } from '../src/queries.ts';
import { startServer } from '../src/server.ts';
import type { Finding, NormalizedEvent, SessionInfo } from '../src/types.ts';

test('sessionTimeline maps per-turn tokens and detector finding markers', async () => {
  const db = openDb(':memory:');
  const now = Date.now();
  const sessionId = 's_timeline_test';

  const sessions: (SessionInfo & { projectId: number | null })[] = [
    { id: sessionId, agent: 'claude', projectId: null, cwd: '/work' },
  ];

  const events: NormalizedEvent[] = [
    { id: 'et1', agent: 'claude', sessionId, ts: now, kind: 'assistant', model: 'claude-3-5-sonnet-20241022', input: 10_000, output: 1_000, cacheRead: 5_000, cacheWrite: 0 },
    { id: 'et2', agent: 'claude', sessionId, ts: now + 5000, kind: 'assistant', model: 'claude-3-5-sonnet-20241022', input: 15_000, output: 2_000, cacheRead: 8_000, cacheWrite: 0 },
    { id: 'et3', agent: 'claude', sessionId, ts: now + 10000, kind: 'assistant', model: 'claude-3-5-sonnet-20241022', input: 25_000, output: 3_000, cacheRead: 12_000, cacheWrite: 0 },
  ];
  upsertSessions(db, sessions);
  upsertEvents(db, events);

  const findings: Finding[] = [
    {
      id: 'f_retry_1',
      rule: 'retry_loop',
      projectId: null,
      sessionId,
      evidence: { tool: 'Bash', count: 3 },
      confidence: 'high',
      confidenceReason: 'Repeated bash retries',
      estTokensWeek: 20_000,
      firstSeen: now + 5000,
      lastSeen: now + 5000,
    },
  ];
  upsertFindings(db, findings);

  // 1. Test backing query directly
  const data = sessionTimeline(db, sessionId);
  assert.equal(data.sessionId, sessionId);
  assert.equal(data.turns.length, 3);
  assert.equal(data.turns[0].turnIndex, 1);
  assert.equal(data.turns[0].input, 10_000);
  assert.equal(data.turns[0].cacheRead, 5_000);
  assert.equal(data.turns[0].output, 1_000);

  assert.equal(data.markers.length, 1);
  assert.equal(data.markers[0].rule, 'retry_loop');
  assert.equal(data.markers[0].turnIndex, 2); // Fired at now + 5000 -> turn 2!
  assert.equal(data.markers[0].confidence, 'high');

  // 2. Test GET /api/session/timeline HTTP route
  const server = await startServer(db, 0, '127.0.0.1');
  const port = (server.address() as AddressInfo).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/session/timeline?id=${sessionId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sessionId, sessionId);
    assert.equal(body.turns.length, 3);
    assert.equal(body.markers.length, 1);
    assert.equal(body.markers[0].turnIndex, 2);
  } finally {
    await server.close();
  }
});
