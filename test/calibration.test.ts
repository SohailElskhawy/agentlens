import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  openDb, upsertProject, upsertSessions, upsertEvents, upsertFindings,
  getFindings, getRecommendations, updateRecommendationStatus,
} from '../src/db.ts';
import { loadScopeBudgets, calibrateFindings } from '../src/analyze/calibration.ts';
import { runDetectors } from '../src/analyze/runner.ts';
import { CONFIDENCE_WEIGHTS } from '../src/analyze/constants.ts';
import { ingest } from '../src/ingest.ts';
import { claude } from '../src/adapters/claude.ts';
import type { Finding, NormalizedEvent } from '../src/types.ts';
import { tmp, put, jsonl, cAssistant } from './helpers.ts';

const NOW = 1_793_000_000_000; // fixed epoch ms; all windows are relative to this
const WEEK = 7 * 86_400_000;
const FROM = NOW - WEEK;

let n = 0;
const ev = (
  sessionId: string,
  ts: number,
  tokens: Partial<Pick<NormalizedEvent, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cacheWrite1h' | 'reasoning'>> = {},
): NormalizedEvent => ({
  id: `cal-ev${n++}`, agent: 'claude', sessionId, ts, kind: 'assistant', model: 'claude-sonnet',
  input: tokens.input ?? 0, output: tokens.output ?? 0, cacheRead: tokens.cacheRead ?? 0, cacheWrite: tokens.cacheWrite ?? 0,
  ...(tokens.cacheWrite1h !== undefined ? { cacheWrite1h: tokens.cacheWrite1h } : {}),
  ...(tokens.reasoning !== undefined ? { reasoning: tokens.reasoning } : {}),
});

const mk = (id: string, over: Partial<Finding>): Finding => ({
  id, rule: 'retry_loop', projectId: null, sessionId: null, evidence: {}, confidence: 'medium',
  confidenceReason: 'seeded', estTokensWeek: 999_999, firstSeen: 0, lastSeen: 0, ...over,
});

test('scope budgets: session > project > global precedence with exact weekly totals', () => {
  const db = openDb(':memory:');
  const p1 = upsertProject(db, '/work/p1', 'p1');
  const p2 = upsertProject(db, '/work/p2', 'p2');
  upsertSessions(db, [
    { id: 'sa', agent: 'claude', projectId: p1 },
    { id: 'sb', agent: 'claude', projectId: p1 },
    { id: 'sc', agent: 'claude', projectId: p2 },
  ]);
  upsertEvents(db, [
    ev('sa', NOW - 1000, { input: 100, output: 100, cacheRead: 50, cacheWrite: 50 }), // 300
    ev('sb', NOW - 2000, { input: 200 }), // p1 project total 500
    ev('sc', FROM - 5000, { input: 7000 }), // old activity only: outside the trailing week
    ev('so', NOW - 3000, { input: 40 }), // orphan: session not in the sessions table
  ]);

  const budgets = loadScopeBudgets(db, NOW);
  assert.equal(budgets.global, 540, 'global = 300 + 200 + 40; orphan events count, old events do not');
  assert.equal(budgets.session.get('sa'), 300);
  assert.equal(budgets.session.get('sb'), 200);
  assert.equal(budgets.session.get('so'), 40, 'orphan events remain in their session total');
  assert.equal(budgets.project.get(p1), 500);
  assert.equal(budgets.project.get(p2) ?? 0, 0, 'project with lifetime tokens but an empty week has no budget');
  assert.equal(budgets.session.get('missing') ?? 0, 0);

  const findings = [
    mk('f_session', { sessionId: 'sa', projectId: p1 }),
    mk('f_project', { projectId: p1 }),
    mk('f_global', {}),
    mk('f_ghost_session', { sessionId: 'ghost' }),
    mk('f_empty_project', { projectId: p2 }),
    mk('f_negative', { sessionId: 'sa', estTokensWeek: -5 }),
  ];
  calibrateFindings(findings, budgets);
  assert.deepEqual(
    findings.map((f) => f.estTokensWeek),
    [300, 500, 540, 0, 0, 0],
    'session > project > global; absent scopes are zero with no broader fallback; negative raw clamps to zero',
  );
});

