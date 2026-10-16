import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertProject, upsertSessions, upsertEvents, upsertRecommendations, getRecommendations } from '../src/db.ts';
import { evaluateRecommendations } from '../src/track.ts';
import type { NormalizedEvent, Recommendation, SessionInfo } from '../src/types.ts';

function createMockSessionsAndEvents(
  db: any,
  projectId: number,
  acceptedAt: number,
  beforeCount: number,
  afterCount: number,
  options?: {
    beforeTokens?: number;
    afterTokens?: number;
    beforeErrors?: number;
    afterErrors?: number;
    rule?: string;
  }
) {
  const beforeTokens = options?.beforeTokens ?? 10_000;
  const afterTokens = options?.afterTokens ?? 5_000;
  const beforeErrors = options?.beforeErrors ?? 0;
  const afterErrors = options?.afterErrors ?? 0;

  const sessions: (SessionInfo & { projectId: number | null })[] = [];
  const events: NormalizedEvent[] = [];

  // Before sessions: spread over 7 days before acceptedAt
  for (let i = 0; i < beforeCount; i++) {
    const sId = `s_before_${i}`;
    const ts = acceptedAt - (beforeCount - i) * 3600_000;
    sessions.push({
      id: sId,
      agent: 'claude',
      projectId,
      cwd: '/test/proj',
    });

    // 2 turns per session
    events.push({
      id: `e_b_${i}_u`,
      agent: 'claude',
      sessionId: sId,
      ts: ts + 10_000,
      kind: 'user',
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    events.push({
      id: `e_b_${i}_a`,
      agent: 'claude',
      sessionId: sId,
      ts: ts + 20_000,
      kind: 'assistant',
      input: Math.round(beforeTokens / 2),
      output: Math.round(beforeTokens / 2),
      cacheRead: 0,
      cacheWrite: 0,
    });
    events.push({
      id: `e_b_${i}_t`,
      agent: 'claude',
      sessionId: sId,
      ts: ts + 30_000,
      kind: 'tool_call',
      tool: 'read_file',
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      isError: i < beforeErrors,
    });
  }

  // After sessions: spread after acceptedAt
  for (let i = 0; i < afterCount; i++) {
    const sId = `s_after_${i}`;
    const ts = acceptedAt + (i + 1) * 3600_000;
    sessions.push({
      id: sId,
      agent: 'claude',
      projectId,
      cwd: '/test/proj',
    });

    events.push({
      id: `e_a_${i}_u`,
      agent: 'claude',
      sessionId: sId,
      ts: ts + 10_000,
      kind: 'user',
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    events.push({
      id: `e_a_${i}_a`,
      agent: 'claude',
      sessionId: sId,
      ts: ts + 20_000,
      kind: 'assistant',
      input: Math.round(afterTokens / 2),
      output: Math.round(afterTokens / 2),
      cacheRead: 0,
      cacheWrite: 0,
    });
    events.push({
      id: `e_a_${i}_t`,
      agent: 'claude',
      sessionId: sId,
      ts: ts + 30_000,
      kind: 'tool_call',
      tool: 'read_file',
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      isError: i < afterErrors,
    });
  }

  upsertSessions(db, sessions);
  upsertEvents(db, events);
}

test('evaluateRecommendations: insufficient data (< 5 sessions) keeps measuring status', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/test/proj', 'test-proj');
  const acceptedAt = 1_700_000_000_000;

  const rec: Recommendation = {
    id: 'rec_1',
    findingRule: 'context_growth',
    projectId: projId,
    action: 'improve',
    title: 'Compact context periodically',
    body: 'Reduce context growth',
    status: 'accepted',
    acceptedAt,
  };
  upsertRecommendations(db, [rec]);

  // Only 3 sessions before, 2 sessions after
  createMockSessionsAndEvents(db, projId, acceptedAt, 3, 2);

  const evaluated = evaluateRecommendations(db, acceptedAt + 86400_000);
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].status, 'measuring');
  assert.equal(evaluated[0].result?.verdict, 'insufficient_data');
  assert.equal(evaluated[0].result?.sampleBefore, 3);
  assert.equal(evaluated[0].result?.sampleAfter, 2);

  const dbRecs = getRecommendations(db);
  assert.equal(dbRecs[0].status, 'measuring');
});

test('evaluateRecommendations: verifies recommendation when tokens drop > 10% and guardrails hold', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/test/proj', 'test-proj');
  const acceptedAt = 1_700_000_000_000;

  const rec: Recommendation = {
    id: 'rec_2',
    findingRule: 'context_growth',
    projectId: projId,
    action: 'improve',
    title: 'Compact context',
    body: 'Reduce runaway tokens',
    status: 'accepted',
    acceptedAt,
  };
  upsertRecommendations(db, [rec]);

  // 6 sessions before (10k tokens each), 6 sessions after (4k tokens each, ~60% reduction)
  createMockSessionsAndEvents(db, projId, acceptedAt, 6, 6, {
    beforeTokens: 10_000,
    afterTokens: 4_000,
    beforeErrors: 0,
    afterErrors: 0,
  });

  const evaluated = evaluateRecommendations(db, acceptedAt + 86400_000 * 2);
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].status, 'verified');
  assert.equal(evaluated[0].result?.verdict, 'verified');
  assert.ok(evaluated[0].result?.deltaPct <= -50);
  assert.equal(evaluated[0].result?.guardrails.passed, true);

  const dbRecs = getRecommendations(db);
  assert.equal(dbRecs[0].status, 'verified');
});

