import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, upsertEvents, upsertFindings, upsertProject, upsertRecommendations, upsertSessions } from '../src/db.ts';
import { drainQuotaSpool, formatStatusline, spoolQuota, writeSummary } from '../src/summary.ts';
import { tmp } from './helpers.ts';

test('spoolQuota parses Claude rate_limits and appends to spool file', () => {
  const dir = tmp();
  const spool = join(dir, 'claude-quota.jsonl');

  const claudePayload = JSON.stringify({
    rate_limits: {
      five_hour: {
        used_percentage: 42.5,
        resets_at: '2026-10-15T18:00:00.000Z',
      },
      seven_day: {
        used_percentage: 15.0,
        resets_at: '2026-10-22T10:00:00.000Z',
      },
    },
  });

  spoolQuota(spool, claudePayload);
  assert.ok(existsSync(spool));

  const content = readFileSync(spool, 'utf8').trim().split('\n');
  assert.equal(content.length, 2);
  const q1 = JSON.parse(content[0]);
  assert.equal(q1.agent, 'claude');
  assert.equal(q1.window, '5h');
  assert.equal(q1.usedPct, 42.5);

  const q2 = JSON.parse(content[1]);
  assert.equal(q2.agent, 'claude');
  assert.equal(q2.window, '7d');
  assert.equal(q2.usedPct, 15.0);
});

test('drainQuotaSpool imports records into db and clears spool', () => {
  const dir = tmp();
  const spool = join(dir, 'claude-quota.jsonl');
  const db = openDb(':memory:');

  const q = {
    agent: 'claude',
    ts: 1000,
    window: '5h',
    usedPct: 75.0,
    resetsAt: 5000,
    source: 'claude-statusline',
  };
  writeFileSync(spool, JSON.stringify(q) + '\n');

  drainQuotaSpool(db, spool);
  const rows = db.prepare('SELECT agent, win, used_pct FROM quota_snapshots').all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent, 'claude');
  assert.equal(rows[0].win, '5h');
  assert.equal(rows[0].used_pct, 75.0);

  // Spool should now be empty or non-existent
  assert.ok(!existsSync(spool) || readFileSync(spool, 'utf8').trim() === '');
});

test('drainQuotaSpool atomically stages spool file so concurrent writes are preserved', () => {
  const dir = tmp();
  const spool = join(dir, 'claude-quota.jsonl');
  const db = openDb(':memory:');

  const q1 = { agent: 'claude', ts: 1000, window: '5h', usedPct: 10.0, resetsAt: 5000, source: 'claude-statusline' };
  writeFileSync(spool, JSON.stringify(q1) + '\n');

  // Drain first batch
  drainQuotaSpool(db, spool);

  // Simulate concurrent write arriving immediately after drain starts/finishes
  const q2 = { agent: 'claude', ts: 2000, window: '5h', usedPct: 20.0, resetsAt: 6000, source: 'claude-statusline' };
  writeFileSync(spool, JSON.stringify(q2) + '\n');

  // Drain second batch
  drainQuotaSpool(db, spool);

  const rows = db.prepare('SELECT used_pct FROM quota_snapshots ORDER BY ts').all() as any[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].used_pct, 10.0);
  assert.equal(rows[1].used_pct, 20.0);
});

test('writeSummary writes summary.json and formatStatusline formats output in < 10ms', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');

  const projId = upsertProject(db, '/work/my-app', 'my-app');
  upsertSessions(db, [{ id: 's1', agent: 'claude', cwd: '/work/my-app', projectId: projId }]);

  // Add event today
  upsertEvents(db, [
    {
      id: 'e1',
      agent: 'claude',
      sessionId: 's1',
      ts: Date.now(),
      kind: 'assistant',
      input: 1000,
      output: 500,
      cacheRead: 2000,
      cacheWrite: 0,
    },
  ]);

  // Insert quota
  const spool = join(dir, 'claude-quota.jsonl');
  spoolQuota(
    spool,
    JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 33.3, resets_at: Date.now() + 3600_000 },
        seven_day: { used_percentage: 12.0, resets_at: Date.now() + 86400_000 },
      },
    }),
  );
  drainQuotaSpool(db, spool);

  writeSummary(db, summaryPath);
  assert.ok(existsSync(summaryPath));

  const start = performance.now();
  const statusline = formatStatusline(summaryPath, '/work/my-app');
  const elapsed = performance.now() - start;

  assert.ok(elapsed < 10, `Statusline took ${elapsed}ms (expected < 10ms)`);
  assert.match(statusline, /my-app/);
  assert.match(statusline, /3\.5k|3500/);
  assert.match(statusline, /5h 33%/);
  assert.match(statusline, /7d 12%/);
});

