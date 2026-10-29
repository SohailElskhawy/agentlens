import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, setSetting, upsertEvents, upsertFindings, upsertProject, upsertRecommendations, upsertSessions } from '../src/db.ts';
import { enrichRecommendations } from '../src/ai/recommendations.ts';
import type { Recommendation } from '../src/types.ts';
import { drainQuotaSpool, formatStatusline, spoolQuota, writeSummary, type StatuslineFormat } from '../src/summary.ts';
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

test('writeSummary includes v1.1 fields: byAgentToday, recommendations, liveAlerts, daily7d, topModels, and projectList', async () => {
  const { setSetting } = await import('../src/db.ts');
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');
  const now = Date.now();

  const projId = upsertProject(db, '/work/gamma', 'gamma');
  setSetting(db, `budget_tokens_${projId}`, '100000');

  upsertSessions(db, [
    { id: 's-claude', agent: 'claude', cwd: '/work/gamma', projectId: projId },
    { id: 's-anti', agent: 'antigravity', cwd: '/work/gamma', projectId: projId },
  ]);

  upsertEvents(db, [
    {
      id: 'ev-c1',
      agent: 'claude',
      sessionId: 's-claude',
      ts: now - 10 * 60_000,
      kind: 'assistant',
      model: 'claude-sonnet-4-6',
      input: 15_000,
      output: 5_000,
      cacheRead: 10_000,
      cacheWrite: 0,
    },
    {
      id: 'ev-a1',
      agent: 'antigravity',
      sessionId: 's-anti',
      ts: now - 3 * 60_000,
      kind: 'assistant',
      model: 'Gemini 4 Argon (High)',
      input: 20_000,
      output: 2_000,
      cacheRead: 30_000,
      cacheWrite: 0,
    },
  ]);

  upsertFindings(db, [
    {
      id: 'f-loop',
      rule: 'retry_loop',
      projectId: projId,
      sessionId: 's-anti',
      evidence: { tool: 'run_command', retries: 5 },
      confidence: 'high',
      confidenceReason: '5 consecutive tool errors',
      estTokensWeek: 65000,
      firstSeen: now - 5 * 60_000,
      lastSeen: now - 2 * 60_000,
    },
  ]);

  upsertRecommendations(db, [
    {
      id: 'rec-top-1',
      findingRule: 'retry_loop',
      projectId: projId,
      action: 'improve',
      title: 'Stop retry loop on run_command',
      body: 'Halt after 2 consecutive failures',
      status: 'open',
      score: 92,
    },
    {
      id: 'rec-top-2',
      findingRule: 'hot_files',
      projectId: projId,
      action: 'add',
      title: 'Cache hot file summary',
      body: 'Add architecture notes to AGENTS.md',
      status: 'open',
      score: 78,
    },
  ]);

  writeSummary(db, summaryPath);
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));

  // byAgentToday
  assert.ok(Array.isArray(data.byAgentToday));
  assert.equal(data.byAgentToday.length, 2);
  assert.equal(data.byAgentToday[0].agent, 'antigravity');
  assert.equal(data.byAgentToday[0].tokens, 52_000);
  assert.equal(data.byAgentToday[1].agent, 'claude');
  assert.equal(data.byAgentToday[1].tokens, 30_000);

  // recommendations (Top 5)
  assert.ok(Array.isArray(data.recommendations));
  assert.equal(data.recommendations.length, 2);
  assert.equal(data.recommendations[0].id, 'rec-top-1');
  assert.equal(data.recommendations[1].id, 'rec-top-2');

  // liveAlerts (recent 30m findings)
  assert.ok(Array.isArray(data.liveAlerts));
  assert.equal(data.liveAlerts.length, 1);
  assert.equal(data.liveAlerts[0].rule, 'retry_loop');
  assert.equal(data.liveAlerts[0].projectName, 'gamma');

  // daily7d (7 local calendar days)
  assert.ok(Array.isArray(data.daily7d));
  assert.equal(data.daily7d.length, 7);
  assert.equal(data.daily7d[6].tokens, 82_000);

  // topModels
  assert.ok(Array.isArray(data.topModels));
  assert.equal(data.topModels.length, 2);
  assert.equal(data.topModels[0].model, 'Gemini 4 Argon (High)');
  assert.equal(data.topModels[0].tokens, 52_000);
  assert.equal(data.topModels[0].inputTokens, 20_000);
  assert.equal(data.topModels[0].outputTokens, 2_000);
  assert.equal(data.topModels[0].cacheTokens, 30_000);

  // projectList with weekly budgets
  assert.ok(Array.isArray(data.projectList));
  assert.equal(data.projectList.length, 1);
  assert.equal(data.projectList[0].name, 'gamma');
  assert.equal(data.projectList[0].path, '/work/gamma');
  assert.equal(data.projectList[0].weeklyTokenBudget, 100_000);
  assert.equal(data.projectList[0].weeklyTokensUsed, 82_000);
  assert.equal(data.projectList[0].budgetUsedPct, 82);
});

