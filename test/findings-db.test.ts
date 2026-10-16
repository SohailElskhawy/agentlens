import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb,
  upsertProject,
  upsertFindings,
  getFindings,
  upsertRecommendations,
  getRecommendations,
  updateRecommendationStatus,
} from '../src/db.ts';
import type { Finding, Recommendation } from '../src/types.ts';

test('upsertFindings and getFindings persist and filter findings', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/work/repo', 'repo');

  const f1: Finding = {
    id: 'f1',
    rule: 'retry_loop',
    projectId: projId,
    sessionId: 's1',
    evidence: { tool: 'Bash', count: 4, argsHash: 'abc123' },
    confidence: 'high',
    confidenceReason: '4 identical calls',
    estTokensWeek: 15_000,
    firstSeen: 1000,
    lastSeen: 2000,
  };

  const f2: Finding = {
    id: 'f2',
    rule: 'hot_files',
    projectId: null,
    sessionId: 's2',
    evidence: { file: 'package.json', reads: 5 },
    confidence: 'medium',
    confidenceReason: '5 reads across turns',
    estTokensWeek: 8_000,
    firstSeen: 3000,
    lastSeen: 4000,
  };

  upsertFindings(db, [f1, f2]);

  // Retrieve all
  const all = getFindings(db);
  assert.equal(all.length, 2);
  assert.equal(all[0].id, 'f1');
  assert.deepEqual(all[0].evidence, { tool: 'Bash', count: 4, argsHash: 'abc123' });

  // Filter by project
  const projFindings = getFindings(db, { projectId: projId });
  assert.equal(projFindings.length, 1);
  assert.equal(projFindings[0].id, 'f1');

  // Filter by rule
  const hotFindings = getFindings(db, { rule: 'hot_files' });
  assert.equal(hotFindings.length, 1);
  assert.equal(hotFindings[0].id, 'f2');

  // Upsert conflict updates lastSeen and preserves/maximizes estTokensWeek
  const f1Updated: Finding = {
    ...f1,
    estTokensWeek: 20_000,
    lastSeen: 5000,
  };
  upsertFindings(db, [f1Updated]);

  const afterUpdate = getFindings(db, { rule: 'retry_loop' });
  assert.equal(afterUpdate.length, 1);
  assert.equal(afterUpdate[0].estTokensWeek, 20_000);
  assert.equal(afterUpdate[0].lastSeen, 5000);
});

test('upsertRecommendations, getRecommendations, and updateRecommendationStatus manage recommendation lifecycle', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/work/repo', 'repo');

  const rec: Recommendation = {
    id: 'r1',
    findingRule: 'retry_loop',
    projectId: projId,
    action: 'improve',
    title: 'Consolidate Bash retries',
    body: 'Add bash verification script in tools/check.sh',
    actionSnippet: 'bash tools/check.sh',
    status: 'open',
  };

  upsertRecommendations(db, [rec]);

  const list = getRecommendations(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'r1');
  assert.equal(list[0].actionSnippet, 'bash tools/check.sh');
  assert.equal(list[0].status, 'open');

  // Update status to accepted
  const updated = updateRecommendationStatus(db, 'r1', 'accepted');
  assert.equal(updated, true);

  const afterAccept = getRecommendations(db);
  assert.equal(afterAccept[0].status, 'accepted');
  assert.ok(afterAccept[0].acceptedAt != null && afterAccept[0].acceptedAt > 0);

  // Updating non-existent recommendation returns false
  assert.equal(updateRecommendationStatus(db, 'unknown-id', 'dismissed'), false);

  // Re-upserting does NOT overwrite user accepted status
  upsertRecommendations(db, [{ ...rec, title: 'Updated title' }]);
  const afterReUpsert = getRecommendations(db);
  assert.equal(afterReUpsert[0].title, 'Updated title');
  assert.equal(afterReUpsert[0].status, 'accepted');
});