test('writeSummary includes costToday, burnRateTokensPerHour, activeSessions, and topRecommendation', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');
  const now = Date.now();

  const projId = upsertProject(db, '/work/alpha', 'alpha');
  upsertSessions(db, [{ id: 's-live', agent: 'claude', cwd: '/work/alpha', projectId: projId }]);
  upsertEvents(db, [
    {
      id: 'ev-1',
      agent: 'claude',
      sessionId: 's-live',
      ts: now - 5 * 60_000,
      kind: 'assistant',
      model: 'claude-sonnet-4-6',
      input: 10_000,
      output: 2_000,
      cacheRead: 0,
      cacheWrite: 0,
    },
  ]);

  upsertFindings(db, [
    {
      id: 'f-1',
      rule: 'hot_files',
      projectId: projId,
      sessionId: 's-live',
      evidence: { file: 'src/db.ts' },
      confidence: 'high',
      confidenceReason: 'Read 9 times',
      estTokensWeek: 45000,
      firstSeen: now,
      lastSeen: now,
    },
  ]);
  upsertRecommendations(db, [
    {
      id: 'rec-1',
      findingRule: 'hot_files',
      projectId: projId,
      action: 'improve',
      title: 'Hot file re-read: src/db.ts',
      body: 'Document src/db.ts exports in CLAUDE.md',
      status: 'open',
      score: 95,
    },
  ]);

  writeSummary(db, summaryPath);
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));

  assert.equal(data.totals.tokensToday, 12_000);
  assert.ok(Math.abs(data.totals.costToday - 0.06) < 1e-6);
  assert.equal(data.totals.burnRateTokensPerHour, 12_000);
  assert.equal(data.totals.activeSessions, 1);
  assert.ok(data.topRecommendation);
  assert.equal(data.topRecommendation.id, 'rec-1');
  assert.equal(data.topRecommendation.rule, 'hot_files');
  assert.equal(data.topRecommendation.severity, 'high');
  assert.equal(data.topRecommendation.action, 'Document src/db.ts exports in CLAUDE.md');
  assert.equal(data.topRecommendation.projectName, 'alpha');
  assert.equal(data.topRecommendation.estTokensSavedWeek, 45000);
  assert.match(data.topRecommendation.prompt, /src\/db\.ts/);
});

test('writeSummary populates topRecommendation with estTokensSavedWeek 0 when no matching finding row exists', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');

  const projId = upsertProject(db, '/work/beta', 'beta');
  upsertRecommendations(db, [
    {
      id: 'rec-orphan',
      findingRule: 'context_growth',
      projectId: projId,
      action: 'improve',
      title: 'Uncompacted context growth',
      body: 'Run /compact after milestones',
      status: 'open',
      score: 65,
    },
  ]);

  writeSummary(db, summaryPath);
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));

  assert.ok(data.topRecommendation);
  assert.equal(data.topRecommendation.id, 'rec-orphan');
  assert.equal(data.topRecommendation.rule, 'context_growth');
  assert.equal(data.topRecommendation.severity, 'medium');
  assert.equal(data.topRecommendation.projectName, 'beta');
  assert.equal(data.topRecommendation.estTokensSavedWeek, 0);
  assert.match(data.topRecommendation.prompt, /\/compact/);
});