test('evaluateRecommendations: declares no_effect when tokens change within noise band (-5% to +5%)', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/test/proj', 'test-proj');
  const acceptedAt = 1_700_000_000_000;

  const rec: Recommendation = {
    id: 'rec_3',
    findingRule: 'context_growth',
    projectId: projId,
    action: 'improve',
    title: 'Compact context',
    body: 'Reduce runaway tokens',
    status: 'accepted',
    acceptedAt,
  };
  upsertRecommendations(db, [rec]);

  // 5 sessions before (10,000 tokens), 5 sessions after (9,900 tokens, -1% change)
  createMockSessionsAndEvents(db, projId, acceptedAt, 5, 5, {
    beforeTokens: 10_000,
    afterTokens: 9_900,
  });

  const evaluated = evaluateRecommendations(db, acceptedAt + 86400_000 * 2);
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].status, 'no_effect');
  assert.equal(evaluated[0].result?.verdict, 'no_effect');
});

test('evaluateRecommendations: declares regressed when guardrail breaks (> 10% tool error rate spike)', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/test/proj', 'test-proj');
  const acceptedAt = 1_700_000_000_000;

  const rec: Recommendation = {
    id: 'rec_4',
    findingRule: 'context_growth',
    projectId: projId,
    action: 'improve',
    title: 'Compact context',
    body: 'Reduce runaway tokens',
    status: 'accepted',
    acceptedAt,
  };
  upsertRecommendations(db, [rec]);

  // 5 sessions before (10k tokens, 0 errors), 5 sessions after (3k tokens, but 3 errors = 60% error rate!)
  createMockSessionsAndEvents(db, projId, acceptedAt, 5, 5, {
    beforeTokens: 10_000,
    afterTokens: 3_000,
    beforeErrors: 0,
    afterErrors: 3,
  });

  const evaluated = evaluateRecommendations(db, acceptedAt + 86400_000 * 2);
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].status, 'regressed');
  assert.equal(evaluated[0].result?.verdict, 'regressed');
  assert.equal(evaluated[0].result?.guardrails.passed, false);
});

