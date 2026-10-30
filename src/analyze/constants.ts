export const RETRY_LOOP_THRESHOLD = 3;
export const HOT_FILE_READ_THRESHOLD = 3;
export const LARGE_TOOL_OUTPUT_BYTES = 50_000; // 50KB
export const CONTEXT_GROWTH_THRESHOLD = 100_000;
export const CACHE_TTL_MS = 300_000; // 5 minutes (Anthropic prompt cache TTL)
export const HANDOFF_WINDOW_MS = 1_800_000; // 30 minutes
export const SUBAGENT_MIN_INPUT = 50_000;
export const SUBAGENT_MAX_OUTPUT = 500;
export const QUOTA_PRESSURE_THRESHOLD = 80.0;
export const CROSS_AGENT_TIGHT_THRESHOLD = 70.0;
export const CROSS_AGENT_HEADROOM_DIFF = 25.0;
export const OUTCOME_EFFICIENCY_TOKENS_PER_COMMIT = 150_000;
export const OUTCOME_EFFICIENCY_TOKENS_PER_LINE = 500;
export const ABANDONED_SESSION_TOKEN_THRESHOLD = 50_000;
export const ABANDONED_SESSION_WINDOW_MS = 1_800_000;
export const COMPACTION_CHURN_THRESHOLD = 3;
export const REASONING_OVERUSE_RATIO = 5.0;
export const REASONING_MIN_TOKENS = 4_000;
export const REASONING_MAX_OUTPUT = 800;

export const CONFIDENCE_WEIGHTS = {
  high: 1.0,
  medium: 0.6,
  low: 0.3,
} as const;

// Weekly estimate calibration (implemented in src/analyze/calibration.ts):
// Every finding's est_tokens_week is capped by the actual trailing-7-day tokens of its scope.
// - Window: [now - CALIBRATION_WINDOW_MS, now], both endpoints inclusive (elapsed time, not calendar buckets).
// - Token components: input + output + cache_read + cache_write summed once per event
//   (cache_write_1h is a subset of cache_write and reasoning a subset of output; never added again).
// - Scope precedence: the finding's session's weekly tokens (sessionId non-null), else its project's
//   (projectId non-null), else the global total. A scope with no events in the window has budget zero;
//   budgets never fall back to a broader scope.
// - Cap formula: est_tokens_week = min(max(0, raw_estimate), scope_budget), applied per finding
//   independently. Overlapping findings may still sum above actual usage and are not realized savings.
// - abandoned_session keeps its lifetime identification, thresholds, evidence and confidence; its weekly
//   estimate is instead its session's trailing-week tokens.
// - Refresh happens on detector or audit runs, not continuously. Stale values only decrease until
//   their producer runs again; previously exported reports are not rewritten.
export const CALIBRATION_WINDOW_MS = 7 * 86_400_000;