test('window endpoints inclusive; just-outside and future events excluded; four components summed once', () => {
  const db = openDb(':memory:');
  upsertSessions(db, [{ id: 's_edge', agent: 'claude', projectId: null }]);
  upsertEvents(db, [
    ev('s_edge', FROM, { input: 1 }), // exactly week-ago boundary: included
    ev('s_edge', NOW, { output: 2 }), // exactly now: included
    ev('s_edge', FROM - 1, { input: 1000 }), // just outside: excluded
    ev('s_edge', NOW + 1, { input: 1000 }), // future: excluded
    ev('s_edge', NOW - 10, { cacheRead: 3, cacheWrite: 4, cacheWrite1h: 999, reasoning: 999 }),
  ]);

  const budgets = loadScopeBudgets(db, NOW);
  assert.equal(budgets.session.get('s_edge'), 10, 'input + output + cache_read + cache_write; subsets not re-added');
  assert.equal(budgets.global, 10);
});

test('overlapping findings on one scope are capped independently, not as a sum', () => {
  const db = openDb(':memory:');
  const p1 = upsertProject(db, '/work/p1', 'p1');
  upsertSessions(db, [{ id: 'sa', agent: 'claude', projectId: p1 }]);
  upsertEvents(db, [ev('sa', NOW - 1000, { input: 300 })]);

  const budgets = loadScopeBudgets(db, NOW);
  const f1 = mk('f1', { sessionId: 'sa' });
  const f2 = mk('f2', { sessionId: 'sa' });
  calibrateFindings([f1, f2], budgets);
  assert.equal(f1.estTokensWeek, 300);
  assert.equal(f2.estTokensWeek, 300, 'caps do not de-duplicate: the two findings sum above actual usage');
});

test('runDetectors calibrates new and stale stored findings; filtered runs still cap other scopes', () => {
  const db = openDb(':memory:');
  const p1 = upsertProject(db, '/work/p1', 'p1');
  const p2 = upsertProject(db, '/work/p2', 'p2');
  upsertSessions(db, [{ id: 'sa', agent: 'claude', projectId: p1 }]);
  upsertEvents(db, [ev('sa', NOW - 1000, { input: 300 })]);
  upsertFindings(db, [
    mk('stale:p2', { projectId: p2 }),
    mk('stale:sa', { sessionId: 'sa' }),
  ]);

  const findings = runDetectors(db, { now: NOW, projectId: p1 });
  for (const f of findings) assert.ok(f.estTokensWeek <= 300, 'every returned finding respects the scope budget');

  const persisted = getFindings(db);
  const byId = new Map(persisted.map((f) => [f.id, f]));
  assert.equal(byId.get('stale:p2')?.estTokensWeek, 0, 'stale finding in an empty scope is zero, not global');
  assert.equal(byId.get('stale:sa')?.estTokensWeek, 300, 'stale finding capped to its session budget');
  assert.ok(byId.has('stale:p2') && byId.has('stale:sa'), 'calibration does not delete stale findings');
  for (const f of findings) {
    assert.equal(byId.get(f.id)?.estTokensWeek, f.estTokensWeek, 'returned findings equal their persisted estimates');
  }
});

test('aggregates load once per run regardless of finding count', () => {
  const db = openDb(':memory:');
  const p1 = upsertProject(db, '/work/p1', 'p1');
  upsertSessions(db, [{ id: 'sa', agent: 'claude', projectId: p1 }]);
  upsertEvents(db, [ev('sa', NOW - 1000, { input: 300 })]);
  upsertFindings(db, Array.from({ length: 40 }, (_, i) => mk(`stale:${i}`, { projectId: p1 })));

  let calls = 0;
  const orig = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => {
    if (sql.includes('LEFT JOIN sessions s ON s.id = e.session_id') && sql.includes('e.ts >= ?')) calls++;
    return orig(sql);
  };
  try {
    runDetectors(db, { now: NOW });
  } finally {
    delete (db as any).prepare;
  }
  assert.equal(calls, 1, 'one grouped weekly query, independent of finding count');

  const persisted = getFindings(db);
  assert.equal(persisted.length, 40);
  assert.ok(persisted.every((f) => f.estTokensWeek === 300), 'all stale findings capped via the single load');
});

