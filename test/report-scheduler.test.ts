import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { checkWeeklyReportSchedule, sendDesktopNotification } from '../src/report-scheduler.ts';

test('checkWeeklyReportSchedule generates previous week report on Monday after 09:00', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-sched-test-'));

  try {
    const db = openDb(':memory:');

    // Monday 2026-10-19 10:00:00 UTC (week 43 Monday morning)
    // The previous closed week is 2026-W42
    const monday10am = Date.UTC(2026, 9, 19, 10, 0, 0);

    // 1. Should generate report for 2026-W42
    const res1 = checkWeeklyReportSchedule(db, tmp, monday10am);
    assert.equal(res1.generated, true);
    assert.equal(res1.week, '2026-W42');
    assert.ok(res1.path && existsSync(res1.path));

    // 2. Second run for same time should NOT re-generate
    const res2 = checkWeeklyReportSchedule(db, tmp, monday10am + 3600_000);
    assert.equal(res2.generated, false);
    assert.equal(res2.week, '2026-W42');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkWeeklyReportSchedule does not trigger before Monday 09:00', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-sched-test-'));

  try {
    const db = openDb(':memory:');

    // Sunday 2026-10-18 20:00:00 UTC
    // Week 42 is not finished yet, and week 41 was already handled or not Monday
    const sunday8pm = Date.UTC(2026, 9, 18, 20, 0, 0);

    const res = checkWeeklyReportSchedule(db, tmp, sunday8pm);
    // Sunday before Monday 09:00 should not trigger a report for the current week
    assert.equal(res.generated, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('sendDesktopNotification survives in headless or missing notify-send environments', () => {
  // Should never throw
  assert.doesNotThrow(() => {
    const sent = sendDesktopNotification('agentlens test', 'Report generated');
    assert.equal(typeof sent, 'boolean');
  });
});