test('writeSummary: topInsight is null on an empty DB', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');

  writeSummary(db, summaryPath);
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));
  assert.equal(data.topInsight, null);
});

test('writeSummary: topInsight uses deterministic topRecommendation when AI is disabled (even if ai_notes contains cached rows)', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');

  upsertRecommendations(db, [
    {
      id: 'rec-1',
      findingRule: 'hot_files',
      projectId: null,
      action: 'improve',
      title: 'Hot file re-read: src/db.ts',
      body: 'Document src/db.ts exports in CLAUDE.md',
      status: 'open',
      score: 95,
    },
  ]);

  db.prepare(`
    INSERT INTO ai_notes (kind, input_hash, agent, model, created_at, text)
    VALUES ('explain', 'hash-exp', 'claude', '', 5000, '{"explanation":"Cached AI explanation that should be ignored when AI disabled"}')
  `).run();

  writeSummary(db, summaryPath);
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));
  assert.equal(data.topInsight, 'Document src/db.ts exports in CLAUDE.md');
});

test('writeSummary: topInsight falls back to anomaly when no recommendations exist and AI is disabled', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');
  const now = Date.now();

  const pid = upsertProject(db, '/work/proj-a', 'proj-a');
  upsertSessions(db, [{ id: 's-spike', agent: 'claude', cwd: '/work/proj-a', projectId: pid }]);

  // Baseline days 1, 2, 3
  for (const daysAgo of [1, 2, 3]) {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(12, 0, 0, 0);
    upsertEvents(db, [
      {
        id: `ev-base-${daysAgo}`,
        agent: 'claude',
        sessionId: 's-spike',
        ts: d.getTime(),
        kind: 'assistant',
        model: 'm',
        input: 400_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ]);
  }

  // Today spike: >= 2.5x median (400k) and >= 1M tokens
  upsertEvents(db, [
    {
      id: 'ev-today-spike',
      agent: 'claude',
      sessionId: 's-spike',
      ts: now,
      kind: 'assistant',
      model: 'm',
      input: 1_200_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  ]);

  writeSummary(db, summaryPath);
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));
  assert.ok(data.topInsight);
  assert.match(data.topInsight, /^claude \(proj-a\) spiked to 1\.2M on \d{4}-\d{2}-\d{2} \(3x median\)$/);
});

test('writeSummary: topInsight falls back to liveAlert when no recommendations or anomalies exist', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');
  const now = Date.now();

  upsertFindings(db, [
    {
      id: 'f-alert',
      rule: 'retry_loop',
      projectId: null,
      sessionId: null,
      evidence: {},
      confidence: 'high',
      confidenceReason: '5 consecutive tool failures detected',
      estTokensWeek: 50000,
      firstSeen: now - 5 * 60_000,
      lastSeen: now - 1 * 60_000,
    },
  ]);

  writeSummary(db, summaryPath);
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));
  assert.equal(data.topInsight, '5 consecutive tool failures detected');
});

test('writeSummary: topInsight returns cached recommendation aiBody when AI is enabled without invoking runner', async () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');
  setSetting(db, 'ai_enabled', 'true');

  const recs: Recommendation[] = [
    {
      id: 'rec:retry_loop:global:1',
      findingRule: 'retry_loop',
      projectId: null,
      action: 'improve',
      title: 'Stop retry loop on run_command',
      body: 'Halt after 2 consecutive failures',
      status: 'open',
      score: 95,
    },
  ];
  upsertRecommendations(db, recs);

  let runnerCalls = 0;
  const runner = async () => {
    runnerCalls++;
    return { ok: true, text: JSON.stringify([{ id: 'rec:retry_loop:global:1', aiBody: '  AI suggests halting after 2 failures and checking logs.  ' }]) };
  };

  const preview = await enrichRecommendations(db, recs, { runner });
  assert.equal(preview.status, 'confirmation_required');
  if (preview.status === 'confirmation_required') {
    await enrichRecommendations(db, recs, { runner, confirm: preview.preview.confirmationHash });
  }
  assert.equal(runnerCalls, 1);

  // Now writeSummary should synchronously pick up cached recommendation aiBody without calling any runner
  writeSummary(db, summaryPath);
  assert.equal(runnerCalls, 1, 'writeSummary must never invoke an AI runner');

  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));
  assert.equal(data.topInsight, 'AI suggests halting after 2 failures and checking logs.');
  // summary.recommendations remains deterministic
  assert.equal(data.recommendations[0].action, 'Halt after 2 consecutive failures');
});

