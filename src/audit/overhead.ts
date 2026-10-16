import type { DB } from '../db.ts';
import { INSTRUCTION_OVERHEAD_THRESHOLD } from './constants.ts';
import type { Agent, Finding, RawConfigItem } from '../types.ts';

const AGENTS: Agent[] = ['claude', 'codex', 'opencode', 'antigravity'];

export function analyzeOverhead(
  instructions: RawConfigItem[],
  db: DB,
  projects: { id: number; root: string; name: string }[]
): { findings: Finding[] } {
  const findings: Finding[] = [];
  const now = Date.now();
  const weekAgo = now - 7 * 86_400_000;

  // Filter to core always-loaded instructions (exclude arbitrary docs)
  const coreInstructions = instructions.filter((i) => !i.details?.isDoc);

  // Per-project overhead analysis, evaluated PER AGENT
  for (const p of projects) {
    // Estimate sessions per week for this project
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

    for (const agent of AGENTS) {
      const agentFiles = coreInstructions.filter(
        (i) => (i.agent === agent || i.agent === 'all') && (i.projectId === p.id || i.projectId === null)
      );
      const totalFixed = agentFiles.reduce((sum, i) => sum + i.tokens, 0);
      const weeklyTax = totalFixed * weeklySessions;

      if (totalFixed > INSTRUCTION_OVERHEAD_THRESHOLD) {
        findings.push({
          id: `instruction_bloat:${agent}:proj_${p.id}`,
          rule: 'instruction_bloat',
          projectId: p.id,
          sessionId: null,
          evidence: {
            agent,
            projectName: p.name,
            fixedTokens: totalFixed,
            weeklySessions,
            files: agentFiles.map((f) => ({
              name: f.name,
              agent: f.agent,
              tokens: f.tokens,
              path: f.sourcePath,
            })),
          },
          confidence: 'high',
          confidenceReason: `${agent.toUpperCase()} always-loaded instructions consume ${totalFixed.toLocaleString()} tokens per session in ${p.name} (~${Math.round(weeklyTax / 1000)}k tokens/wk across ${weeklySessions} sessions)`,
          estTokensWeek: weeklyTax,
          firstSeen: now,
          lastSeen: now,
        });
      }
    }
  }

  // If no projects exist, evaluate global instructions per agent
  if (projects.length === 0) {
    for (const agent of AGENTS) {
      const globalAgentFiles = coreInstructions.filter(
        (i) => (i.agent === agent || i.agent === 'all') && i.projectId === null
      );
      const globalTokens = globalAgentFiles.reduce((sum, i) => sum + i.tokens, 0);

      if (globalTokens > INSTRUCTION_OVERHEAD_THRESHOLD) {
        findings.push({
          id: `instruction_bloat:${agent}:global`,
          rule: 'instruction_bloat',
          projectId: null,
          sessionId: null,
          evidence: {
            agent,
            fixedTokens: globalTokens,
            files: globalAgentFiles.map((f) => ({
              name: f.name,
              agent: f.agent,
              tokens: f.tokens,
              path: f.sourcePath,
            })),
          },
          confidence: 'high',
          confidenceReason: `Global ${agent.toUpperCase()} instruction files consume ${globalTokens.toLocaleString()} tokens per session`,
          estTokensWeek: globalTokens * 5,
          firstSeen: now,
          lastSeen: now,
        });
      }
    }
  }

  return { findings };
}
