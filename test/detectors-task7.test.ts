import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb, upsertProject, upsertSessions, upsertEvents } from '../src/db.ts';
import { detectOutcomeEfficiency } from '../src/analyze/outcome_efficiency.ts';
import { detectAbandonedSessions } from '../src/analyze/abandoned_session.ts';
import { detectCompactionChurn } from '../src/analyze/compaction_churn.ts';
import { detectReasoningOveruse } from '../src/analyze/reasoning_overuse.ts';
import { generateRecommendations } from '../src/recommend.ts';
import { generateFixPrompt } from '../src/fix-prompts.ts';
import { startServer } from '../src/server.ts';
import type { NormalizedEvent, SessionInfo } from '../src/types.ts';

test('detectOutcomeEfficiency flags projects with high tokens per commit or line', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/work/slow-repo', 'slow-repo');
  const now = Date.now();

  const sessions: (SessionInfo & { projectId: number | null })[] = [
    { id: 's_slow_1', agent: 'claude', projectId: projId, cwd: '/work/slow-repo' },
  ];
  const events: NormalizedEvent[] = [
    {
      id: 'e1',
      agent: 'claude',
      sessionId: 's_slow_1',
      ts: now,
      kind: 'assistant',
      model: 'claude-3-5-sonnet-20241022',
      input: 100_000,
      output: 60_000,
      cacheRead: 0,
      cacheWrite: 0,
    },
  ];
  upsertSessions(db, sessions);
  upsertEvents(db, events);

  // Simulated git commit stats: 1 commit with 20 lines added/deleted
  const mockGitReader = () => [
    { hash: 'abc1234', ts: now + 5000, added: 15, deleted: 5 },
  ];

  const findings = detectOutcomeEfficiency(db, { projectId: projId, gitReader: mockGitReader });
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.rule, 'outcome_efficiency');
  assert.equal(f.evidence.tokensPerCommit, 160_000);
  assert.equal(f.evidence.tokensPerChangedLine, 8000);

  // Recommendations and prompt
  const recs = generateRecommendations(findings);
  assert.equal(recs.length, 1);
  assert.ok(recs[0].title.includes('outcome efficiency'));
  const prompt = generateFixPrompt({ rule: f.rule, finding: f });
  assert.ok(prompt.includes('Token expenditure per commit is elevated'));
});

test('detectAbandonedSessions detects high-token sessions without edits or commits', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/work/abandoned-repo', 'abandoned-repo');
  const now = Date.now();

  const sessions: (SessionInfo & { projectId: number | null })[] = [
    { id: 's_abandoned', agent: 'claude', projectId: projId, cwd: '/work/abandoned-repo' },
    { id: 's_productive', agent: 'claude', projectId: projId, cwd: '/work/abandoned-repo' },
  ];
  const events: NormalizedEvent[] = [
    // Abandoned session: 70k tokens, tool call is only ReadFile (no file editing)
    { id: 'ea1', agent: 'claude', sessionId: 's_abandoned', ts: now, kind: 'assistant', model: 'claude-3-5-sonnet-20241022', input: 50_000, output: 20_000, cacheRead: 0, cacheWrite: 0 },
    { id: 'ea2', agent: 'claude', sessionId: 's_abandoned', ts: now + 1000, kind: 'tool_call', model: 'claude-3-5-sonnet-20241022', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tool: 'ReadFile' },

    // Productive session: 70k tokens, but tool call is Edit
    { id: 'ep1', agent: 'claude', sessionId: 's_productive', ts: now, kind: 'assistant', model: 'claude-3-5-sonnet-20241022', input: 50_000, output: 20_000, cacheRead: 0, cacheWrite: 0 },
    { id: 'ep2', agent: 'claude', sessionId: 's_productive', ts: now + 1000, kind: 'tool_call', model: 'claude-3-5-sonnet-20241022', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tool: 'replace_file_content' },
  ];
  upsertSessions(db, sessions);
  upsertEvents(db, events);

  // Mock git reader returning no commits
  const mockGitReader = () => [];

  const findings = detectAbandonedSessions(db, { gitReader: mockGitReader });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sessionId, 's_abandoned');
  assert.equal(findings[0].rule, 'abandoned_session');

  // Recommendation & prompt
  const recs = generateRecommendations(findings);
  assert.equal(recs.length, 1);
  assert.ok(recs[0].title.includes('abandoned sessions'));
  const prompt = generateFixPrompt({ rule: findings[0].rule, finding: findings[0] });
  assert.ok(prompt.includes('A high-token session concluded without file edits or git commits'));
});

