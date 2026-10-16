import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, upsertEvents, upsertProject, upsertSessions } from '../src/db.ts';
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

  // Spool should now be empty
  assert.equal(readFileSync(spool, 'utf8').trim(), '');
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