test('second run at a fixed now is deterministic; window rollover lowers estimates without deleting', () => {
  const db = openDb(':memory:');
  const p1 = upsertProject(db, '/work/p1', 'p1');
  upsertSessions(db, [{ id: 'sa', agent: 'claude', projectId: p1 }]);
  upsertEvents(db, [ev('sa', NOW - 1000, { input: 300 })]);
  upsertFindings(db, [mk('stale:rollover', { sessionId: 'sa' })]);

  const run1 = runDetectors(db, { now: NOW });
  const stored1 = getFindings(db);
  const run2 = runDetectors(db, { now: NOW });
  assert.deepEqual(
    run2.map((f) => [f.id, f.estTokensWeek]),
    run1.map((f) => [f.id, f.estTokensWeek]),
    'same fixed now: deterministic ids and calibrated estimates',
  );

  runDetectors(db, { now: NOW + 8 * WEEK });
  const stored3 = getFindings(db);
  assert.equal(stored3.length, stored1.length, 'rollover does not delete findings');
  assert.ok(
    stored1.some((f) => f.estTokensWeek > 0) && stored3.every((f) => f.estTokensWeek === 0),
    'all events out of the window: estimates decrease to zero and cannot recover upward',
  );
  upsertEvents(db, [ev('sa', NOW + 8 * WEEK, { input: 500 })]);
  runDetectors(db, { now: NOW + 8 * WEEK });
  assert.equal(getFindings(db).find((f) => f.id === 'stale:rollover')?.estTokensWeek, 0,
    'a stale estimate cannot recover when the budget rises without its producer running');
});

test('ingest recomputes recommendations with calibrated scores and preserves completed tracking', async () => {
  const home = tmp();
  const ts = new Date(Date.now() - 60_000).toISOString(); // inside the trailing week of the real clock
  const file = put(join(home, '.claude/projects/-tmp-x/s1.jsonl'), jsonl(
    cAssistant({ msg: 'm1', ts, cwd: '/tmp/x' }), // single-turn flagship session -> model_fit
  ));
  const db = openDb(':memory:');

  await ingest(db, home, [claude]);
  const f = getFindings(db).find((x) => x.rule === 'model_fit');
  assert.ok(f, 'model_fit finding produced');
  assert.equal(f.estTokensWeek, 162, 'capped to the session trailing-week tokens (2+10+100+50)');

  const rec = getRecommendations(db).find((r) => r.id === `rec:model_fit:${f.projectId ?? 'global'}:${f.id}`);
  assert.ok(rec, 'recommendation for the calibrated finding');
  updateRecommendationStatus(db, rec.id, 'accepted');
  // Completed tracking outside the evaluation window is retained during ingest refresh.
  db.prepare('UPDATE recommendations SET status = ?, accepted_at = ?, result = ? WHERE id = ?')
    .run('verified', Date.now() - 30 * 86_400_000, JSON.stringify({ note: 'pending' }), rec.id);

  appendFileSync(file, jsonl(cAssistant({ msg: 'm2', req: 'r2', out: 5, ts, cwd: '/tmp/x' })));
  await ingest(db, home, [claude]); // second turn: model_fit no longer fires fresh, stored finding stays

  const rec2 = getRecommendations(db).find((r) => r.id === rec.id);
  assert.ok(rec2, 'recommendation id unchanged');
  assert.equal(rec2.status, 'verified');
  assert.ok(rec2.acceptedAt != null && rec2.acceptedAt > 0);
  assert.deepEqual(rec2.result, { note: 'pending' });
  const f2 = getFindings(db).find((x) => x.id === f.id);
  assert.ok(f2, 'stale finding remains after calibration');
  assert.equal(rec2.score, Math.round(f2.estTokensWeek * (CONFIDENCE_WEIGHTS[f2.confidence] ?? 0.6)),
    'score equals rounded calibrated estimate times the existing weight');
});