test('detectCompactionChurn catches multiple context drops in single session', () => {
  const db = openDb(':memory:');
  const now = Date.now();

  const sessions: (SessionInfo & { projectId: number | null })[] = [
    { id: 's_churn', agent: 'claude', projectId: null, cwd: '/work' },
  ];
  // 5 assistant turns: drops occur between 1->2, 2->3, 3->4
  const events: NormalizedEvent[] = [
    { id: 'ec1', agent: 'claude', sessionId: 's_churn', ts: now, kind: 'assistant', model: 'claude-3-5-sonnet-20241022', input: 80_000, output: 2_000, cacheRead: 0, cacheWrite: 0 },
    { id: 'ec2', agent: 'claude', sessionId: 's_churn', ts: now + 1000, kind: 'assistant', model: 'claude-3-5-sonnet-20241022', input: 15_000, output: 2_000, cacheRead: 0, cacheWrite: 0 },
    { id: 'ec3', agent: 'claude', sessionId: 's_churn', ts: now + 2000, kind: 'assistant', model: 'claude-3-5-sonnet-20241022', input: 70_000, output: 2_000, cacheRead: 0, cacheWrite: 0 },
    { id: 'ec4', agent: 'claude', sessionId: 's_churn', ts: now + 3000, kind: 'assistant', model: 'claude-3-5-sonnet-20241022', input: 12_000, output: 2_000, cacheRead: 0, cacheWrite: 0 },
    { id: 'ec5', agent: 'claude', sessionId: 's_churn', ts: now + 4000, kind: 'assistant', model: 'claude-3-5-sonnet-20241022', input: 60_000, output: 2_000, cacheRead: 0, cacheWrite: 0 },
    { id: 'ec6', agent: 'claude', sessionId: 's_churn', ts: now + 5000, kind: 'assistant', model: 'claude-3-5-sonnet-20241022', input: 10_000, output: 2_000, cacheRead: 0, cacheWrite: 0 },
  ];
  upsertSessions(db, sessions);
  upsertEvents(db, events);

  const findings = detectCompactionChurn(db);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'compaction_churn');
  assert.equal(findings[0].evidence.compactions, 3);

  const recs = generateRecommendations(findings);
  assert.equal(recs.length, 1);
  assert.ok(recs[0].title.includes('compaction churn'));
});

test('detectReasoningOveruse flags turns with disproportionate thinking tokens', () => {
  const db = openDb(':memory:');
  const now = Date.now();

  const sessions: (SessionInfo & { projectId: number | null })[] = [
    { id: 's_reason', agent: 'claude', projectId: null, cwd: '/work' },
  ];
  // 1 turn: 10,000 reasoning tokens, only 200 output tokens (50x ratio)
  const events: NormalizedEvent[] = [
    {
      id: 'er1',
      agent: 'claude',
      sessionId: 's_reason',
      ts: now,
      kind: 'assistant',
      model: 'claude-3-7-sonnet-20250219',
      input: 5_000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 10_000,
    },
  ];
  upsertSessions(db, sessions);
  upsertEvents(db, events);

  const findings = detectReasoningOveruse(db);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'reasoning_overuse');
  assert.equal(findings[0].evidence.totalReasoningTokens, 10_000);
  assert.equal(findings[0].evidence.totalOutputTokens, 200);
  assert.equal(findings[0].evidence.ratio, 50);

  const recs = generateRecommendations(findings);
  assert.equal(recs.length, 1);
  assert.ok(recs[0].title.includes('reasoning effort'));
});

test('GET /api/outcomes returns outcome efficiency metrics per project', async () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/work/test-outcome', 'test-outcome');
  const now = Date.now();

  const sessions: (SessionInfo & { projectId: number | null })[] = [
    { id: 's_api_outcome', agent: 'claude', projectId: projId, cwd: '/work/test-outcome' },
  ];
  const events: NormalizedEvent[] = [
    { id: 'eo1', agent: 'claude', sessionId: 's_api_outcome', ts: now, kind: 'assistant', model: 'claude-3-5-sonnet-20241022', input: 30_000, output: 10_000, cacheRead: 0, cacheWrite: 0 },
  ];
  upsertSessions(db, sessions);
  upsertEvents(db, events);

  const server = await startServer(db, 0, '127.0.0.1');
  const port = (server.address() as AddressInfo).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/outcomes`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 1);
    assert.equal(data[0].projectId, projId);
    assert.equal(data[0].name, 'test-outcome');
    assert.equal(data[0].tokens, 40_000);
  } finally {
    await server.close();
  }
});
