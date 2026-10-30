import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb, upsertEvents } from '../src/db.ts';
import type { DB } from '../src/db.ts';
import type { Agent } from '../src/types.ts';
import { subscriptionComparison } from '../src/roi.ts';
import { startServer } from '../src/server.ts';
import { tmp } from './helpers.ts';

const now = Date.UTC(2026, 9, 30);
const day = 86400_000;
function event(db: DB, id: string, ts: number, model = 'claude-sonnet-4-5', agent: Agent = 'claude', input = 1_000_000) {
  upsertEvents(db, [{ id, sessionId: id, agent, ts, kind: 'assistant', model, input }]);
}

test('compares priced Claude usage over the exact half-open window', () => {
  const db = openDb(':memory:');
  try {
    event(db, 'start', now - 15 * day);
    event(db, 'inside', now - 1);
    event(db, 'before', now - 15 * day - 1);
    event(db, 'end', now);
    event(db, 'other', now - 1, 'claude-sonnet-4-5', 'codex');
    event(db, 'unknown', now - 1, 'unknown-model');
    const r = subscriptionComparison(db, { plan: 'max5x', days: 15, now });
    assert.equal(r.from, now - 15 * day); assert.equal(r.to, now);
    assert.equal(r.tokens, 3_000_000); assert.equal(r.unpricedTokens, 1_000_000);
    assert.equal(r.tokenCoverage, 2 / 3); assert.equal(r.estimatedApiCostUsd, 6);
    assert.equal(r.monthlyPlanPriceUsd, 100); assert.equal(r.periodPlanPriceUsd, 50);
    assert.equal(r.estimatedRatio, 0.12);
    assert.equal(r.tokenPricesAsOf, '2026-10-15'); assert.equal(r.planPricesAsOf, '2026-10-30');
  } finally { db.close(); }
});

test('empty and entirely unpriced usage do not produce an estimated ratio', () => {
  const db = openDb(':memory:');
  try {
    const empty = subscriptionComparison(db, { now });
    assert.equal(empty.plan, 'pro'); assert.equal(empty.days, 30);
    assert.equal(empty.tokenCoverage, null); assert.equal(empty.estimatedRatio, null);
    assert.equal(empty.estimatedApiCostUsd, 0); assert.equal(empty.periodPlanPriceUsd, 20);
    event(db, 'unknown', now - 1, 'unknown-model');
    const r = subscriptionComparison(db, { plan: 'max20x', now });
    assert.equal(r.tokenCoverage, 0); assert.equal(r.estimatedRatio, null);
    assert.equal(r.monthlyPlanPriceUsd, 200);
  } finally { db.close(); }
});

test('invalid options and unsupported Team fail before any query', () => {
  const db = openDb(':memory:');
  try {
    db.prepare = (() => { throw new Error('unexpected query'); }) as typeof db.prepare;
    for (const plan of ['team', 'invalid', '']) assert.throws(() => subscriptionComparison(db, { plan }), plan === 'team' ? /team.*unsupported/i : /plan/i);
    for (const days of [0, -1, 1.5, 366, NaN, Infinity]) assert.throws(() => subscriptionComparison(db, { days }), /days/i);
  } finally { db.close(); }
});

test('API returns comparison and rejects invalid arguments', async () => {
  const db = openDb(':memory:'); event(db, 'priced', Date.now() - 1000);
  const server = await startServer(db, 0);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/analytics/roi`;
    const response = await fetch(`${base}?plan=max20x&days=15`);
    assert.equal(response.status, 200);
    const r = await response.json() as any;
    assert.equal(r.estimatedApiCostUsd, 3); assert.equal(r.periodPlanPriceUsd, 100);
    assert.match(r.disclosure, /API-billed/i); assert.match(r.disclosure, /web chat/i);
    assert.match(r.disclosure, /other machines/i); assert.match(r.disclosure, /taxes/i);
    assert.match(r.disclosure, /annual and regional/i); assert.match(r.disclosure, /not an invoice/i);
    assert.match(r.disclosure, /credit benefits are excluded/i);
    for (const query of ['plan=team', 'plan=', 'days=', 'days=0', 'days=1.5', 'days=366', 'days=wat']) {
      const bad = await fetch(`${base}?${query}`); assert.equal(bad.status, 400, query);
      assert.ok((await bad.json() as any).error);
    }
  } finally { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); db.close(); }
});

test('CLI JSON and human output use isolated local data and disclose limits', () => {
  const dir = tmp();
  const env = { ...process.env, AGENTLENS_DATA_DIR: dir, AGENTLENS_STATE_DIR: dir, AGENTLENS_SOURCE_HOME: dir };
  try {
    const db = openDb(join(dir, 'agentlens.db')); event(db, 'priced', Date.now() - 1000); db.close();
    const run = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'roi', ...args], { env, encoding: 'utf8' });
    const json = run('--plan', 'max5x', '--days', '15', '--json');
    assert.equal(json.status, 0, json.stderr);
    const r = JSON.parse(json.stdout); assert.equal(r.estimatedApiCostUsd, 3); assert.equal(r.periodPlanPriceUsd, 50);
    assert.match(r.disclosure, /API-billed/i); assert.match(r.disclosure, /credit/i);
    const human = run(); assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /estimated API\/list-price comparison/i); assert.match(human.stdout, /API-billed/i);
    for (const args of [['--plan', 'team'], ['--days', '0'], ['--days', '1.5']]) assert.notEqual(run(...args).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(existsSync(dir), false);
  const emptyDir = tmp();
  try {
    const result = spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'roi', '--json'], { env: { ...process.env, AGENTLENS_DATA_DIR: emptyDir, AGENTLENS_STATE_DIR: emptyDir, AGENTLENS_SOURCE_HOME: emptyDir }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).estimatedRatio, null);
    assert.equal(existsSync(join(emptyDir, 'agentlens.db')), false);
  } finally { rmSync(emptyDir, { recursive: true, force: true }); }
});
