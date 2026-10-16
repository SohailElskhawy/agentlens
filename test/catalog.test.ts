import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCuratedCatalog, findCatalogItemsForRule, isValidCatalogItem, _setCatalogCacheForTesting } from '../src/catalog.ts';
import { generateRecommendations } from '../src/recommend.ts';
import type { Finding } from '../src/types.ts';

test('getCuratedCatalog loads vetted tools covering key waste rules', () => {
  const catalog = getCuratedCatalog();
  assert.ok(catalog.length >= 8, `Expected at least 8 catalog entries, got ${catalog.length}`);

  const rulesCovered = new Set(catalog.flatMap((item) => item.targetRules));
  assert.ok(rulesCovered.has('hot_files'), 'Should cover hot_files');
  assert.ok(rulesCovered.has('retry_loop'), 'Should cover retry_loop');
  assert.ok(rulesCovered.has('context_growth'), 'Should cover context_growth');
  assert.ok(rulesCovered.has('instruction_bloat'), 'Should cover instruction_bloat');

  for (const item of catalog) {
    assert.ok(item.id.length > 0, 'Item must have id');
    assert.ok(item.name.length > 0, 'Item must have name');
    assert.ok(['mcp', 'skill', 'plugin', 'tool'].includes(item.kind), `Invalid kind: ${item.kind}`);
    assert.ok(item.url.startsWith('https://'), `Invalid url: ${item.url}`);
    assert.ok(item.estSavingsPct > 0 && item.estSavingsPct <= 100, `Invalid estSavingsPct: ${item.estSavingsPct}`);
    assert.equal(typeof item.safeToSuggest, 'boolean');
  }
});

test('findCatalogItemsForRule returns matching tools for waste pattern', () => {
  const hotFileTools = findCatalogItemsForRule('hot_files');
  assert.ok(hotFileTools.length > 0);
  assert.ok(hotFileTools.some((t) => t.id === 'serena' || t.id === 'repomix'));

  const retryTools = findCatalogItemsForRule('retry_loop');
  assert.ok(retryTools.length > 0);
  assert.ok(retryTools.some((t) => t.id === 'context7' || t.id === 'agent-audit'));

  const unknown = findCatalogItemsForRule('non_existent_rule');
  assert.deepEqual(unknown, []);
});

test('findCatalogItemsForRule handles catalog items with missing targetRules gracefully without throwing', () => {
  try {
    _setCatalogCacheForTesting([
      {
        id: 'broken',
        name: 'Broken Item',
        kind: 'tool',
        description: 'No target rules',
        url: 'https://example.com',
        targetRules: undefined as any,
        estSavingsPct: 10,
        recommendedAction: 'add',
        installCommand: '',
        safeToSuggest: true,
      },
    ]);
    const matches = findCatalogItemsForRule('hot_files');
    assert.deepEqual(matches, []);
  } finally {
    _setCatalogCacheForTesting(null);
  }
});

test('isValidCatalogItem validates items strictly', () => {
  assert.equal(isValidCatalogItem(null), false);
  assert.equal(isValidCatalogItem(''), false);
  assert.equal(isValidCatalogItem({ id: 'bad' }), false);
  assert.equal(
    isValidCatalogItem({
      id: 'tool1',
      name: 'Tool One',
      kind: 'tool',
      description: 'Desc',
      url: 'https://github.com/org/repo',
      targetRules: ['hot_files'],
      estSavingsPct: 20,
      recommendedAction: 'add',
      installCommand: 'npm i',
      safeToSuggest: true,
    }),
    true
  );
  assert.equal(
    isValidCatalogItem({
      id: 'tool1',
      name: 'Tool One',
      kind: 'invalid-kind',
      description: 'Desc',
      url: 'https://github.com/org/repo',
      targetRules: ['hot_files'],
      estSavingsPct: 20,
      recommendedAction: 'add',
      installCommand: 'npm i',
      safeToSuggest: true,
    }),
    false
  );
});

test('generateRecommendations enriches recommendations with catalogRef', () => {
  const finding: Finding = {
    id: 'f_test_cat_1',
    rule: 'hot_files',
    projectId: 1,
    sessionId: null,
    evidence: { reads: 5, path: 'src/heavy.ts' },
    confidence: 'high',
    confidenceReason: 'Repeated file reads',
    estTokensWeek: 45_000,
    firstSeen: 1_700_000_000_000,
    lastSeen: 1_700_000_000_000,
  };

  const recs = generateRecommendations([finding]);
  assert.equal(recs.length, 1);
  assert.ok(recs[0].catalogRef != null, 'Should assign catalogRef');
  assert.ok(['serena', 'repomix'].includes(recs[0].catalogRef!), `Unexpected catalogRef: ${recs[0].catalogRef}`);
});
