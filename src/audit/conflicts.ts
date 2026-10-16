import { existsSync, readFileSync } from 'node:fs';
import type { Finding } from '../types.ts';
import type { UsageResultItem } from './usage.ts';

export function detectConflicts(
  items: UsageResultItem[],
  projects: { id: number; root: string; name: string }[]
): { items: UsageResultItem[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const now = Date.now();
  const updatedItems = items.map((i) => ({ ...i }));

  for (const p of projects) {
    const pInstructions = updatedItems.filter(
      (i) => i.kind === 'instruction' && i.projectId === p.id
    );
    if (pInstructions.length < 2) continue;

    const managerUsage = new Map<string, string[]>(); // manager -> [sourcePath]

    for (const inst of pInstructions) {
      try {
        if (!existsSync(inst.sourcePath)) continue;
        const text = readFileSync(inst.sourcePath, 'utf-8');

        if (/\bnpm\s+(?:install|i|run|test)\b/i.test(text)) {
          const l = managerUsage.get('npm') ?? [];
          l.push(inst.sourcePath);
          managerUsage.set('npm', l);
        }
        if (/\bpnpm\s+(?:install|i|run|test)\b/i.test(text)) {
          const l = managerUsage.get('pnpm') ?? [];
          l.push(inst.sourcePath);
          managerUsage.set('pnpm', l);
        }
        if (/\byarn\s+(?:install|add|run|test)\b/i.test(text)) {
          const l = managerUsage.get('yarn') ?? [];
          l.push(inst.sourcePath);
          managerUsage.set('yarn', l);
        }
        if (/\bbun\s+(?:install|add|run|test)\b/i.test(text)) {
          const l = managerUsage.get('bun') ?? [];
          l.push(inst.sourcePath);
          managerUsage.set('bun', l);
        }
      } catch {}
    }

    const managers = Array.from(managerUsage.keys());
    if (managers.length > 1) {
      // Conflict detected!
      const conflictingPaths = new Set<string>();
      for (const paths of managerUsage.values()) {
        for (const path of paths) conflictingPaths.add(path);
      }

      for (const item of updatedItems) {
        if (conflictingPaths.has(item.sourcePath)) {
          item.status = 'conflict';
        }
      }

      findings.push({
        id: `config_conflict:pkg_manager:proj_${p.id}`,
        rule: 'config_conflict',
        projectId: p.id,
        sessionId: null,
        evidence: {
          projectName: p.name,
          managers,
          files: Array.from(conflictingPaths),
        },
        confidence: 'medium',
        confidenceReason: `Conflicting package managers specified in project instructions: ${managers.join(', ')}`,
        estTokensWeek: 10_000,
        firstSeen: now,
        lastSeen: now,
      });
    }
  }

  return { items: updatedItems, findings };
}
