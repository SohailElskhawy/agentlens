import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import type { DB } from '../db.ts';
import { tx, upsertAuditItems, upsertFindings } from '../db.ts';
import { calibrateFindings, capStoredFindings, loadScopeBudgets } from '../analyze/calibration.ts';
import { refreshRecommendations } from '../recommend.ts';
import { isTempProject } from '../temp-project.ts';
import type { AuditItem, Finding } from '../types.ts';
import { analyzeOverhead } from './overhead.ts';
import { analyzeUsage } from './usage.ts';
import { detectDuplicates } from './duplicates.ts';
import { detectConflicts } from './conflicts.ts';
import { trimInstructions, type InstructionTrimmerResult } from './trimmer.ts';
import { scanInstructions } from './scanners/instruction.ts';
import { scanMcp } from './scanners/mcp.ts';
import { scanSkills } from './scanners/skill.ts';
import { scanPlugins } from './scanners/plugin.ts';

export function runAudit(
  db: DB,
  home?: string
): { items: AuditItem[]; findings: Finding[]; trimmings: InstructionTrimmerResult[] } {
  const userHome = home || homedir();
  const now = Date.now();

  let projects: { id: number; root: string; name: string }[] = [];
  try {
    projects = db.prepare('SELECT id, root, name FROM projects').all() as {
      id: number;
      root: string;
      name: string;
    }[];
  } catch {}

  projects = projects.filter((p) => !isTempProject(p.root));

  // 1. Run all scanners
  const instructions = scanInstructions(userHome, projects);
  const mcps = scanMcp(userHome, projects);
  const skills = scanSkills(userHome, projects);
  const plugins = scanPlugins(userHome, projects);
  const allRaw = [...instructions, ...mcps, ...skills, ...plugins];

  // 2. Run analyzers
  const overheadResult = analyzeOverhead(instructions, db, projects);
  const usageResult = analyzeUsage(allRaw, db, userHome);
  const dupResult = detectDuplicates(usageResult.items);
  const conflictResult = detectConflicts(dupResult.items, projects);
  const trimmings = trimInstructions(instructions, projects);

  const trimmingsMap = new Map<string, InstructionTrimmerResult>();
  for (const t of trimmings) trimmingsMap.set(t.filePath, t);

  // 3. Assemble findings
  const findings: Finding[] = [
    ...overheadResult.findings,
    ...usageResult.findings,
    ...dupResult.findings,
    ...conflictResult.findings,
  ];

  // 4. Assemble AuditItems with unique IDs per source path
  const auditItems: AuditItem[] = conflictResult.items.map((item) => {
    const pathSlug = createHash('sha256').update(item.sourcePath).digest('hex').slice(0, 8);
    const id = `audit:${item.kind}:${item.agent}:${item.projectId ?? 'global'}:${item.name}:${pathSlug}`;
    const trim = trimmingsMap.get(item.sourcePath);
    const details = { ...item.details };
    if (trim) details.trimming = trim;

    return {
      id,
      agent: item.agent,
      projectId: item.projectId,
      kind: item.kind,
      name: item.name,
      sourcePath: item.sourcePath,
      tokens: item.tokens,
      invocations30d: item.invocations30d,
      lastInvoked: item.lastInvoked,
      status: item.status,
      details,
      updatedAt: now,
    };
  });

  // 5. Persist to DB and prune obsolete items
  const budgets = loadScopeBudgets(db, now);
  calibrateFindings(findings, budgets);
  if (auditItems.length > 0) {
    upsertAuditItems(db, auditItems);
    db.prepare('DELETE FROM audit_items WHERE updated_at < ?').run(now);
  }
  tx(db, () => {
    if (findings.length > 0) {
      upsertFindings(db, findings);
      const auditRules = ['instruction_bloat', 'unused_config', 'duplicate_config', 'config_conflict'];
      db.prepare(`DELETE FROM findings WHERE rule IN ('${auditRules.join("','")}') AND last_seen < ?`).run(now);
    }
    capStoredFindings(db, budgets);
  });

  // Update recommendations with newly discovered findings
  try {
    refreshRecommendations(db);
  } catch {}

  return { items: auditItems, findings, trimmings };
}
