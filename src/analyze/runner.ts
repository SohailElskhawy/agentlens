import type { DB } from '../db.ts';
import { tx, upsertFindings } from '../db.ts';
import type { Finding } from '../types.ts';
import { detectCacheMisses } from './cache_miss.ts';
import { detectContextGrowth } from './context_growth.ts';
import { detectHandoffs } from './handoff.ts';
import { detectHotFiles } from './hot_files.ts';
import { detectLargeToolOutput } from './large_tool_output.ts';
import { detectModelFit } from './model_fit.ts';
import { detectQuotaPressure } from './quota_pressure.ts';
import { detectRepeatedPrompts } from './repeated_prompt.ts';
import { detectRetryLoops } from './retry_loop.ts';
import { detectSubagentShare } from './subagent_share.ts';
import { detectCrossAgentBalance } from './cross_agent_balance.ts';
import { detectOutcomeEfficiency, type readGitNumstat } from './outcome_efficiency.ts';
import { detectAbandonedSessions } from './abandoned_session.ts';
import { detectCompactionChurn } from './compaction_churn.ts';
import { detectReasoningOveruse } from './reasoning_overuse.ts';
import { calibrateFindings, capStoredFindings, loadScopeBudgets } from './calibration.ts';

export function runDetectors(db: DB, options?: { sessionId?: string; projectId?: number; now?: number; gitReader?: typeof readGitNumstat }): Finding[] {
  const now = options?.now ?? Date.now();
  const findings: Finding[] = [
    ...detectRetryLoops(db, options),
    ...detectHotFiles(db, options),
    ...detectLargeToolOutput(db, options),
    ...detectContextGrowth(db, options),
    ...detectCacheMisses(db, options),
    ...detectRepeatedPrompts(db, options),
    ...detectModelFit(db, options),
    ...detectHandoffs(db, options),
    ...detectSubagentShare(db, options),
    ...detectQuotaPressure(db),
    ...detectCrossAgentBalance(db, options),
    ...detectOutcomeEfficiency(db, options),
    ...detectAbandonedSessions(db, { ...options, now }),
    ...detectCompactionChurn(db, options),
    ...detectReasoningOveruse(db, options),
  ];

  const budgets = loadScopeBudgets(db, now);
  calibrateFindings(findings, budgets);
  tx(db, () => {
    upsertFindings(db, findings);
    capStoredFindings(db, budgets);
  });

  return findings;
}
