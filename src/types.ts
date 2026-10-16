export type Agent = 'claude' | 'codex' | 'opencode' | 'antigravity';
export type EventKind = 'user' | 'assistant' | 'tool_call' | 'tool_result';

export interface NormalizedEvent {
  id: string;            // globally unique; re-ingesting the same id merges (per-field MAX) instead of duplicating
  agent: Agent;
  sessionId: string;
  ts: number;            // epoch ms
  kind: EventKind;
  model?: string;
  input?: number;        // uncached input tokens
  output?: number;       // output tokens, reasoning included
  cacheRead?: number;
  cacheWrite?: number;   // all cache writes
  cacheWrite1h?: number; // subset of cacheWrite billed at the 1-hour rate
  reasoning?: number;    // informational subset of output
  tool?: string;
  argsHash?: string;
  resultBytes?: number;
  isError?: boolean;
  textHash?: string;     // prompt text is never stored, only hash + length
  textLen?: number;
}

export interface SessionInfo { id: string; agent: Agent; cwd?: string; parentId?: string }

export interface QuotaSnapshot {
  agent: Agent;
  ts: number;
  window: '5h' | '7d';
  usedPct: number;
  resetsAt: number;      // epoch ms
  source: string;
}

export interface Cursor { offset: number; state: Record<string, string> }

export interface ReadResult {
  events: NormalizedEvent[];
  sessions: SessionInfo[];
  quotas: QuotaSnapshot[];
  cursor: Cursor;
  errors: number;        // lines that failed to parse and were skipped
  skipped: number;       // lines over the size cap, dropped un-parsed (pastes and outputs; no tokens live there)
}

export interface Adapter {
  agent: Agent;
  root(home: string): string;          // directory to watch
  discover(root: string): string[];    // absolute file paths to ingest
  read(path: string, cursor: Cursor): ReadResult;
}

export interface Filter { from?: number; to?: number; agent?: string; projectId?: number }

export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type ActionType = 'add' | 'remove' | 'replace' | 'improve';
export type RecommendationStatus = 'open' | 'accepted' | 'measuring' | 'verified' | 'no_effect' | 'regressed' | 'dismissed';

export interface Finding {
  id: string;
  rule: string;
  projectId: number | null;
  sessionId: string | null;
  evidence: any;
  confidence: ConfidenceLevel;
  confidenceReason: string;
  estTokensWeek: number;
  firstSeen: number;
  lastSeen: number;
}

export interface Recommendation {
  id: string;
  findingRule: string;
  projectId: number | null;
  action: ActionType;
  title: string;
  body: string;
  actionSnippet?: string;
  catalogRef?: string;
  status: RecommendationStatus;
  acceptedAt?: number;
  result?: any;
  score?: number;
}
