import type { Finding } from '../types.ts';
import type { UsageResultItem } from './usage.ts';

export function detectDuplicates(items: UsageResultItem[]): {
  items: UsageResultItem[];
  findings: Finding[];
} {
  const findings: Finding[] = [];
  const now = Date.now();

  // Group by (kind, name) for skills, mcps, and plugins
  const groups = new Map<string, UsageResultItem[]>();

  for (const item of items) {
    if (item.kind === 'instruction') continue;
    const key = `${item.kind}:${item.name.toLowerCase()}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  const updatedItems = items.map((item) => ({ ...item }));

  for (const [key, list] of groups) {
    if (list.length > 1) {
      const [kind, name] = key.split(':');
      const agents = Array.from(new Set(list.map((i) => i.agent)));

      // Mark status as duplicate on all but the primary if previously active/unused
      for (const item of updatedItems) {
        if (
          item.kind === kind &&
          item.name.toLowerCase() === name
        ) {
          item.status = 'duplicate';
        }
      }

      findings.push({
        id: `duplicate_config:${kind}:${name}`,
        rule: 'duplicate_config',
        projectId: list[0].projectId,
        sessionId: null,
        evidence: {
          name: list[0].name,
          kind,
          sources: list.map((s) => ({
            agent: s.agent,
            sourcePath: s.sourcePath,
            projectId: s.projectId,
          })),
        },
        confidence: 'high',
        confidenceReason: `${kind.toUpperCase()} '${list[0].name}' is configured across multiple locations (${agents.join(', ')})`,
        estTokensWeek: (list.length - 1) * 1_000,
        firstSeen: now,
        lastSeen: now,
      });
    }
  }

  return { items: updatedItems, findings };
}