test('writeSummary: topInsight returns cached explain note when no cached recommendation exists', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');
  setSetting(db, 'ai_enabled', 'true');

  db.prepare(`
    INSERT INTO ai_notes (kind, input_hash, agent, model, created_at, text)
    VALUES ('explain', 'hash-1', 'claude', '', 1000, '{"explanation":"Token spike on gamma project due to large diff generation."}')
  `).run();

  writeSummary(db, summaryPath);
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));
  assert.equal(data.topInsight, 'Token spike on gamma project due to large diff generation.');
});

test('writeSummary: topInsight returns cached diagnose summary when no cached recommendation or explain exists', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');
  setSetting(db, 'ai_enabled', 'true');

  const diagPayload = JSON.stringify({
    summary: '  Diagnosed cache thrashing due to repeated context rewrites.  ',
    causes: [{ cause: 'large files', evidence: '10 reads', est_tokens: 50000 }],
    fixes: [{ action: 'trim file', where: 'CLAUDE.md', snippet: 'shorten' }],
  });

  db.prepare(`
    INSERT INTO ai_notes (kind, input_hash, agent, model, created_at, text)
    VALUES ('diagnose', 'hash-2', 'claude', '', 2000, ?)
  `).run(diagPayload);

  writeSummary(db, summaryPath);
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));
  assert.equal(data.topInsight, 'Diagnosed cache thrashing due to repeated context rewrites.');
});

test('writeSummary: malformed/schema-invalid ai_notes rows are ignored and topInsight falls back cleanly', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');
  setSetting(db, 'ai_enabled', 'true');

  upsertRecommendations(db, [
    {
      id: 'rec-fallback',
      findingRule: 'hot_files',
      projectId: null,
      action: 'improve',
      title: 'Hot file cache',
      body: 'Deterministic action advice',
      status: 'open',
      score: 80,
    },
  ]);

  // Insert newest malformed explain note (invalid JSON)
  db.prepare(`
    INSERT INTO ai_notes (kind, input_hash, agent, model, created_at, text)
    VALUES ('explain', 'hash-bad-1', 'claude', '', 3000, 'NOT JSON')
  `).run();

  // Insert another malformed diagnose note (missing causes/fixes arrays)
  db.prepare(`
    INSERT INTO ai_notes (kind, input_hash, agent, model, created_at, text)
    VALUES ('diagnose', 'hash-bad-2', 'claude', '', 2000, '{"summary":"Missing required causes"}')
  `).run();

  writeSummary(db, summaryPath);
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));
  assert.equal(data.topInsight, 'Deterministic action advice');
});

test('writeSummary: ignores newest malformed note and uses valid older note within limit', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');
  setSetting(db, 'ai_enabled', 'true');

  // Older valid note
  db.prepare(`
    INSERT INTO ai_notes (kind, input_hash, agent, model, created_at, text)
    VALUES ('explain', 'hash-valid', 'claude', '', 1000, '{"explanation":"Valid older explanation."}')
  `).run();

  // Newest malformed note
  db.prepare(`
    INSERT INTO ai_notes (kind, input_hash, agent, model, created_at, text)
    VALUES ('explain', 'hash-bad', 'claude', '', 2000, 'INVALID')
  `).run();

  writeSummary(db, summaryPath);
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));
  assert.equal(data.topInsight, 'Valid older explanation.');
});

