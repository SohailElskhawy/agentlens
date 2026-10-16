import type { DB } from './db.ts';
import type { Recommendation, RecommendationStatus } from './types.ts';

export const TRACKING_WINDOW_MS = 14 * 86_400_000; // 14 days
export const MIN_SAMPLE_SIZE = 5;                  // 5 sessions before & after

export interface MetricBaseline {
  sessionCount: number;
  totalTokens: number;
  avgTokensPerSession: number;
  avgTokensPerTurn: number;
  toolCallsPerSession: number;
  uncachedRatio: number;
  toolErrorRate: number;
  correctionRate: number;
  avgTurnsPerSession: number;
}

export interface TrackingResult {
  rule: string;
  acceptedAt: number;
  windowDays: number;
  sampleBefore: number;
  sampleAfter: number;
  metricName: string;
  baselineVal: number;
  currentVal: number;
  deltaPct: number;
  guardrails: {
    toolErrorRateDelta: number;
    correctionRateDelta: number;
    turnsPerSessionDelta: number;
    passed: boolean;
  };
  verdict: 'insufficient_data' | 'verified' | 'no_effect' | 'regressed';
}

function computeMetrics(db: DB, projectId: number | null, startTs: number, endTs: number): MetricBaseline {
  const params: any[] = [startTs, endTs];
  let projFilter = '';
  if (projectId != null) {
    projFilter = ' AND s.project_id = ?';
    params.push(projectId);
  }

  // Count distinct sessions in window
  const sessionRow = db.prepare(`
    SELECT count(DISTINCT e.session_id) AS cnt
    FROM events e
    LEFT JOIN sessions s ON s.id = e.session_id
    WHERE e.ts >= ? AND e.ts < ?${projFilter}
  `).get(...params) as { cnt: number } | undefined;
  const sessionCount = sessionRow?.cnt ?? 0;

  if (sessionCount === 0) {
    return {
      sessionCount: 0,
      totalTokens: 0,
      avgTokensPerSession: 0,
      avgTokensPerTurn: 0,
      toolCallsPerSession: 0,
      uncachedRatio: 0,
      toolErrorRate: 0,
      correctionRate: 0,
      avgTurnsPerSession: 0,
    };
  }

  const rows = db.prepare(`
    SELECT
      e.kind,
      sum(e.input) AS input,
      sum(e.output) AS output,
      sum(e.cache_read) AS cache_read,
      count(*) AS cnt,
      sum(case when e.is_error = 1 then 1 else 0 end) AS err_cnt
    FROM events e
    LEFT JOIN sessions s ON s.id = e.session_id
    WHERE e.ts >= ? AND e.ts < ?${projFilter}
    GROUP BY e.kind
  `).all(...params) as any[];

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalTurns = 0;
  let totalToolCalls = 0;
  let errorToolCalls = 0;
  let userMessages = 0;

  for (const r of rows) {
    if (r.kind === 'user') {
      userMessages += r.cnt;
      totalTurns += r.cnt;
    } else if (r.kind === 'assistant') {
      totalInput += r.input || 0;
      totalOutput += r.output || 0;
      totalCacheRead += r.cache_read || 0;
    } else if (r.kind === 'tool_call') {
      totalToolCalls += r.cnt;
      errorToolCalls += r.err_cnt;
    }
  }

  const totalTokens = totalInput + totalOutput + totalCacheRead;
  const turns = Math.max(1, totalTurns);
  const toolCalls = Math.max(1, totalToolCalls);
  const users = Math.max(1, userMessages);

  return {
    sessionCount,
    totalTokens,
    avgTokensPerSession: Math.round(totalTokens / sessionCount),
    avgTokensPerTurn: Math.round(totalTokens / turns),
    toolCallsPerSession: Number((totalToolCalls / sessionCount).toFixed(2)),
    uncachedRatio: totalInput + totalCacheRead > 0
      ? Number((totalInput / (totalInput + totalCacheRead)).toFixed(4))
      : 0,
    toolErrorRate: totalToolCalls > 0 ? Number((errorToolCalls / toolCalls).toFixed(4)) : 0,
    // Privacy-first note: prompt text is not stored; correction rate is a reserved
    // metric for future heuristic tracking (e.g., rapid consecutive user prompt turns)
    correctionRate: 0,
    avgTurnsPerSession: Number((totalTurns / sessionCount).toFixed(2)),
  };
}

