import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, insertQuotas, upsertFindings } from '../src/db.ts';
import { detectCrossAgentBalance, formatResetTime } from '../src/analyze/cross_agent_balance.ts';
import { generateRecommendations } from '../src/recommend.ts';
import { generateFixPrompt } from '../src/fix-prompts.ts';
import type { QuotaSnapshot } from '../src/types.ts';

test('formatResetTime formats timestamp into day of week and HH:MM', () => {
  // 2026-10-15T09:00:00Z - let's check local formatting
  const d = new Date(2026, 9, 15, 9, 0); // October 15, 2026 09:00 local
  const formatted = formatResetTime(d.getTime());
  assert.equal(formatted, 'Thu 09:00');
});

test('detectCrossAgentBalance detects tight agent and recommends alternate with headroom', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  const resetTs = new Date(2026, 9, 15, 9, 0).getTime();

  // Claude 7d is tight at 85%; Codex 7d has headroom at 25%
  const quotas: QuotaSnapshot[] = [
    { agent: 'claude', ts: now, window: '7d', usedPct: 85, resetsAt: resetTs, source: 'statusline' },
    { agent: 'claude', ts: now, window: '5h', usedPct: 40, resetsAt: now + 7200_000, source: 'statusline' },
    { agent: 'codex', ts: now, window: '7d', usedPct: 25, resetsAt: resetTs + 86400_000, source: 'statusline' },
    { agent: 'codex', ts: now, window: '5h', usedPct: 20, resetsAt: now + 7200_000, source: 'statusline' },
  ];
  insertQuotas(db, quotas);

  const findings = detectCrossAgentBalance(db);
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.rule, 'cross_agent_balance');
  assert.equal(f.confidence, 'high');
  assert.equal(f.evidence.tightAgent, 'claude');
  assert.equal(f.evidence.altAgent, 'codex');
  assert.equal(f.evidence.window, '7d');
  assert.equal(f.evidence.tightUsedPct, 85);
  assert.equal(f.evidence.altUsedPct, 25);
  assert.equal(f.evidence.resetFormatted, 'Thu 09:00');
  assert.equal(f.evidence.suggestion, 'Use Codex for this project until Thu 09:00.');

  // Test recommendation generation
  const recs = generateRecommendations(findings);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].findingRule, 'cross_agent_balance');
  assert.equal(recs[0].action, 'replace');
  assert.ok(recs[0].title.includes('Use Codex'));
  assert.ok(recs[0].body.includes("Claude's 7d quota is tight"));
  assert.equal(recs[0].actionSnippet, 'codex');

  // Test prompt generation
  const prompt = generateFixPrompt({
    rule: f.rule,
    finding: f,
    projectName: 'my-project',
  });
  assert.ok(prompt.includes('Codex'));
  assert.ok(prompt.includes('Thu 09:00'));
});

test('detectCrossAgentBalance returns nothing when quotas are balanced or have headroom', () => {
  const db = openDb(':memory:');
  const now = Date.now();

  // Both agents well below threshold
  const quotas: QuotaSnapshot[] = [
    { agent: 'claude', ts: now, window: '7d', usedPct: 40, resetsAt: now + 86400_000, source: 'statusline' },
    { agent: 'codex', ts: now, window: '7d', usedPct: 35, resetsAt: now + 86400_000, source: 'statusline' },
  ];
  insertQuotas(db, quotas);

  const findings = detectCrossAgentBalance(db);
  assert.equal(findings.length, 0);
});