test('writeSummary: active session (last 15m) with contextSize >= 120k and growth >= 20k sets contextWarning and formatStatusline includes warning in < 10ms', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');
  const now = Date.now();

  const projId = upsertProject(db, '/work/runaway', 'runaway');
  upsertSessions(db, [{ id: 's-warn', agent: 'claude', cwd: '/work/runaway', projectId: projId }]);

  // Turn 1 (earlier): contextSize = 100_000
  // Turn 2 (latest): contextSize = 125_000 (growth = 25_000 >= 20_000, contextSize >= 120_000)
  upsertEvents(db, [
    {
      id: 'e-turn1',
      agent: 'claude',
      sessionId: 's-warn',
      ts: now - 5 * 60_000,
      kind: 'assistant',
      input: 70_000,
      output: 500,
      cacheRead: 20_000,
      cacheWrite: 10_000,
    },
    {
      id: 'e-turn2',
      agent: 'claude',
      sessionId: 's-warn',
      ts: now - 2 * 60_000,
      kind: 'assistant',
      input: 80_000,
      output: 500,
      cacheRead: 30_000,
      cacheWrite: 15_000,
    },
  ]);

  writeSummary(db, summaryPath);
  assert.ok(existsSync(summaryPath));

  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));
  assert.equal(data.projects['/work/runaway']?.contextWarning, '[COMPACT RECOMMENDED]');

  const start = performance.now();
  const statusline = formatStatusline(summaryPath, '/work/runaway');
  const elapsed = performance.now() - start;

  assert.ok(elapsed < 10, `Statusline took ${elapsed}ms (expected < 10ms)`);
  assert.match(statusline, /· \[COMPACT RECOMMENDED\]/);
});

test('writeSummary: active session below threshold (contextSize < 120k or growth < 20k) has no contextWarning', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');
  const now = Date.now();

  // Project A: growth >= 20k, but contextSize < 120k (e.g. 50k -> 80k)
  const projIdA = upsertProject(db, '/work/sub-threshold-size', 'sub-threshold-size');
  upsertSessions(db, [{ id: 's-sub-size', agent: 'claude', cwd: '/work/sub-threshold-size', projectId: projIdA }]);
  upsertEvents(db, [
    {
      id: 'e-sub-a1',
      agent: 'claude',
      sessionId: 's-sub-size',
      ts: now - 6 * 60_000,
      kind: 'assistant',
      input: 50_000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
    },
    {
      id: 'e-sub-a2',
      agent: 'claude',
      sessionId: 's-sub-size',
      ts: now - 3 * 60_000,
      kind: 'assistant',
      input: 80_000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
    },
  ]);

  // Project B: contextSize >= 120k, but growth < 20k (e.g. 120k -> 125k)
  const projIdB = upsertProject(db, '/work/sub-threshold-growth', 'sub-threshold-growth');
  upsertSessions(db, [{ id: 's-sub-growth', agent: 'claude', cwd: '/work/sub-threshold-growth', projectId: projIdB }]);
  upsertEvents(db, [
    {
      id: 'e-sub-b1',
      agent: 'claude',
      sessionId: 's-sub-growth',
      ts: now - 5 * 60_000,
      kind: 'assistant',
      input: 120_000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
    },
    {
      id: 'e-sub-b2',
      agent: 'claude',
      sessionId: 's-sub-growth',
      ts: now - 2 * 60_000,
      kind: 'assistant',
      input: 125_000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
    },
  ]);

  writeSummary(db, summaryPath);
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));

  assert.equal(data.projects['/work/sub-threshold-size']?.contextWarning, undefined);
  assert.equal(data.projects['/work/sub-threshold-growth']?.contextWarning, undefined);

  const statuslineA = formatStatusline(summaryPath, '/work/sub-threshold-size');
  assert.doesNotMatch(statuslineA, /\[COMPACT RECOMMENDED\]/);

  const statuslineB = formatStatusline(summaryPath, '/work/sub-threshold-growth');
  assert.doesNotMatch(statuslineB, /\[COMPACT RECOMMENDED\]/);
});