export function evaluateRecommendations(db: DB, now = Date.now()): Recommendation[] {
  const cutoff = now - TRACKING_WINDOW_MS;
  // Select recommendations in 'accepted' or 'measuring' state, OR any recommendations whose 14-day tracking window is still active
  const candidates = db.prepare(`
    SELECT id, finding_rule AS findingRule, project_id AS projectId, action, title, body, action_snippet AS actionSnippet, catalog_ref AS catalogRef, status, accepted_at AS acceptedAt, result, score
    FROM recommendations
    WHERE accepted_at IS NOT NULL
      AND (
        status IN ('accepted', 'measuring')
        OR (status IN ('verified', 'no_effect', 'regressed') AND accepted_at >= ?)
      )
  `).all(cutoff) as any[];

  const updatedRecs: Recommendation[] = [];

  const updateStmt = db.prepare(`
    UPDATE recommendations
    SET status = ?, result = ?
    WHERE id = ?
  `);

  for (const row of candidates) {
    const acceptedAt = Number(row.acceptedAt);
    const windowMs = TRACKING_WINDOW_MS;
    const beforeStart = acceptedAt - windowMs;
    const beforeEnd = acceptedAt;
    const afterStart = acceptedAt;
    const afterEnd = Math.min(now, acceptedAt + windowMs);

    const baseline = computeMetrics(db, row.projectId, beforeStart, beforeEnd);
    const current = computeMetrics(db, row.projectId, afterStart, afterEnd);

    let metricName = 'avgTokensPerSession';
    let baselineVal = baseline.avgTokensPerSession;
    let currentVal = current.avgTokensPerSession;

    switch (row.findingRule) {
      case 'context_growth':
      case 'instruction_bloat':
        metricName = 'avgTokensPerTurn';
        baselineVal = baseline.avgTokensPerTurn;
        currentVal = current.avgTokensPerTurn;
        break;

      case 'retry_loop':
      case 'hot_files':
        metricName = 'toolCallsPerSession';
        baselineVal = baseline.toolCallsPerSession;
        currentVal = current.toolCallsPerSession;
        break;

      case 'cache_miss':
        metricName = 'uncachedRatio';
        baselineVal = baseline.uncachedRatio;
        currentVal = current.uncachedRatio;
        break;

      default:
        metricName = 'avgTokensPerSession';
        baselineVal = baseline.avgTokensPerSession;
        currentVal = current.avgTokensPerSession;
        break;
    }

    const deltaPct = baselineVal > 0
      ? Number((((currentVal - baselineVal) / baselineVal) * 100).toFixed(1))
      : (currentVal > 0 ? 100 : 0);

    // Quality guardrails check: error rates or turns must not worsen by > 10%
    const toolErrorRateDelta = Number(((current.toolErrorRate - baseline.toolErrorRate) * 100).toFixed(1));
    const correctionRateDelta = Number(((current.correctionRate - baseline.correctionRate) * 100).toFixed(1));
    const turnsDeltaPct = baseline.avgTurnsPerSession > 0
      ? Number((((current.avgTurnsPerSession - baseline.avgTurnsPerSession) / baseline.avgTurnsPerSession) * 100).toFixed(1))
      : 0;

    const toolErrorOk = current.toolErrorRate <= Math.max(0.05, baseline.toolErrorRate * 1.10);
    const correctionOk = current.correctionRate <= Math.max(0.05, baseline.correctionRate * 1.10);
    const turnsOk = current.avgTurnsPerSession <= Math.max(1, baseline.avgTurnsPerSession * 1.10);
    const guardrailsPassed = toolErrorOk && correctionOk && turnsOk;

    let verdict: 'insufficient_data' | 'verified' | 'no_effect' | 'regressed' = 'insufficient_data';
    let newStatus: RecommendationStatus = 'measuring';

    if (baseline.sessionCount < MIN_SAMPLE_SIZE || current.sessionCount < MIN_SAMPLE_SIZE) {
      verdict = 'insufficient_data';
      newStatus = 'measuring';
    } else if (!guardrailsPassed) {
      verdict = 'regressed';
      newStatus = 'regressed';
    } else if (deltaPct <= -10) {
      verdict = 'verified';
      newStatus = 'verified';
    } else if (deltaPct >= 10) {
      verdict = 'regressed';
      newStatus = 'regressed';
    } else {
      verdict = 'no_effect';
      newStatus = 'no_effect';
    }

    const trackingResult: TrackingResult = {
      rule: row.findingRule,
      acceptedAt,
      windowDays: Math.max(1, Math.round((afterEnd - afterStart) / 86_400_000)),
      sampleBefore: baseline.sessionCount,
      sampleAfter: current.sessionCount,
      metricName,
      baselineVal,
      currentVal,
      deltaPct,
      guardrails: {
        toolErrorRateDelta,
        correctionRateDelta,
        turnsPerSessionDelta: turnsDeltaPct,
        passed: guardrailsPassed,
      },
      verdict,
    };

    updateStmt.run(newStatus, JSON.stringify(trackingResult), row.id);

    updatedRecs.push({
      ...row,
      status: newStatus,
      result: trackingResult,
    });
  }

  return updatedRecs;
}
