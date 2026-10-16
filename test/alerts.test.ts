import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSetting, insertQuotas, upsertEvents, upsertProject, upsertSessions } from '../src/db.ts';
import { checkLiveAlerts, clearAlertDebounceCache } from '../src/alerts.ts';

test('checkLiveAlerts detects retry loops in active sessions and notifies with debounce', () => {
  clearAlertDebounceCache();
  const db = openDb(':memory:');
  const now = Date.now();

  const projId = upsertProject(db, '/work/test', 'test');
  upsertSessions(db, [{ id: 'sess-active', agent: 'claude', cwd: '/work/test', projectId: projId }]);

  // Add 4 identical tool calls within last 10 minutes (retry loop)
  const events = [];
  for (let i = 0; i < 4; i++) {
    events.push({
      id: `e-${i}`,
      agent: 'claude' as const,
      sessionId: 'sess-active',
      ts: now - (10 - i) * 60_000,
      kind: 'tool_call' as const,
      tool: 'Bash',
      argsHash: 'hash-fail-cmd',
    });
  }
  upsertEvents(db, events);

  const notifications: Array<{ title: string; body: string }> = [];
  const mockNotifier = (title: string, body: string) => {
    notifications.push({ title, body });
    return true;
  };

  // 1. Initial check: should fire
  const fired1 = checkLiveAlerts(db, { now, notifier: mockNotifier });
  assert.equal(fired1.length, 1);
  assert.equal(fired1[0].type, 'retry_loop');
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].title, /Retry Loop/);
  assert.match(notifications[0].body, /sess-act/);

  // 2. Immediate second check: should debounce
  const fired2 = checkLiveAlerts(db, { now: now + 5000, notifier: mockNotifier });
  assert.equal(fired2.length, 0);
  assert.equal(notifications.length, 1);

  // 3. Check with alert_retry_loop disabled: should not fire even with new session
  upsertSessions(db, [{ id: 'sess-active-2', agent: 'claude', cwd: '/work/test', projectId: projId }]);
  for (let i = 0; i < 4; i++) {
    events.push({
      id: `e-2-${i}`,
      agent: 'claude' as const,
      sessionId: 'sess-active-2',
      ts: now - (10 - i) * 60_000,
      kind: 'tool_call' as const,
      tool: 'Bash',
      argsHash: 'hash-fail-cmd',
    });
  }
  upsertEvents(db, events);
  setSetting(db, 'alert_retry_loop', 'false');

  const fired3 = checkLiveAlerts(db, { now, notifier: mockNotifier });
  assert.equal(fired3.length, 0);
});

test('checkLiveAlerts detects quota forecast predicting exhaustion within 30 minutes', () => {
  clearAlertDebounceCache();
  const db = openDb(':memory:');
  const now = Date.now();
  const resetTime = now + 90 * 60_000;

  // Jumped 85% to 95% in 10 minutes -> remaining 5% exhausts in 5 minutes (<= 30m)
  insertQuotas(db, [
    {
      agent: 'claude',
      window: '5h',
      ts: now - 10 * 60_000,
      usedPct: 85.0,
      resetsAt: resetTime,
      source: 'test',
    },
    {
      agent: 'claude',
      window: '5h',
      ts: now,
      usedPct: 95.0,
      resetsAt: resetTime,
      source: 'test',
    },
  ]);

  const notifications: Array<{ title: string; body: string }> = [];
  const mockNotifier = (title: string, body: string) => {
    notifications.push({ title, body });
    return true;
  };

  const fired = checkLiveAlerts(db, { now, notifier: mockNotifier });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].type, 'quota_forecast');
  assert.match(notifications[0].title, /Quota Exhaustion Warning/);
  assert.match(notifications[0].body, /CLAUDE 5h quota projected to hit 100%/);
});

test('checkLiveAlerts fires when project budget crosses 80% and 100%', () => {
  clearAlertDebounceCache();
  const db = openDb(':memory:');
  const now = Date.now();

  const projId = upsertProject(db, '/work/budget-app', 'budget-app');
  upsertSessions(db, [{ id: 'sess-b1', agent: 'claude', cwd: '/work/budget-app', projectId: projId }]);

  // Configure weekly budget: 10,000 tokens
  setSetting(db, `budget_tokens_${projId}`, '10000');

  // Insert 8,500 tokens (85% of budget)
  upsertEvents(db, [
    {
      id: 'e-b1',
      agent: 'claude',
      sessionId: 'sess-b1',
      ts: now - 60_000,
      kind: 'assistant',
      input: 5000,
      output: 3500,
    },
  ]);

  const notifications: Array<{ title: string; body: string }> = [];
  const mockNotifier = (title: string, body: string) => {
    notifications.push({ title, body });
    return true;
  };

  const fired80 = checkLiveAlerts(db, { now, notifier: mockNotifier });
  assert.equal(fired80.length, 1);
  assert.equal(fired80[0].type, 'budget');
  assert.match(notifications[0].body, /85% of its weekly token budget/);

  // Now push it to 11,000 tokens (110% of budget)
  upsertEvents(db, [
    {
      id: 'e-b2',
      agent: 'claude',
      sessionId: 'sess-b1',
      ts: now - 30_000,
      kind: 'assistant',
      input: 2500,
      output: 0,
    },
  ]);

  const fired100 = checkLiveAlerts(db, { now, notifier: mockNotifier });
  assert.equal(fired100.length, 1);
  assert.match(notifications[1].title, /Project Budget Exceeded/);
  assert.match(notifications[1].body, /exceeded 100%/);
});
