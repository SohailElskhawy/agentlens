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
  // Not measurable: prompts aren't stored. Null marks the metric unavailable
  // (older persisted results carried a hardcoded 0 — read them tolerantly).
  correctionRate: number | null;
  avgTurnsPerSession: number;
  tokensPer1kOutput: number | null;
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
  // Workload-normalized totals (includes cache_write); observational only.
  // These describe before/after movement, not a causal savings claim:
  // task mix, model/agent change and output scale are not controlled.
  tokensPerSessionBefore: number;
  tokensPerSessionAfter: number;
  // Tokens per 1000 output tokens; null when the window has no output tokens
  tokensPer1kOutputBefore: number | null;
  tokensPer1kOutputAfter: number | null;
  guardrails: {
    toolErrorRateDelta: number;
    correctionRateDelta: number | null;
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
      correctionRate: null,
      avgTurnsPerSession: 0,
      tokensPer1kOutput: null,
    };
  }

  const rows = db.prepare(`
    SELECT
      e.kind,
      sum(e.input) AS input,
      sum(e.output) AS output,
      sum(e.cache_read) AS cache_read,
      sum(e.cache_write) AS cache_write,
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
  let totalCacheWrite = 0;
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
      totalCacheWrite += r.cache_write || 0;
    } else if (r.kind === 'tool_call') {
      totalToolCalls += r.cnt;
      errorToolCalls += r.err_cnt;
    }
  }

  // Totals include cache_write once, matching queries.ts/savings.ts token math
  const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;
  const turns = Math.max(1, totalTurns);

  return {
    sessionCount,
    totalTokens,
    avgTokensPerSession: Math.round(totalTokens / sessionCount),
    avgTokensPerTurn: Math.round(totalTokens / turns),
    toolCallsPerSession: Number((totalToolCalls / sessionCount).toFixed(2)),
    uncachedRatio: totalInput + totalCacheRead > 0
      ? Number((totalInput / (totalInput + totalCacheRead)).toFixed(4))
      : 0,
    toolErrorRate: totalToolCalls > 0 ? Number((errorToolCalls / totalToolCalls).toFixed(4)) : 0,
    // Privacy-first note: prompt text is not stored; no correction heuristic exists yet
    correctionRate: null,
    avgTurnsPerSession: Number((totalTurns / sessionCount).toFixed(2)),
    tokensPer1kOutput: totalOutput > 0 ? Math.round(totalTokens / totalOutput * 1000) : null,
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

    // Quality guardrails check: error rates or turns must not worsen by > 10%.
    // correctionRate is unavailable (no measurable signal) and does not participate.
    const toolErrorRateDelta = Number(((current.toolErrorRate - baseline.toolErrorRate) * 100).toFixed(1));
    const turnsDeltaPct = baseline.avgTurnsPerSession > 0
      ? Number((((current.avgTurnsPerSession - baseline.avgTurnsPerSession) / baseline.avgTurnsPerSession) * 100).toFixed(1))
      : 0;

    const toolErrorOk = current.toolErrorRate <= Math.max(0.05, baseline.toolErrorRate * 1.10);
    const turnsOk = current.avgTurnsPerSession <= Math.max(1, baseline.avgTurnsPerSession * 1.10);
    const guardrailsPassed = toolErrorOk && turnsOk;

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
      tokensPerSessionBefore: baseline.avgTokensPerSession,
      tokensPerSessionAfter: current.avgTokensPerSession,
      tokensPer1kOutputBefore: baseline.tokensPer1kOutput,
      tokensPer1kOutputAfter: current.tokensPer1kOutput,
      guardrails: {
        toolErrorRateDelta,
        correctionRateDelta: null, // unavailable (no measurable correction signal)
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
