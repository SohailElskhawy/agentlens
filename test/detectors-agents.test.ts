import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertEvents, upsertProject, upsertSessions, insertQuotas } from '../src/db.ts';
import { detectModelFit } from '../src/analyze/model_fit.ts';
import { detectHandoffs } from '../src/analyze/handoff.ts';
import { detectSubagentShare } from '../src/analyze/subagent_share.ts';
import { detectQuotaPressure } from '../src/analyze/quota_pressure.ts';

test('detectModelFit detects flagship models on trivial turns', () => {
  const db = openDb(':memory:');
  const pId = upsertProject(db, '/work/repo', 'repo');
  upsertSessions(db, [{ id: 's1', agent: 'claude', cwd: '/work/repo', projectId: pId }]);

  const now = Date.now();
  upsertEvents(db, [
    { id: 'e1', agent: 'claude', sessionId: 's1', ts: now, kind: 'assistant', model: 'claude-3-opus-20240229', input: 5000, output: 25 },
  ]);

  const findings = detectModelFit(db);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'model_fit');
  assert.equal(findings[0].sessionId, 's1');
  assert.match(findings[0].confidenceReason, /claude-3-opus/);
  assert.ok(findings[0].estTokensWeek > 0);
});

test('detectHandoffs detects agent switching on same project within 30 minutes', () => {
  const db = openDb(':memory:');
  const pId = upsertProject(db, '/work/repo', 'repo');
  const now = Date.now();

  upsertSessions(db, [
    { id: 's1', agent: 'claude', cwd: '/work/repo', projectId: pId },
    { id: 's2', agent: 'codex', cwd: '/work/repo', projectId: pId },
  ]);

  upsertEvents(db, [
    { id: 'e1', agent: 'claude', sessionId: 's1', ts: now, kind: 'assistant', input: 10_000, output: 500 },
    // s1 has another turn 40 mins later
    { id: 'e1_late', agent: 'claude', sessionId: 's1', ts: now + 2400_000, kind: 'assistant', input: 10_000, output: 500 },
    // Switch to codex 5 mins after s1 ended (2400_000 + 300_000 = 2700_000, which is 45m from s1 start, but only 5m from s1 end)
    { id: 'e2', agent: 'codex', sessionId: 's2', ts: now + 2700_000, kind: 'assistant', input: 15_000, output: 500 },
  ]);

  const findings = detectHandoffs(db);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'handoff');
  assert.equal(findings[0].sessionId, 's2');
  assert.equal(findings[0].evidence.previousAgent, 'claude');
  assert.equal(findings[0].evidence.currentAgent, 'codex');
  assert.ok(findings[0].estTokensWeek >= 5000);
});

test('detectSubagentShare detects subagents with low return yield', () => {
  const db = openDb(':memory:');
  const pId = upsertProject(db, '/work/repo', 'repo');

  upsertSessions(db, [
    { id: 'parent-1', agent: 'claude', cwd: '/work/repo', projectId: pId },
    { id: 'child-1', agent: 'claude', cwd: '/work/repo', projectId: pId, parentId: 'parent-1' },
  ]);

  const now = Date.now();
  upsertEvents(db, [
    // Subagent ran with 60k input tokens but only produced 150 output tokens
    { id: 'e1', agent: 'claude', sessionId: 'child-1', ts: now, kind: 'assistant', input: 60_000, output: 150 },
  ]);

  const findings = detectSubagentShare(db);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'subagent_share');
  assert.equal(findings[0].sessionId, 'child-1');
  assert.equal(findings[0].confidence, 'low');
  assert.ok(findings[0].estTokensWeek > 20_000);
});

test('detectQuotaPressure detects quota exhaustion and deduplicates multiple snapshots for same window', () => {
  const db = openDb(':memory:');
  const now = Date.now();

  insertQuotas(db, [
    { agent: 'claude', ts: now, window: '5h', usedPct: 88.5, resetsAt: now + 3600_000, source: 'claude-statusline' },
    { agent: 'claude', ts: now + 60_000, window: '5h', usedPct: 92.0, resetsAt: now + 3600_000, source: 'claude-statusline' },
    { agent: 'claude', ts: now + 120_000, window: '5h', usedPct: 95.0, resetsAt: now + 3600_000, source: 'claude-statusline' },
  ]);

  const findings = detectQuotaPressure(db);
  // Must return 1 finding for claude 5h, not 3!
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'quota_pressure');
  assert.equal(findings[0].evidence.agent, 'claude');
  assert.equal(findings[0].evidence.usedPct, 95.0);
});
