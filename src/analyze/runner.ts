import type { DB } from '../db.ts';
import { upsertFindings } from '../db.ts';
import type { Finding } from '../types.ts';
import { detectHotFiles } from './hot_files.ts';
import { detectLargeToolOutput } from './large_tool_output.ts';
import { detectRetryLoops } from './retry_loop.ts';

export function runDetectors(db: DB, options?: { sessionId?: string; projectId?: number }): Finding[] {
  const findings: Finding[] = [
    ...detectRetryLoops(db, options),
    ...detectHotFiles(db, options),
    ...detectLargeToolOutput(db, options),
  ];

  if (findings.length > 0) {
    upsertFindings(db, findings);
  }

  return findings;
}
