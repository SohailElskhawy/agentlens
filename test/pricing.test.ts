import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, costOf, PRICES_AS_OF } from '../src/pricing.ts';

const M = { 'claude-x': { input: 1e-6, output: 2e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6, cacheWrite1h: 2e-6 } };

test('priceFor falls back from provider prefix and date suffix', () => {
  assert.equal(priceFor('claude-x', M), M['claude-x']);
  assert.equal(priceFor('anthropic/claude-x', M), M['claude-x']);
  assert.equal(priceFor('claude-x-20251001', M), M['claude-x']);
  assert.equal(priceFor('nope', M), undefined);
  assert.equal(priceFor(undefined, M), undefined);
});

test('costOf prices 5-minute and 1-hour cache writes separately', () => {
  const c = costOf('claude-x', { input: 1000, output: 100, cacheRead: 10000, cacheWrite: 400, cacheWrite1h: 300 }, M);
  // 1000*1e-6 + 100*2e-6 + 10000*1e-7 + 100*1.25e-6 + 300*2e-6
  assert.ok(Math.abs(c! - 0.002925) < 1e-12);
});

test('costOf returns null (not 0) for an unknown model', () => {
  assert.equal(costOf('codex-auto-review', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, M), null);
});

test('bundled snapshot covers the models this user runs', () => {
  assert.match(PRICES_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'gpt-6.1-sol', 'gpt-6-luna']) assert.ok(priceFor(m), m);
});
