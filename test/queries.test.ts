import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertEvents, upsertSessions, upsertProject, insertQuotas } from '../src/db.ts';
import * as q from '../src/queries.ts';
import { costOf } from '../src/pricing.ts';
import type { NormalizedEvent } from '../src/types.ts';

const day1 = new Date(2026, 9, 14, 12).getTime(); // local noon, so local-day bucketing is unambiguous
const day2 = new Date(2026, 9, 15, 12).getTime();
const localDay = (ms: number) => new Date(ms).toLocaleDateString('sv');

function seed() {
  const db = openDb(':memory:');
  const a = upsertProject(db, '/r/app', 'app');
  const b = upsertProject(db, '/r/api', 'api');
  upsertSessions(db, [
    { id: 's1', agent: 'claude', cwd: '/r/app', projectId: a },
    { id: 's3', agent: 'claude', cwd: '/r/app', parentId: 's1', projectId: a },
    { id: 's2', agent: 'codex', cwd: '/r/api', projectId: b },
  ]);
  const t = (id: string, session: string, ts: number, model: string, input: number, output: number): NormalizedEvent =>
    ({ id, agent: session === 's2' ? 'codex' : 'claude', sessionId: session, ts, kind: 'assistant', model, input, output, cacheRead: 100, cacheWrite: 10, cacheWrite1h: 10 });
  upsertEvents(db, [
    t('e1', 's1', day1, 'claude-opus-5-5', 5, 50),
    t('e2', 's1', day2, 'claude-opus-5-5', 7, 70),
    t('e3', 's3', day2 + 1000, 'claude-haiku-5-5', 1, 10),
    t('e4', 's2', day2 + 2000, 'codex-auto-review', 3, 30),
    { id: 'c1', agent: 'claude', sessionId: 's1', ts: day2, kind: 'tool_call', tool: 'Bash' },
    { id: 'c1:result', agent: 'claude', sessionId: 's1', ts: day2, kind: 'tool_result', resultBytes: 5, isError: true },
  ]);
  insertQuotas(db, [
    { agent: 'codex', ts: day1, window: '5h', usedPct: 50, resetsAt: day1 + 1, source: 'codex-log' },
    { agent: 'codex', ts: day2, window: '5h', usedPct: 100, resetsAt: day2 + 1, source: 'codex-log' },
  ]);
  return { db, a, b };
}

const tok = (input: number, output: number) => input + output + 110;

test('summary totals tokens, and keeps unpriced models out of cost', () => {
  const { db } = seed();
  const s = q.summary(db, {});
  assert.equal(s.totals.tokens, tok(5, 50) + tok(7, 70) + tok(1, 10) + tok(3, 30));
  assert.equal(s.totals.unpricedTokens, tok(3, 30), 'codex-auto-review has no price');
  const u = (i: number, o: number) => ({ input: i, output: o, cacheRead: 100, cacheWrite: 10, cacheWrite1h: 10 });
  const expected = costOf('claude-opus-5-5', u(5, 50))! + costOf('claude-opus-5-5', u(7, 70))! + costOf('claude-haiku-5-5', u(1, 10))!;
  assert.ok(Math.abs(s.totals.cost - expected) < 1e-12);
  assert.equal(s.sessions, 3);
  assert.deepEqual(s.byAgent.map((g) => g.agent).sort(), ['claude', 'codex']);
});

test('filters by agent, project and time', () => {
  const { db, a } = seed();
  assert.equal(q.summary(db, { agent: 'codex' }).totals.tokens, tok(3, 30));
  assert.equal(q.summary(db, { projectId: a }).sessions, 2);
  assert.equal(q.summary(db, { from: day2 }).totals.tokens, tok(7, 70) + tok(1, 10) + tok(3, 30));
});

test('daily buckets by local day and agent', () => {
  const { db } = seed();
  const d = q.daily(db, {});
  assert.deepEqual(d.map((r) => [r.day, r.agent]), [[localDay(day1), 'claude'], [localDay(day2), 'claude'], [localDay(day2), 'codex']]);
});

test('projects and models rank by tokens', () => {
  const { db } = seed();
  const p = q.projects(db, {});
  assert.deepEqual(p.map((r) => [r.name, r.sessions]), [['app', 2], ['api', 1]]);
  assert.equal(p[0].agents, 'claude');
  assert.equal(q.models(db, {})[0].name, 'claude-opus-5-5');
});

test('sessions lists newest first with turns and tool calls; detail joins tool results', () => {
  const { db } = seed();
  const list = q.sessions(db, {}, 2);
  assert.deepEqual(list.map((r) => r.id), ['s2', 's3']);
  const s1 = q.sessions(db, {}).find((r) => r.id === 's1')!;
  assert.deepEqual([s1.turns, s1.toolCalls, s1.project], [2, 1, 'app']);
  const d = q.sessionDetail(db, 's1')!;
  assert.deepEqual(d.turns.map((t) => t.context), [5 + 110, 7 + 110]);
  assert.deepEqual(d.tools, [{ tool: 'Bash', calls: 1, resultBytes: 5, errors: 1 }].map((x) => ({ ...x })));
  assert.deepEqual(d.children.map((c) => c.id), ['s3']);
  assert.equal(d.totals.tokens, tok(5, 50) + tok(7, 70));
  assert.equal(q.sessionDetail(db, 'nope'), null);
});

test('quota returns the latest snapshot per window and limit hits', () => {
  const { db } = seed();
  const r = q.quota(db, {});
  assert.deepEqual(r.latest.map((l) => [l.agent, l.win, l.usedPct]), [['codex', '5h', 100]]);
  assert.equal(r.timeline.length, 2);
  assert.equal(r.limitHits.length, 1);
});
