import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb, upsertProject, upsertSessions, upsertEvents } from '../src/db.ts';
import { projects } from '../src/queries.ts';
import { generateWeeklyReport, getIsoWeekBounds } from '../src/report.ts';
import { startServer } from '../src/server.ts';
import type { NormalizedEvent, SessionInfo } from '../src/types.ts';

test('per-project budgets can be set, queried, cleared, and reflected in weekly reports', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-budget-test-'));
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/work/budget-app', 'budget-app');

  const server = await startServer(db, 0, '127.0.0.1');
  const port = (server.address() as AddressInfo).port;

  try {
    // Insert initial session and event for this project (40,000 tokens)
    const bounds = getIsoWeekBounds('2026-W42');
    const midTs = bounds.startTs + 3600_000;
    const sessionList: (SessionInfo & { projectId: number | null })[] = [
      { id: 's_proj_1', agent: 'claude', projectId: projId, cwd: '/work/budget-app' },
    ];
    const eventList: NormalizedEvent[] = [
      { id: 'e1', agent: 'claude', sessionId: 's_proj_1', ts: midTs, kind: 'assistant', model: 'claude-3-5-sonnet-20241022', input: 30_000, output: 10_000, cacheRead: 0, cacheWrite: 0 },
    ];
    upsertSessions(db, sessionList);
    upsertEvents(db, eventList);

    // 1. Initial query without budget
    const initialProjects = projects(db, {});
    const p1 = initialProjects.find((p) => p.name === 'budget-app');
    assert.ok(p1);
    assert.equal(p1.budgetTokens, undefined);
    assert.equal(p1.budgetCost, undefined);
    assert.equal(p1.budgetPct, undefined);

    // 2. Set budget via POST /api/project/budget
    const res = await fetch(`http://127.0.0.1:${port}/api/project/budget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: projId,
        budgetTokens: 50_000,
        budgetCost: 10,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    // 3. Query projects and verify budget calculations
    const updatedProjects = projects(db, {});
    const p2 = updatedProjects.find((p) => p.name === 'budget-app');
    assert.ok(p2);
    assert.equal(p2.budgetTokens, 50_000);
    assert.equal(p2.budgetCost, 10);
    assert.equal(p2.budgetPct, 80);

    // 4. Generate weekly report and verify budget inclusion
    const report1 = generateWeeklyReport(db, '2026-W42', tmp);
    const reportProj1 = report1.data.byProject.find((p) => p.name === 'budget-app');
    assert.ok(reportProj1);
    assert.equal(reportProj1.budgetTokens, 50_000);
    assert.equal(reportProj1.budgetPct, 80);
    assert.equal(reportProj1.budgetStatus, '80% (Within budget)');
    assert.ok(report1.markdown.includes('80% (Within budget)'));
    assert.ok(report1.html.includes('80% (Within budget)'));

    // 5. Exceed budget (insert another 20,000 tokens => 60,000 total / 50,000 = 120%)
    upsertEvents(db, [
      { id: 'e2', agent: 'claude', sessionId: 's_proj_1', ts: midTs + 1000, kind: 'assistant', model: 'claude-3-5-sonnet-20241022', input: 15_000, output: 5_000, cacheRead: 0, cacheWrite: 0 },
    ]);
    const report2 = generateWeeklyReport(db, '2026-W42', tmp);
    const reportProj2 = report2.data.byProject.find((p) => p.name === 'budget-app');
    assert.ok(reportProj2);
    assert.equal(reportProj2.budgetPct, 120);
    assert.equal(reportProj2.budgetStatus, '120% (Over budget)');
    assert.ok(report2.markdown.includes('120% (Over budget)'));
    assert.ok(report2.html.includes('120% (Over budget)'));

    // 6. Clear budget
    const clearRes = await fetch(`http://127.0.0.1:${port}/api/project/budget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: projId,
        budgetTokens: 0,
        budgetCost: 0,
      }),
    });
    assert.equal(clearRes.status, 200);

    const clearedProjects = projects(db, {});
    const p3 = clearedProjects.find((p) => p.name === 'budget-app');
    assert.ok(p3);
    assert.equal(p3.budgetTokens, undefined);
    assert.equal(p3.budgetCost, undefined);
    assert.equal(p3.budgetPct, undefined);
  } finally {
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
