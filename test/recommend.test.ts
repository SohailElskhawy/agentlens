import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Finding } from '../src/types.ts';
import { generateRecommendations } from '../src/recommend.ts';

test('generateRecommendations creates prioritized recommendations from findings', () => {
  const findings: Finding[] = [
    {
      id: 'f_retry',
      rule: 'retry_loop',
      projectId: 1,
      sessionId: 's1',
      evidence: { tool: 'Bash', count: 4 },
      confidence: 'high',
      confidenceReason: '4 identical calls',
      estTokensWeek: 10_000,
      firstSeen: 1000,
      lastSeen: 2000,
    },
    {
      id: 'f_growth',
      rule: 'context_growth',
      projectId: 1,
      sessionId: 's2',
      evidence: { peakTokens: 180_000, turnCount: 20 },
      confidence: 'high',
      confidenceReason: 'Peak 180k tokens',
      estTokensWeek: 150_000,
      firstSeen: 1000,
      lastSeen: 2000,
    },
    {
      id: 'f_prompt',
      rule: 'repeated_prompt',
      projectId: null,
      sessionId: 's3',
      evidence: { sessionCount: 3 },
      confidence: 'medium',
      confidenceReason: 'Repeated 3 times',
      estTokensWeek: 6000,
      firstSeen: 1000,
      lastSeen: 2000,
    },
  ];

  const recs = generateRecommendations(findings);
  assert.equal(recs.length, 3);

  // Highest score should be first: context_growth (150k * 1.0 = 150k)
  assert.equal(recs[0].findingRule, 'context_growth');
  assert.equal(recs[0].score, 150_000);
  assert.equal(recs[0].action, 'improve');
  assert.match(recs[0].title, /compaction|reset/i);

  // Second: retry_loop (10k * 1.0 = 10k)
  assert.equal(recs[1].findingRule, 'retry_loop');
  assert.equal(recs[1].score, 10_000);

  // Third: repeated_prompt (6k * 0.6 = 3600)
  assert.equal(recs[2].findingRule, 'repeated_prompt');
  assert.equal(recs[2].score, 3600);
  assert.equal(recs[2].action, 'add');
});
