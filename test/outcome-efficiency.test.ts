import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertProject, upsertSessions, upsertEvents } from '../src/db.ts';
import { outcomeEfficiency } from '../src/queries.ts';
import { detectOutcomeEfficiency } from '../src/analyze/outcome_efficiency.ts';
import { generateRecommendations } from '../src/recommend.ts';
import type { DB } from '../src/db.ts';
import type { Finding, NormalizedEvent, SessionInfo } from '../src/types.ts';

function seedTokens(db: DB, tokens: number, projId: number) {
  const now = Date.now();
  const sessions: (SessionInfo & { projectId: number | null })[] = [
    { id: 's_oef', agent: 'claude', projectId: projId, cwd: '/work/oef-repo' },
  ];
  const events: NormalizedEvent[] = [
    {
      id: 'e1',
      agent: 'claude',
      sessionId: 's_oef',
      ts: now,
      kind: 'assistant',
      model: 'claude-3-5-sonnet-20241022',
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  ];
  upsertSessions(db, sessions);
  upsertEvents(db, events);
  return now;
}

test('outcomeEfficiency returns null rates when the repo has no commits', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/work/oef-repo', 'oef-repo');
  seedTokens(db, 160_000, projId);

  const rows = outcomeEfficiency(db, {}, () => []);
  assert.equal(rows.length, 1);
  const o = rows[0];
  assert.equal(o.tokens, 160_000);
  assert.equal(o.commits, 0);
  assert.equal(o.tokensPerCommit, null);
  assert.equal(o.tokensPerChangedLine, null);
  assert.equal(o.byAgent[0].tokens, 160_000);
  assert.equal(o.byAgent[0].tokensPerCommit, null);
  assert.equal(o.byAgent[0].tokensPerChangedLine, null);
});

test('outcomeEfficiency keeps a valid per-commit rate and nulls the per-line rate for zero changed lines', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/work/oef-repo', 'oef-repo');
  const now = seedTokens(db, 160_000, projId);

  const rows = outcomeEfficiency(db, {}, () => [{ hash: 'a', ts: now + 5000, added: 0, deleted: 0 }]);
  const o = rows[0];
  assert.equal(o.commits, 1);
  assert.equal(o.linesChanged, 0);
  assert.equal(o.tokensPerCommit, 160_000);
  assert.equal(o.tokensPerChangedLine, null);
  assert.equal(o.byAgent[0].tokensPerCommit, 160_000);
  assert.equal(o.byAgent[0].tokensPerChangedLine, null);
});

test('outcomeEfficiency leaves positive rates unchanged', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/work/oef-repo', 'oef-repo');
  const now = seedTokens(db, 160_000, projId);

  const rows = outcomeEfficiency(db, {}, () => [{ hash: 'a', ts: now + 5000, added: 15, deleted: 5 }]);
  const o = rows[0];
  assert.equal(o.tokensPerCommit, 160_000);
  assert.equal(o.tokensPerChangedLine, 8_000);
  assert.equal(o.byAgent[0].tokensPerCommit, 160_000);
  assert.equal(o.byAgent[0].tokensPerChangedLine, 8_000);
});

test('detector does not flag an empty commit via an invented per-line rate', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/work/oef-repo', 'oef-repo');
  const now = seedTokens(db, 60_000, projId); // above the 50k spend floor, below the 150k per-commit threshold

  const findings = detectOutcomeEfficiency(db, {
    projectId: projId,
    gitReader: () => [{ hash: 'a', ts: now + 5000, added: 0, deleted: 0 }],
  });
  assert.equal(findings.length, 0);
});

test('detector still flags high tokens per commit with a null changed-line rate', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/work/oef-repo', 'oef-repo');
  const now = seedTokens(db, 160_000, projId);

  const findings = detectOutcomeEfficiency(db, {
    projectId: projId,
    gitReader: () => [{ hash: 'a', ts: now + 5000, added: 0, deleted: 0 }],
  });
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.evidence.tokensPerCommit, 160_000);
  assert.equal(f.evidence.tokensPerChangedLine, null);
  assert.equal(f.confidence, 'medium');
  assert.ok(!f.confidenceReason.includes('NaN'));
});

test('recommendation body does not invent a changed-line figure when unknown', () => {
  const finding: Finding = {
    id: 'outcome_efficiency:1',
    rule: 'outcome_efficiency',
    projectId: 1,
    sessionId: null,
    evidence: { tokensPerCommit: 160_000, tokensPerChangedLine: null },
    confidence: 'medium',
    confidenceReason: 'reason',
    estTokensWeek: 40_000,
    firstSeen: 0,
    lastSeen: 0,
  };
  const recs = generateRecommendations([finding]);
  assert.equal(recs.length, 1);
  assert.ok(recs[0].body.includes('160,000'));
  assert.ok(!recs[0].body.includes('many'));
  assert.ok(!recs[0].body.includes('null'));
});
