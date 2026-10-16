import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertEvents, upsertProject, upsertSessions } from '../src/db.ts';
import { detectContextGrowth } from '../src/analyze/context_growth.ts';
import { detectCacheMisses } from '../src/analyze/cache_miss.ts';
import { detectRepeatedPrompts } from '../src/analyze/repeated_prompt.ts';

test('detectContextGrowth detects runaway prompt tokens without compaction', () => {
  const db = openDb(':memory:');
  const pId = upsertProject(db, '/work/repo', 'repo');
  upsertSessions(db, [{ id: 's1', agent: 'claude', cwd: '/work/repo', projectId: pId }]);

  const now = Date.now();
  upsertEvents(db, [
    { id: 'e1', agent: 'claude', sessionId: 's1', ts: now + 100, kind: 'assistant', input: 30_000, output: 500 },
    { id: 'e2', agent: 'claude', sessionId: 's1', ts: now + 200, kind: 'assistant', input: 80_000, output: 500 },
    { id: 'e3', agent: 'claude', sessionId: 's1', ts: now + 300, kind: 'assistant', input: 140_000, output: 500 },
  ]);

  // Session s2 reached 120k, but user ran /compact and final turn dropped to 25k
  upsertSessions(db, [{ id: 's2', agent: 'claude', cwd: '/work/repo', projectId: pId }]);
  upsertEvents(db, [
    { id: 'e2_1', agent: 'claude', sessionId: 's2', ts: now + 100, kind: 'assistant', input: 30_000, output: 500 },
    { id: 'e2_2', agent: 'claude', sessionId: 's2', ts: now + 200, kind: 'assistant', input: 120_000, output: 500 },
    { id: 'e2_3', agent: 'claude', sessionId: 's2', ts: now + 300, kind: 'assistant', input: 25_000, output: 500 },
  ]);

  const findings = detectContextGrowth(db);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'context_growth');
  assert.equal(findings[0].sessionId, 's1');
  assert.equal(findings[0].evidence.peakTokens, 140_000);
  assert.ok(findings[0].estTokensWeek > 50_000);
});

test('detectCacheMisses detects cold cache re-ingestion on Claude/Codex but ignores non-caching agents', () => {
  const db = openDb(':memory:');
  const pId = upsertProject(db, '/work/repo', 'repo');
  upsertSessions(db, [
    { id: 's1', agent: 'claude', cwd: '/work/repo', projectId: pId },
    { id: 's_opencode', agent: 'opencode', cwd: '/work/repo', projectId: pId },
  ]);

  const now = Date.now();
  upsertEvents(db, [
    // Claude Turn 1 & 2
    { id: 'e1', agent: 'claude', sessionId: 's1', ts: now, kind: 'assistant', input: 40_000, output: 500, cacheWrite: 40_000 },
    { id: 'e2', agent: 'claude', sessionId: 's1', ts: now + 600_000, kind: 'assistant', input: 40_000, output: 500, cacheRead: 0 },
    // OpenCode Turn 1 & 2 (has no cache support)
    { id: 'op1', agent: 'opencode', sessionId: 's_opencode', ts: now, kind: 'assistant', input: 40_000, output: 500, cacheRead: 0 },
    { id: 'op2', agent: 'opencode', sessionId: 's_opencode', ts: now + 600_000, kind: 'assistant', input: 40_000, output: 500, cacheRead: 0 },
  ]);

  const findings = detectCacheMisses(db);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'cache_miss');
  assert.equal(findings[0].sessionId, 's1');
  assert.equal(findings[0].evidence.idleMinutes, 10);
  assert.ok(findings[0].estTokensWeek >= 30_000);
});

test('detectRepeatedPrompts detects identical user prompts across sessions', () => {
  const db = openDb(':memory:');
  const pId = upsertProject(db, '/work/repo', 'repo');
  upsertSessions(db, [
    { id: 's1', agent: 'claude', cwd: '/work/repo', projectId: pId },
    { id: 's2', agent: 'claude', cwd: '/work/repo', projectId: pId },
    { id: 's3', agent: 'claude', cwd: '/work/repo', projectId: pId },
  ]);

  const now = Date.now();
  const hash = 'a1b2c3d4e5f67890';
  upsertEvents(db, [
    { id: 'u1', agent: 'claude', sessionId: 's1', ts: now, kind: 'user', textHash: hash, textLen: 45 },
    { id: 'u2', agent: 'claude', sessionId: 's2', ts: now + 1000, kind: 'user', textHash: hash, textLen: 45 },
    { id: 'u3', agent: 'claude', sessionId: 's3', ts: now + 2000, kind: 'user', textHash: hash, textLen: 45 },
  ]);

  const findings = detectRepeatedPrompts(db);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'repeated_prompt');
  assert.equal(findings[0].evidence.sessionCount, 3);
  assert.ok(findings[0].estTokensWeek >= 6000);
});
