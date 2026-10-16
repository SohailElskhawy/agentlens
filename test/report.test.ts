import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, upsertProject, upsertSessions, upsertEvents, upsertFindings, upsertRecommendations, insertQuotas } from '../src/db.ts';
import { generateWeeklyReport, getIsoWeekBounds } from '../src/report.ts';
import type { Finding, NormalizedEvent, QuotaSnapshot, Recommendation, SessionInfo } from '../src/types.ts';

test('getIsoWeekBounds calculates ISO week boundaries correctly', () => {
  // Test specific ISO week: 2026-W42
  const bounds = getIsoWeekBounds('2026-W42');
  assert.equal(bounds.week, '2026-W42');
  assert.equal(new Date(bounds.startTs).getUTCDay(), 1); // Monday
  assert.equal(new Date(bounds.endTs).getUTCDay(), 0);   // Sunday
  assert.equal(bounds.endTs - bounds.startTs, 7 * 86_400_000 - 1);
  assert.equal(bounds.prevEndTs - bounds.prevStartTs, 7 * 86_400_000 - 1);
  assert.equal(bounds.startTs - bounds.prevStartTs, 7 * 86_400_000);
});

test('generateWeeklyReport produces data, Markdown, and HTML with all 6 sections', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-report-test-'));

  try {
    const db = openDb(':memory:');
    const projId = upsertProject(db, '/work/test-app', 'test-app');

    const bounds = getIsoWeekBounds('2026-W42');
    const prevMid = bounds.prevStartTs + 86_400_000;
    const currMid = bounds.startTs + 86_400_000;

    // Previous week sessions (50,000 tokens)
    const prevSessions: (SessionInfo & { projectId: number | null })[] = [
      { id: 's_prev_1', agent: 'claude', projectId: projId, cwd: '/work/test-app' },
    ];
    const prevEvents: NormalizedEvent[] = [
      { id: 'ep1', agent: 'claude', sessionId: 's_prev_1', ts: prevMid, kind: 'assistant', model: 'claude-3-5-sonnet-20241022', input: 30_000, output: 20_000, cacheRead: 0, cacheWrite: 0 },
    ];
    upsertSessions(db, prevSessions);
    upsertEvents(db, prevEvents);

    // Current week sessions (25,000 tokens = -50% reduction!)
    const currSessions: (SessionInfo & { projectId: number | null })[] = [
      { id: 's_curr_1', agent: 'claude', projectId: projId, cwd: '/work/test-app' },
      { id: 's_curr_2', agent: 'codex', projectId: projId, cwd: '/work/test-app' },
    ];
    const currEvents: NormalizedEvent[] = [
      { id: 'ec1', agent: 'claude', sessionId: 's_curr_1', ts: currMid, kind: 'assistant', model: 'claude-3-5-sonnet-20241022', input: 15_000, output: 5_000, cacheRead: 0, cacheWrite: 0 },
      { id: 'ec2', agent: 'codex', sessionId: 's_curr_2', ts: currMid + 3600_000, kind: 'assistant', model: 'gpt-4o', input: 3_000, output: 2_000, cacheRead: 0, cacheWrite: 0 },
    ];
    upsertSessions(db, currSessions);
    upsertEvents(db, currEvents);

    // Quotas in current week
    const quotas: QuotaSnapshot[] = [
      { agent: 'claude', ts: currMid, window: '5h', usedPct: 85, resetsAt: currMid + 7200_000, source: 'statusline' },
      { agent: 'claude', ts: currMid + 3600_000, window: '7d', usedPct: 40, resetsAt: currMid + 86400_000 * 3, source: 'statusline' },
    ];
    insertQuotas(db, quotas);

    // Findings
    const findings: Finding[] = [
      {
        id: 'f1',
        rule: 'context_growth',
        projectId: projId,
        sessionId: 's_curr_1',
        evidence: {},
        confidence: 'high',
        confidenceReason: 'Context grew without compaction',
        estTokensWeek: 80_000,
        firstSeen: currMid,
        lastSeen: currMid,
      },
    ];
    upsertFindings(db, findings);

    // Recommendations (Top actions)
    const recs: Recommendation[] = [
      {
        id: 'r1',
        findingRule: 'context_growth',
        projectId: projId,
        action: 'improve',
        title: 'Compact conversation context',
        body: 'Run /compact every 15 turns',
        actionSnippet: '/compact',
        status: 'open',
        score: 80,
      },
    ];
    upsertRecommendations(db, recs);

    // Generate weekly report
    const report = generateWeeklyReport(db, '2026-W42', tmp);

    assert.equal(report.data.week, '2026-W42');
    assert.equal(report.data.summary.totalTokens, 25_000);
    assert.equal(report.data.summary.activeSessions, 2);
    assert.equal(report.data.summary.tokensDeltaPct, -50);

    // Quota insights
    assert.equal(report.data.quotaInsights.fiveHourPeakPct, 85);
    assert.equal(report.data.quotaInsights.sevenDayPeakPct, 40);

    // Top actions
    assert.equal(report.data.topActions.length, 1);
    assert.equal(report.data.topActions[0].title, 'Compact conversation context');

    // Section headers in Markdown
    assert.ok(report.markdown.includes('# agentlens Weekly Usage Report: 2026-W42'));
    assert.ok(report.markdown.includes('## 1. Week-over-Week Trends'));
    assert.ok(report.markdown.includes('## 2. Quota Near-Misses & Limit Hits'));
    assert.ok(report.markdown.includes('## 3. Biggest Token-Wasting Patterns'));
    assert.ok(report.markdown.includes('## 4. Recommendation Status'));
    assert.ok(report.markdown.includes('## 5. Tool Picks & Optimizations'));
    assert.ok(report.markdown.includes('## 6. Top Three Actions for Next Week'));

    // HTML validation
    assert.ok(report.html.includes('<!DOCTYPE html>'));
    assert.ok(report.html.includes('2026-W42'));
    assert.ok(report.html.includes('prefers-color-scheme'));
    assert.ok(report.html.includes('<h2>5. Tool Picks & Optimizations</h2>'));
    assert.ok(report.html.includes('<h2>6. Top Three Actions for Next Week</h2>'));

    // Files written to disk
    assert.ok(existsSync(report.filePathMd));
    assert.ok(existsSync(report.filePathHtml));
    assert.equal(readFileSync(report.filePathMd, 'utf-8'), report.markdown);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('generateWeeklyReport deduplicates topActions when multiple findings share rule', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-report-dedup-test-'));
  try {
    const db = openDb(':memory:');
    const projId = upsertProject(db, '/test/proj', 'test-proj');

    // Multiple findings with rule 'context_growth'
    upsertFindings(db, [
      {
        id: 'f1',
        rule: 'context_growth',
        projectId: projId,
        sessionId: 's1',
        evidence: '{}',
        confidence: 'high',
        confidenceReason: 'test',
        estTokensWeek: 50_000,
        firstSeen: 1_700_000_000_000,
        lastSeen: 1_700_000_000_000,
      },
      {
        id: 'f2',
        rule: 'context_growth',
        projectId: projId,
        sessionId: 's2',
        evidence: '{}',
        confidence: 'high',
        confidenceReason: 'test',
        estTokensWeek: 40_000,
        firstSeen: 1_700_000_000_000,
        lastSeen: 1_700_000_000_000,
      },
      {
        id: 'f3',
        rule: 'context_growth',
        projectId: projId,
        sessionId: 's3',
        evidence: '{}',
        confidence: 'high',
        confidenceReason: 'test',
        estTokensWeek: 30_000,
        firstSeen: 1_700_000_000_000,
        lastSeen: 1_700_000_000_000,
      },
    ]);

    upsertRecommendations(db, [
      {
        id: 'r1',
        findingRule: 'context_growth',
        projectId: projId,
        action: 'improve',
        title: 'Compact context',
        body: 'Run /compact',
        status: 'open',
        score: 100,
      },
      {
        id: 'r2',
        findingRule: 'retry_loop',
        projectId: projId,
        action: 'remove',
        title: 'Fix tool error loop',
        body: 'Check tool errors',
        status: 'open',
        score: 80,
      },
      {
        id: 'r3',
        findingRule: 'hot_files',
        projectId: projId,
        action: 'improve',
        title: 'Extract hot files',
        body: 'Extract repetitive files',
        status: 'open',
        score: 60,
      },
    ]);

    const report = generateWeeklyReport(db, '2026-W42', tmp);
    assert.equal(report.data.topActions.length, 3);
    const titles = report.data.topActions.map((a) => a.title);
    assert.deepEqual(titles, ['Compact context', 'Fix tool error loop', 'Extract hot files']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('getIsoWeekBounds throws on invalid week numbers (< 1 or > 53)', () => {
  assert.throws(() => getIsoWeekBounds('2026-W00'), /Invalid ISO week number/);
  assert.throws(() => getIsoWeekBounds('2026-W54'), /Invalid ISO week number/);
});