test('writeSummary: inactive session (> 15m ago) is ignored even if turns had contextSize >= 120k and growth >= 20k', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');
  const now = Date.now();

  const projId = upsertProject(db, '/work/inactive-session', 'inactive-session');
  upsertSessions(db, [{ id: 's-inactive', agent: 'claude', cwd: '/work/inactive-session', projectId: projId }]);

  // Turns happened 30m and 20m ago (> 15m ago, ts < now - 900_000)
  upsertEvents(db, [
    {
      id: 'e-old1',
      agent: 'claude',
      sessionId: 's-inactive',
      ts: now - 30 * 60_000,
      kind: 'assistant',
      input: 100_000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
    },
    {
      id: 'e-old2',
      agent: 'claude',
      sessionId: 's-inactive',
      ts: now - 20 * 60_000,
      kind: 'assistant',
      input: 130_000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
    },
  ]);

  writeSummary(db, summaryPath);
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));

  assert.equal(data.projects['/work/inactive-session']?.contextWarning, undefined);

  const statusline = formatStatusline(summaryPath, '/work/inactive-session');
  assert.doesNotMatch(statusline, /\[COMPACT RECOMMENDED\]/);
});

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('formatStatusline: formats default, starship, and raw formats without forecast/warning in < 10ms', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const summaryData = {
    updatedAt: Date.now(),
    totals: {
      tokensToday: 3500,
      costToday: 0.05,
      burnRateTokensPerHour: 3500,
      activeSessions: 1,
    },
    projects: {
      '/work/my-app': {
        projectId: 1,
        root: '/work/my-app',
        name: 'my-app',
        tokensToday: 3500,
      },
    },
    quotas: {
      claude: {
        '5h': 33.3,
        '7d': 12.0,
      },
    },
  };
  writeFileSync(summaryPath, JSON.stringify(summaryData));

  // Default format
  const t0 = performance.now();
  const def = formatStatusline(summaryPath, '/work/my-app', 'default');
  const dDef = performance.now() - t0;
  assert.ok(dDef < 10, `default format took ${dDef}ms (expected < 10ms)`);
  assert.equal(def, 'my-app · 3.5k · 5h 33% · 7d 12%');

  // Starship format
  const t1 = performance.now();
  const starship = formatStatusline(summaryPath, '/work/my-app', 'starship');
  const dStarship = performance.now() - t1;
  assert.ok(dStarship < 10, `starship format took ${dStarship}ms (expected < 10ms)`);
  assert.equal(starship, '⚡ 33% 5h | 3.5k/d');

  // Raw format
  const t2 = performance.now();
  const raw = formatStatusline(summaryPath, '/work/my-app', 'raw');
  const dRaw = performance.now() - t2;
  assert.ok(dRaw < 10, `raw format took ${dRaw}ms (expected < 10ms)`);
  assert.equal(raw, 'my-app\t3.5k\t33%\t12%\t\t');
});

test('formatStatusline: formats default, starship, and raw formats with statuslineForecast and contextWarning in < 10ms', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const summaryData = {
    updatedAt: Date.now(),
    totals: {
      tokensToday: 50000,
      costToday: 0.25,
      burnRateTokensPerHour: 10000,
      activeSessions: 2,
    },
    projects: {
      '/work/runaway': {
        projectId: 2,
        root: '/work/runaway',
        name: 'runaway',
        tokensToday: 50000,
        contextWarning: '[COMPACT RECOMMENDED]',
      },
    },
    quotas: {
      claude: {
        '5h': 75.0,
        '7d': 25.0,
      },
    },
    statuslineForecast: '5h limit hit at 18:00',
  };
  writeFileSync(summaryPath, JSON.stringify(summaryData));

  // Default format
  const t0 = performance.now();
  const def = formatStatusline(summaryPath, '/work/runaway', 'default');
  const dDef = performance.now() - t0;
  assert.ok(dDef < 10, `default took ${dDef}ms`);
  assert.equal(def, 'runaway · 50.0k · 5h 75% · 7d 25% · 5h limit hit at 18:00 · [COMPACT RECOMMENDED]');

  // Starship format
  const t1 = performance.now();
  const starship = formatStatusline(summaryPath, '/work/runaway', 'starship');
  const dStarship = performance.now() - t1;
  assert.ok(dStarship < 10, `starship took ${dStarship}ms`);
  assert.equal(starship, '⚡ 75% 5h | 50.0k/d | 5h limit hit at 18:00 | [COMPACT RECOMMENDED]');

  // Raw format
  const t2 = performance.now();
  const raw = formatStatusline(summaryPath, '/work/runaway', 'raw');
  const dRaw = performance.now() - t2;
  assert.ok(dRaw < 10, `raw took ${dRaw}ms`);
  assert.equal(raw, 'runaway\t50.0k\t75%\t25%\t5h limit hit at 18:00\t[COMPACT RECOMMENDED]');
});

