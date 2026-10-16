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

export const CONFIDENCE_WEIGHTS = {
  high: 1.0,
  medium: 0.6,
  low: 0.3,
} as const;
