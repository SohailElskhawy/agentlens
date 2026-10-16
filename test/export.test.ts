import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertEvents, upsertProject, upsertSessions, upsertFindings, insertQuotas } from '../src/db.ts';
import { exportData, generatePrometheusMetrics, rowsToCsv } from '../src/export.ts';
import { startServer } from '../src/server.ts';
import type { AddressInfo } from 'node:net';

test('exportData formats sessions, daily, and findings to CSV and JSON', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/work/test-proj', 'test-proj');
  upsertSessions(db, [{ id: 'sess-1', agent: 'claude', cwd: '/work/test-proj', projectId: projId }]);

  const now = 1730000000000;
  upsertEvents(db, [
    {
      id: 'ev-1',
      agent: 'claude',
      sessionId: 'sess-1',
      ts: now,
      kind: 'assistant',
      model: 'claude-3-5-sonnet',
      input: 1000,
      output: 200,
      cacheRead: 500,
      cacheWrite: 0,
      reasoning: 50,
    },
    {
      id: 'ev-2',
      agent: 'claude',
      sessionId: 'sess-1',
      ts: now + 1000,
      kind: 'tool_call',
      tool: 'read_file',
    },
  ]);

  upsertFindings(db, [
    {
      id: 'f-1',
      rule: 'retry_loop',
      projectId: projId,
      sessionId: 'sess-1',
      confidence: 'high',
      confidenceReason: 'Repeated tool failures',
      estTokensWeek: 15000,
      firstSeen: now,
      lastSeen: now,
      evidence: { agent: 'claude', tool: 'read_file', count: 3 },
    },
  ]);

  // 1. JSON export (all)
  const jsonAll = JSON.parse(exportData(db, { format: 'json', type: 'all' }));
  assert.ok(jsonAll.sessions);
  assert.equal(jsonAll.sessions.length, 1);
  assert.equal(jsonAll.sessions[0].id, 'sess-1');
  assert.equal(jsonAll.sessions[0].turns, 1);
  assert.equal(jsonAll.sessions[0].toolCalls, 1);
  assert.equal(jsonAll.sessions[0].tokens, 1700);

  assert.ok(jsonAll.daily);
  assert.equal(jsonAll.daily.length, 1);
  assert.equal(jsonAll.daily[0].tokens, 1700);

  assert.ok(jsonAll.findings);
  assert.equal(jsonAll.findings.length, 1);
  assert.equal(jsonAll.findings[0].rule, 'retry_loop');

  // 2. CSV export (sessions)
  const csvSessions = exportData(db, { format: 'csv', type: 'sessions' });
  const lines = csvSessions.trim().split('\n');
  assert.ok(lines.length >= 2);
  assert.ok(lines[0].startsWith('id,agent,project,'));
  assert.ok(lines[1].includes('sess-1,claude,test-proj'));

  // 3. CSV export (daily)
  const csvDaily = exportData(db, { format: 'csv', type: 'daily' });
  assert.ok(csvDaily.startsWith('day,agent,tokens,cost,'));

  // 4. CSV export (findings)
  const csvFindings = exportData(db, { format: 'csv', type: 'findings' });
  assert.ok(csvFindings.startsWith('id,rule,agent,projectId,'));
  assert.ok(csvFindings.includes('retry_loop'));
});

test('generatePrometheusMetrics exports standard prometheus text format', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/work/test-proj', 'test-proj');
  upsertSessions(db, [{ id: 'sess-1', agent: 'claude', cwd: '/work/test-proj', projectId: projId }]);

  upsertEvents(db, [
    {
      id: 'ev-1',
      agent: 'claude',
      sessionId: 'sess-1',
      ts: Date.now(),
      kind: 'assistant',
      model: 'claude-3-5-sonnet',
      input: 500,
      output: 100,
      cacheRead: 200,
      cacheWrite: 0,
      reasoning: 20,
    },
  ]);

  insertQuotas(db, [
    {
      agent: 'claude',
      window: '5h',
      usedPct: 75.5,
      resetsAt: Date.now() + 3600000,
      source: 'test',
      ts: Date.now(),
    },
  ]);

  upsertFindings(db, [
    {
      id: 'f-1',
      rule: 'context_growth',
      projectId: null,
      sessionId: 'sess-1',
      confidence: 'medium',
      confidenceReason: 'Steep context growth',
      estTokensWeek: 20000,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      evidence: { agent: 'claude' },
    },
  ]);

  const metrics = generatePrometheusMetrics(db);
  assert.ok(metrics.includes('# TYPE agentlens_tokens_total counter'));
  assert.ok(metrics.includes('agentlens_tokens_total{agent="claude",kind="input"} 500'));
  assert.ok(metrics.includes('agentlens_tokens_total{agent="claude",kind="output"} 100'));
  assert.ok(metrics.includes('agentlens_tokens_total{agent="claude",kind="cache_read"} 200'));

  assert.ok(metrics.includes('# TYPE agentlens_sessions_total counter'));
  assert.ok(metrics.includes('agentlens_sessions_total{agent="claude"} 1'));

  assert.ok(metrics.includes('# TYPE agentlens_quota_used_percent gauge'));
  assert.ok(metrics.includes('agentlens_quota_used_percent{agent="claude",window="5h"} 75.5'));

  assert.ok(metrics.includes('# TYPE agentlens_findings_active gauge'));
  assert.ok(metrics.includes('agentlens_findings_active{rule="context_growth"} 1'));
});

test('HTTP server serves GET /api/export.csv and GET /metrics', async () => {
  const db = openDb(':memory:');
  upsertSessions(db, [{ id: 'sess-api-1', agent: 'codex', cwd: '/work/proj', projectId: null }]);
  upsertEvents(db, [
    {
      id: 'ev-10',
      agent: 'codex',
      sessionId: 'sess-api-1',
      ts: Date.now(),
      kind: 'assistant',
      model: 'gpt-4o',
      input: 400,
      output: 150,
      cacheRead: 0,
      cacheWrite: 0,
    },
  ]);

  const server = await startServer(db, 0);
  const port = (server.address() as AddressInfo).port;

  try {
    // 1. GET /api/export.csv
    const resCsv = await fetch(`http://127.0.0.1:${port}/api/export.csv?type=sessions`);
    assert.equal(resCsv.status, 200);
    assert.equal(resCsv.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.ok(resCsv.headers.get('content-disposition')?.includes('attachment; filename="agentlens-sessions.csv"'));
    const csvText = await resCsv.text();
    assert.ok(csvText.includes('sess-api-1,codex'));

    // 2. GET /metrics
    const resMetrics = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(resMetrics.status, 200);
    assert.equal(resMetrics.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8');
    const metricsText = await resMetrics.text();
    assert.ok(metricsText.includes('agentlens_tokens_total{agent="codex",kind="input"} 400'));
  } finally {
    server.close();
  }
});