test('formatStatusline: formats starship and raw with only forecast or only contextWarning', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');

  // Forecast only
  writeFileSync(summaryPath, JSON.stringify({
    updatedAt: Date.now(),
    totals: { tokensToday: 1000, costToday: 0.01, burnRateTokensPerHour: 1000, activeSessions: 1 },
    projects: { '/work/proj': { projectId: 1, root: '/work/proj', name: 'proj', tokensToday: 1000 } },
    quotas: { claude: { '5h': 60, '7d': 30 } },
    statuslineForecast: '5h limit near',
  }));

  assert.equal(formatStatusline(summaryPath, '/work/proj', 'starship'), '⚡ 60% 5h | 1.0k/d | 5h limit near');
  assert.equal(formatStatusline(summaryPath, '/work/proj', 'raw'), 'proj\t1.0k\t60%\t30%\t5h limit near\t');

  // Warning only
  writeFileSync(summaryPath, JSON.stringify({
    updatedAt: Date.now(),
    totals: { tokensToday: 2000, costToday: 0.02, burnRateTokensPerHour: 2000, activeSessions: 3 },
    projects: { '/work/proj': { projectId: 1, root: '/work/proj', name: 'proj', tokensToday: 2000, contextWarning: '[COMPACT RECOMMENDED]' } },
    quotas: { claude: { '5h': 40, '7d': 20 } },
  }));

  assert.equal(formatStatusline(summaryPath, '/work/proj', 'starship'), '⚡ 40% 5h | 2.0k/d | [COMPACT RECOMMENDED]');
  assert.equal(formatStatusline(summaryPath, '/work/proj', 'raw'), 'proj\t2.0k\t40%\t20%\t\t[COMPACT RECOMMENDED]');
});

test('formatStatusline: missing summary.json produces safe -- placeholders in all 3 formats without throwing in < 10ms', () => {
  const missingPath = join(tmp(), 'non-existent-summary.json');

  const t0 = performance.now();
  const def = formatStatusline(missingPath, '/work/missing-app', 'default');
  const dDef = performance.now() - t0;
  assert.ok(dDef < 10, `default took ${dDef}ms`);
  assert.equal(def, 'missing-app · -- · 5h -- · 7d --');

  const t1 = performance.now();
  const starship = formatStatusline(missingPath, '/work/missing-app', 'starship');
  const dStarship = performance.now() - t1;
  assert.ok(dStarship < 10, `starship took ${dStarship}ms`);
  assert.equal(starship, '⚡ -- 5h | --/d');

  const t2 = performance.now();
  const raw = formatStatusline(missingPath, '/work/missing-app', 'raw');
  const dRaw = performance.now() - t2;
  assert.ok(dRaw < 10, `raw took ${dRaw}ms`);
  assert.equal(raw, 'missing-app\t--\t--\t--\t\t');
});

test('cli statusline: supports --format default, starship, raw, and rejects invalid formats', () => {
  const stateDir = tmp();
  const summaryPath = join(stateDir, 'summary.json');
  const projDir = join(stateDir, 'cwd-proj');
  mkdirSync(projDir, { recursive: true });
  writeFileSync(summaryPath, JSON.stringify({
    updatedAt: Date.now(),
    totals: { tokensToday: 5000, costToday: 0.05, burnRateTokensPerHour: 5000, activeSessions: 1 },
    projects: { [projDir]: { projectId: 1, root: projDir, name: 'cwd-proj', tokensToday: 5000 } },
    quotas: { claude: { '5h': 50, '7d': 25 } },
  }));

  const env = {
    ...process.env,
    AGENTLENS_STATE_DIR: stateDir,
    AGENTLENS_DATA_DIR: tmp(),
    AGENTLENS_SOURCE_HOME: tmp(),
  };

  // default flag
  const outDef = execFileSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, 'statusline', '--format', 'default'], {
    cwd: projDir,
    env,
    input: '',
    encoding: 'utf8',
  });
  assert.equal(outDef.trim(), 'cwd-proj · 5.0k · 5h 50% · 7d 25%');

  // starship flag
  const outStarship = execFileSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, 'statusline', '--format', 'starship'], {
    cwd: projDir,
    env,
    input: '',
    encoding: 'utf8',
  });
  assert.equal(outStarship.trim(), '⚡ 50% 5h | 5.0k/d');

  // raw flag with = syntax
  const outRaw = execFileSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, 'statusline', '--format=raw'], {
    cwd: projDir,
    env,
    input: '',
    encoding: 'utf8',
  });
  assert.equal(outRaw.replace(/\r?\n$/, ''), 'cwd-proj\t5.0k\t50%\t25%\t\t');

  // invalid format flag
  let errOutput = '';
  let exitCode = 0;
  try {
    execFileSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, 'statusline', '--format', 'unsupported'], {
      cwd: projDir,
      env,
      input: '',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    exitCode = err.status;
    errOutput = err.stderr;
  }
  assert.equal(exitCode, 1);
  assert.match(errOutput, /Usage: agentlens statusline \[--format default\|starship\|raw\]/);
});





