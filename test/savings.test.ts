import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, upsertEvents, upsertProject, upsertSessions } from '../src/db.ts';
import type { DB } from '../src/db.ts';
import { getSavings, snapshotSavings } from '../src/savings.ts';
import { tmp } from './helpers.ts';

const now = new Date(2026, 9, 27, 12).getTime();
const monday = new Date(2026, 9, 19).getTime();

function seed(db: DB, projectId: number, id: string, ts: number, input = 100, output = 200, cacheRead = 600, cacheWrite = 100) {
  upsertSessions(db, [{ id, agent: 'claude', projectId }]);
  upsertEvents(db, [
    { id: `${id}-user`, agent: 'claude', sessionId: id, ts, kind: 'user' },
    { id: `${id}-assistant`, agent: 'claude', sessionId: id, ts, kind: 'assistant', input, output, cacheRead, cacheWrite, cacheWrite1h: cacheWrite, reasoning: output },
  ]);
}

test('savings normalises weekly totals and compares projects independently', () => {
  const db = openDb(':memory:');
  try {
    const projectId = upsertProject(db, '/work/app', 'app');
    const other = upsertProject(db, '/work/other', 'other');
    seed(db, projectId, 'before1', monday);
    seed(db, projectId, 'before2', monday + 1000);
    // More assistant responses are not more user turns; non-assistant usage is ignored.
    upsertEvents(db, [
      { id: 'extra', agent: 'claude', sessionId: 'before1', ts: monday + 2000, kind: 'assistant', input: 200, output: 400, cacheRead: 1200, cacheWrite: 200 },
      { id: 'tool', agent: 'claude', sessionId: 'before1', ts: monday, kind: 'tool_result', input: 99999 },
    ]);
    seed(db, projectId, 'latest', new Date(2026, 9, 26).getTime(), 100, 100, 200, 100);
    seed(db, other, 'other', monday, 9000);

    const result = getSavings(db, { projectId, weeks: 2, now });
    assert.equal(result.weeks, 2);
    assert.equal(result.projects.length, 1);
    const report = result.projects[0];
    assert.equal(report.projectId, projectId);
    assert.equal(report.baselineSource, 'week');
    assert.equal(report.weekly.length, 2);
    assert.deepEqual(report.baseline, {
      weekStart: monday, complete: true, sessions: 2,
      tokensPerSession: 2000, tokensPerTurn: 2000,
      nonCacheInputShare: 0.25, cacheReadRatio: 0.75,
    });
    assert.deepEqual(report.latest, {
      weekStart: new Date(2026, 9, 26).getTime(), complete: false, sessions: 1,
      tokensPerSession: 500, tokensPerTurn: 500,
      nonCacheInputShare: 0.5, cacheReadRatio: 0.5,
    });
    assert.deepEqual(report.changePct, {
      sessions: -50, tokensPerSession: -75, tokensPerTurn: -75,
      nonCacheInputShare: 100, cacheReadRatio: -33.33,
    });
  } finally { db.close(); }
});

test('savings handles empty data, one complete week, and an incomplete week without inventing a baseline', () => {
  const db = openDb(':memory:');
  try {
    assert.deepEqual(getSavings(db, { now }), { weeks: 8, projects: [] });
    const projectId = upsertProject(db, '/work/app', 'app');
    let report = getSavings(db, { now }).projects[0];
    assert.deepEqual(report.weekly, []);
    assert.equal(report.baseline, null);
    assert.equal(report.latest, null);
    assert.equal(report.changePct, null);

    seed(db, projectId, 'only', monday);
    report = getSavings(db, { now }).projects[0];
    assert.deepEqual(report.baseline, report.latest);
    assert.deepEqual(report.changePct, {
      sessions: 0, tokensPerSession: 0, tokensPerTurn: 0,
      nonCacheInputShare: 0, cacheReadRatio: 0,
    });
    seed(db, projectId, 'current', new Date(2026, 9, 26).getTime());
    report = getSavings(db, { weeks: 1, now }).projects[0];
    assert.equal(report.baseline, null);
    assert.equal(report.latest?.sessions, 1);
    assert.equal(report.changePct, null);
  } finally { db.close(); }
});

test('savings leaves undefined ratios and zero-baseline percentage changes null', () => {
  const db = openDb(':memory:');
  try {
    const projectId = upsertProject(db, '/work/app', 'app');
    upsertSessions(db, [{ id: 'zero', agent: 'claude', projectId }]);
    upsertEvents(db, [{ id: 'zero', agent: 'claude', sessionId: 'zero', ts: monday, kind: 'assistant' }]);
    seed(db, projectId, 'current', new Date(2026, 9, 26).getTime());
    const report = getSavings(db, { now }).projects[0];
    assert.equal(report.baseline?.tokensPerSession, 0);
    assert.equal(report.baseline?.tokensPerTurn, null);
    assert.equal(report.baseline?.nonCacheInputShare, null);
    assert.equal(report.baseline?.cacheReadRatio, null);
    assert.deepEqual(report.changePct, {
      sessions: 0, tokensPerSession: null, tokensPerTurn: null,
      nonCacheInputShare: null, cacheReadRatio: null,
    });
  } finally { db.close(); }
});

