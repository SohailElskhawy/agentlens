import type { DB } from '../db.ts';
import { upsertFindings } from '../db.ts';
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

export function runDetectors(db: DB, options?: { sessionId?: string; projectId?: number }): Finding[] {
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
  ];

  if (findings.length > 0) {
    upsertFindings(db, findings);
  }

  return findings;
}
