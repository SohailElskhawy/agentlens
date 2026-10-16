import type { DB } from '../db.ts';
import { INSTRUCTION_OVERHEAD_THRESHOLD } from './constants.ts';
import type { Finding, RawConfigItem } from '../types.ts';

export function analyzeOverhead(
  instructions: RawConfigItem[],
  db: DB,
  projects: { id: number; root: string; name: string }[]
): { findings: Finding[] } {
  const findings: Finding[] = [];
  const now = Date.now();
  const weekAgo = now - 7 * 86_400_000;

  const globalInstructions = instructions.filter((i) => i.projectId === null);
  const globalTokens = globalInstructions.reduce((sum, i) => sum + i.tokens, 0);

  // Per-project overhead analysis
  for (const p of projects) {
    const pInstructions = instructions.filter((i) => i.projectId === p.id);
    const pTokens = pInstructions.reduce((sum, i) => sum + i.tokens, 0);
    const totalFixed = globalTokens + pTokens;

    // Estimate sessions per week
    let weeklySessions = 1;
    try {
      const row = db.prepare(`
        SELECT count(DISTINCT s.id) AS count
        FROM sessions s
        JOIN events e ON e.session_id = s.id
        WHERE s.project_id = ? AND e.ts >= ?
      `).get(p.id, weekAgo) as { count: number } | undefined;
      weeklySessions = Math.max(1, row?.count ?? 1);
    } catch {}

    const weeklyTax = totalFixed * weeklySessions;

    if (totalFixed > INSTRUCTION_OVERHEAD_THRESHOLD) {
      findings.push({
        id: `instruction_bloat:proj_${p.id}`,
        rule: 'instruction_bloat',
        projectId: p.id,
        sessionId: null,
        evidence: {
          projectName: p.name,
          fixedTokens: totalFixed,
          weeklySessions,
          files: [...globalInstructions, ...pInstructions].map((f) => ({
            name: f.name,
            agent: f.agent,
            tokens: f.tokens,
            path: f.sourcePath,
          })),
        },
        confidence: 'high',
        confidenceReason: `Instruction files consume ${totalFixed.toLocaleString()} tokens per session (~${Math.round(weeklyTax / 1000)}k tokens/wk across ${weeklySessions} sessions)`,
        estTokensWeek: weeklyTax,
        firstSeen: now,
        lastSeen: now,
      });
    }
  }

  // If no projects exist, evaluate global instructions alone
  if (projects.length === 0 && globalTokens > INSTRUCTION_OVERHEAD_THRESHOLD) {
    findings.push({
      id: 'instruction_bloat:global',
      rule: 'instruction_bloat',
      projectId: null,
      sessionId: null,
      evidence: {
        fixedTokens: globalTokens,
        files: globalInstructions.map((f) => ({
          name: f.name,
          agent: f.agent,
          tokens: f.tokens,
          path: f.sourcePath,
        })),
      },
      confidence: 'high',
      confidenceReason: `Global instruction files consume ${globalTokens.toLocaleString()} tokens per session`,
      estTokensWeek: globalTokens * 5,
      firstSeen: now,
      lastSeen: now,
    });
  }

  return { findings };
}