test('evaluateRecommendations: continues evaluation across 14-day tracking window', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/test/proj', 'test-proj');
  const acceptedAt = 1_700_000_000_000;

  const rec: Recommendation = {
    id: 'rec_5',
    findingRule: 'context_growth',
    projectId: projId,
    action: 'improve',
    title: 'Compact context',
    body: 'Reduce runaway tokens',
    status: 'accepted',
    acceptedAt,
  };
  upsertRecommendations(db, [rec]);

  // Initial 5 sessions before & after: verified reduction
  createMockSessionsAndEvents(db, projId, acceptedAt, 5, 5, {
    beforeTokens: 10_000,
    afterTokens: 4_000,
  });

  const eval1 = evaluateRecommendations(db, acceptedAt + 86400_000 * 2);
  assert.equal(eval1.length, 1);
  assert.equal(eval1[0].status, 'verified');
  assert.equal(eval1[0].result?.sampleAfter, 5);

  // 3 days later, 3 more sessions occur within tracking window
  const sessions: (SessionInfo & { projectId: number | null })[] = [];
  const events: NormalizedEvent[] = [];
  for (let i = 5; i < 8; i++) {
    const sId = `s_after_extra_${i}`;
    const ts = acceptedAt + 86400_000 * 3 + (i - 5) * 3600_000;
    sessions.push({ id: sId, agent: 'claude', projectId: projId, cwd: '/test/proj' });
    events.push({
      id: `e_extra_${i}_u`,
      agent: 'claude',
      sessionId: sId,
      ts: ts + 10_000,
      kind: 'user',
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    events.push({
      id: `e_extra_${i}_a`,
      agent: 'claude',
      sessionId: sId,
      ts: ts + 20_000,
      kind: 'assistant',
      input: 2_000,
      output: 2_000,
      cacheRead: 0,
      cacheWrite: 0,
    });
  }
  upsertSessions(db, sessions);
  upsertEvents(db, events);

  // Next evaluation run should NOT ignore the verified recommendation while in the 14-day window!
  const eval2 = evaluateRecommendations(db, acceptedAt + 86400_000 * 5);
  assert.equal(eval2.length, 1);
  assert.equal(eval2[0].result?.sampleAfter, 8);
});

test('evaluateRecommendations: turns-per-session guardrail fails when turns regress by > 10% (e.g. +15%)', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/test/proj', 'test-proj');
  const acceptedAt = 1_700_000_000_000;

  const rec: Recommendation = {
    id: 'rec_6',
    findingRule: 'context_growth',
    projectId: projId,
    action: 'improve',
    title: 'Compact context',
    body: 'Reduce runaway tokens',
    status: 'accepted',
    acceptedAt,
  };
  upsertRecommendations(db, [rec]);

  const sessions: (SessionInfo & { projectId: number | null })[] = [];
  const events: NormalizedEvent[] = [];

  // Before: 5 sessions, exactly 2 user turns per session (avgTurns = 2.0)
  for (let i = 0; i < 5; i++) {
    const sId = `s_b_${i}`;
    const ts = acceptedAt - (5 - i) * 3600_000;
    sessions.push({ id: sId, agent: 'claude', projectId: projId, cwd: '/test/proj' });
    for (let t = 0; t < 2; t++) {
      events.push({
        id: `e_b_${i}_${t}_u`,
        agent: 'claude',
        sessionId: sId,
        ts: ts + t * 2000,
        kind: 'user',
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      events.push({
        id: `e_b_${i}_${t}_a`,
        agent: 'claude',
        sessionId: sId,
        ts: ts + t * 2000 + 1000,
        kind: 'assistant',
        input: 2_500,
        output: 2_500,
        cacheRead: 0,
        cacheWrite: 0,
      });
    }
  }

  // After: 5 sessions with 2.4 user turns average (+20% increase, exceeding 10% limit)
  // 3 sessions with 2 turns, 2 sessions with 3 turns = 12 turns / 5 sessions = 2.4 turns/session (+20%)
  for (let i = 0; i < 5; i++) {
    const sId = `s_a_${i}`;
    const ts = acceptedAt + (i + 1) * 3600_000;
    sessions.push({ id: sId, agent: 'claude', projectId: projId, cwd: '/test/proj' });
    const turnCount = i < 2 ? 3 : 2;
    for (let t = 0; t < turnCount; t++) {
      events.push({
        id: `e_a_${i}_${t}_u`,
        agent: 'claude',
        sessionId: sId,
        ts: ts + t * 2000,
        kind: 'user',
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      events.push({
        id: `e_a_${i}_${t}_a`,
        agent: 'claude',
        sessionId: sId,
        ts: ts + t * 2000 + 1000,
        kind: 'assistant',
        input: 1_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
      });
    }
  }

  upsertSessions(db, sessions);
  upsertEvents(db, events);

  const evaluated = evaluateRecommendations(db, acceptedAt + 86400_000 * 2);
  assert.equal(evaluated.length, 1);
  // Token reduction was > 50%, but turns/session increased by 20% (> 10%), so guardrail fails
  assert.equal(evaluated[0].status, 'regressed');
  assert.equal(evaluated[0].result?.guardrails.passed, false);
});
