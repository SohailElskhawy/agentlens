import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDb, insertQuotas, upsertProject, upsertSessions } from '../src/db.ts';
import { computeQuotaForecasts } from '../src/quota-forecast.ts';
import { detectQuotaPressure } from '../src/analyze/quota_pressure.ts';
import { formatStatusline, writeSummary } from '../src/summary.ts';
import { tmp } from './helpers.ts';

test('computeQuotaForecasts projects exhaustion before reset when burn rate is steep', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  const resetTime = now + 2 * 3600_000; // Resets in 2 hours

  // Sample 1: 20 minutes ago, 50% used
  // Sample 2: right now, 75% used (burned 25% in 20 mins -> 75%/hr)
  // Remaining 25% will burn in 20 minutes -> exhaustion in 20 mins (well before reset in 120 mins)
  insertQuotas(db, [
    {
      agent: 'claude',
      window: '5h',
      ts: now - 20 * 60_000,
      usedPct: 50.0,
      resetsAt: resetTime,
      source: 'test',
    },
    {
      agent: 'claude',
      window: '5h',
      ts: now,
      usedPct: 75.0,
      resetsAt: resetTime,
      source: 'test',
    },
  ]);

  const forecasts = computeQuotaForecasts(db);
  const fc = forecasts.find((f) => f.agent === 'claude' && f.window === '5h');

  assert.ok(fc, 'Should have forecast for claude 5h');
  assert.equal(fc.willExhaustBeforeReset, true);
  assert.ok(fc.burnRatePctPerHour >= 70 && fc.burnRatePctPerHour <= 80);
  assert.ok(fc.projectedExhaustionTs != null);
  assert.match(fc.message ?? '', /at this pace you hit the 5h limit at \d{2}:\d{2}/);
});

test('computeQuotaForecasts does not project exhaustion when burn rate will not breach before reset', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  const resetTime = now + 30 * 60_000; // Resets in 30 minutes

  // Grew 1% in 20 minutes (burn rate 3%/hr). Needs 89% more -> takes ~30 hours. Reset in 30 mins.
  insertQuotas(db, [
    {
      agent: 'claude',
      window: '5h',
      ts: now - 20 * 60_000,
      usedPct: 10.0,
      resetsAt: resetTime,
      source: 'test',
    },
    {
      agent: 'claude',
      window: '5h',
      ts: now,
      usedPct: 11.0,
      resetsAt: resetTime,
      source: 'test',
    },
  ]);

  const forecasts = computeQuotaForecasts(db);
  const fc = forecasts.find((f) => f.agent === 'claude' && f.window === '5h');

  assert.ok(fc);
  assert.equal(fc.willExhaustBeforeReset, false);
});

test('detectQuotaPressure fires on projected exhaustion even when below 80% threshold', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  const resetTime = now + 90 * 60_000;

  // Currently at 60% (below 80% static threshold), but jumped from 30% to 60% in 15 mins (burn rate 120%/hr!)
  insertQuotas(db, [
    {
      agent: 'claude',
      window: '5h',
      ts: now - 15 * 60_000,
      usedPct: 30.0,
      resetsAt: resetTime,
      source: 'test',
    },
    {
      agent: 'claude',
      window: '5h',
      ts: now,
      usedPct: 60.0,
      resetsAt: resetTime,
      source: 'test',
    },
  ]);

  const findings = detectQuotaPressure(db);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'quota_pressure');
  assert.equal(findings[0].evidence.window, '5h');
  assert.match(findings[0].confidenceReason, /at this pace you hit the 5h limit at/);
});

test('writeSummary includes quota forecast and formatStatusline displays it in < 10ms', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');
  const now = Date.now();

  const projId = upsertProject(db, '/work/test-app', 'test-app');
  upsertSessions(db, [{ id: 's1', agent: 'claude', cwd: '/work/test-app', projectId: projId }]);

  insertQuotas(db, [
    {
      agent: 'claude',
      window: '5h',
      ts: now - 20 * 60_000,
      usedPct: 50.0,
      resetsAt: now + 120 * 60_000,
      source: 'test',
    },
    {
      agent: 'claude',
      window: '5h',
      ts: now,
      usedPct: 80.0,
      resetsAt: now + 120 * 60_000,
      source: 'test',
    },
  ]);

  writeSummary(db, summaryPath);

  const start = performance.now();
  const line = formatStatusline(summaryPath, '/work/test-app');
  const elapsed = performance.now() - start;

  assert.ok(elapsed < 10, `Statusline took ${elapsed}ms (expected < 10ms)`);
  assert.match(line, /test-app/);
  assert.match(line, /at this pace you hit the 5h limit at \d{2}:\d{2}/);
});