test('savings snapshots preserve the earliest stored baseline even outside the requested range', () => {
  const db = openDb(':memory:');
  try {
    const projectId = upsertProject(db, '/work/app', 'app');
    seed(db, projectId, 'first', monday);
    // Reporting works on an existing DB without migrating or creating a ledger.
    db.exec('PRAGMA query_only = ON');
    const original = getSavings(db, { projectId, now }).projects[0].latest;
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'savings_baselines'").get(), undefined);
    db.exec('PRAGMA query_only = OFF');

    snapshotSavings(db, { projectId, now });
    seed(db, projectId, 'late-ingest', monday + 1000, 10000);
    seed(db, projectId, 'next', new Date(2026, 9, 26).getTime(), 10, 10, 60, 20);
    snapshotSavings(db, { projectId, now: now + 1000 });

    db.exec('PRAGMA query_only = ON');
    const report = getSavings(db, { projectId, weeks: 1, now }).projects[0];
    assert.equal(report.baselineSource, 'snapshot');
    assert.deepEqual(report.baseline, original);
    assert.equal(report.latest?.tokensPerSession, 100);
    assert.equal(report.changePct?.tokensPerSession, -90);
    assert.equal((db.prepare('SELECT count(*) AS n FROM savings_baselines').get() as { n: number }).n, 2);
  } finally { db.close(); }
});

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('savings CLI JSON includes project weekly metrics and snapshots only on request', () => {
  const dir = tmp();
  const env = { ...process.env, AGENTLENS_DATA_DIR: dir, AGENTLENS_SOURCE_HOME: dir, AGENTLENS_STATE_DIR: dir };
  const run = (...args: string[]) => execFileSync(process.execPath, ['--no-warnings', CLI, 'savings', ...args], { env, encoding: 'utf8', stdio: 'pipe' });
  try {
    assert.deepEqual(JSON.parse(run('--json')), { weeks: 8, projects: [] });
    assert.equal(existsSync(join(dir, 'agentlens.db')), false);
    const db = openDb(join(dir, 'agentlens.db'));
    const projectId = upsertProject(db, '/work/app', 'app');
    const otherId = upsertProject(db, '/work/other', 'other');
    const previousWeek = new Date();
    previousWeek.setHours(0, 0, 0, 0);
    previousWeek.setDate(previousWeek.getDate() - (previousWeek.getDay() + 6) % 7 - 7);
    seed(db, projectId, 'before', previousWeek.getTime());
    seed(db, projectId, 'latest', Date.now() - 1000, 10, 10, 60, 20);
    seed(db, otherId, 'other', previousWeek.getTime(), 99999);
    const expected = getSavings(db, { projectId, weeks: 2 });

    assert.deepEqual(JSON.parse(run('--project', '/work/app', '--weeks', '2', '--json')), expected);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'savings_baselines'").get(), undefined);
    const text = run('--project', '/work/app', '--weeks', '2');
    assert.match(text, /Tokens\/session.*1000.*100.*-90%/);
    assert.match(text, /Latest:.*partial/);

    const snapshot = JSON.parse(run('--project', '/work/app', '--snapshot', '--json'));
    assert.equal(snapshot.projects[0].baselineSource, 'snapshot');
    assert.equal(snapshot.projects[0].baseline.tokensPerSession, 100);
    assert.deepEqual(JSON.parse(run('--project', '/work/app', '--json')), snapshot);
    assert.deepEqual(db.prepare('SELECT project_id FROM savings_baselines').all().map((row) => row.project_id), [projectId]);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('savings CLI rejects invalid weeks and unknown projects without creating snapshots', () => {
  const dir = tmp();
  const env = { ...process.env, AGENTLENS_DATA_DIR: dir, AGENTLENS_SOURCE_HOME: dir, AGENTLENS_STATE_DIR: dir };
  try {
    for (const value of ['0', '-1', '1.5', 'nope', 'Infinity']) {
      const result = spawnSync(process.execPath, ['--no-warnings', CLI, 'savings', '--snapshot', `--weeks=${value}`], { env, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /weeks must be a positive integer/);
    }
    assert.equal(existsSync(join(dir, 'agentlens.db')), false);
    const result = spawnSync(process.execPath, ['--no-warnings', CLI, 'savings', '--project', '/unknown', '--json'], { env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown project/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('savings uses local Monday boundaries across DST and year changes, and excludes future events', () => {
  const originalTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  const db = openDb(':memory:');
  try {
    const projectId = upsertProject(db, '/work/app', 'app');
    const beforeDst = new Date(2026, 9, 26).getTime();
    const afterDst = new Date(2026, 10, 2).getTime();
    seed(db, projectId, 'sunday', afterDst - 1);
    seed(db, projectId, 'monday', afterDst);
    const at = new Date(2026, 10, 3, 12).getTime();
    seed(db, projectId, 'future', at + 1);
    let report = getSavings(db, { weeks: 2, now: at }).projects[0];
    assert.deepEqual(report.weekly.map((week) => [week.weekStart, week.sessions, week.complete]), [
      [beforeDst, 1, true], [afterDst, 1, false],
    ]);
    assert.equal(afterDst - beforeDst, 169 * 3600_000);

    const yearMonday = new Date(2025, 11, 29).getTime();
    seed(db, projectId, 'new-year', new Date(2026, 0, 1).getTime());
    report = getSavings(db, { weeks: 2, now: new Date(2026, 0, 6).getTime() }).projects[0];
    assert.equal(report.baseline?.weekStart, yearMonday);
    assert.equal(report.latest?.weekStart, yearMonday);
  } finally {
    db.close();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test('savings validates the requested week range before querying', () => {
  const db = openDb(':memory:');
  try {
    for (const weeks of [0, -1, 1.5, NaN, Infinity]) {
      assert.throws(() => getSavings(db, { weeks }), /weeks must be a positive integer/);
    }
    assert.throws(() => getSavings(db, { weeks: Number.MAX_SAFE_INTEGER }), /supported date range/);
  } finally { db.close(); }
});
