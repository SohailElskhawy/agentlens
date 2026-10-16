import type { Finding } from '../types.ts';
import type { UsageResultItem } from './usage.ts';

export function detectDuplicates(items: UsageResultItem[]): {
  items: UsageResultItem[];
  findings: Finding[];
} {
  const findings: Finding[] = [];
  const now = Date.now();
  const updatedItems = items.map((item) => ({ ...item }));

  // Helper to process a group of duplicate candidates
  const processGroup = (groupKey: string, list: UsageResultItem[], reasonPrefix: string) => {
    if (list.length < 2) return;

    // Sort to determine primary instance:
    // 1. Highest invocations in 30d
    // 2. Project-scoped override (projectId !== null)
    // 3. Lowest sourcePath length (shorter/cleaner path)
    const sorted = [...list].sort((a, b) => {
      if (b.invocations30d !== a.invocations30d) {
        return b.invocations30d - a.invocations30d;
      }
      if ((a.projectId !== null) !== (b.projectId !== null)) {
        return a.projectId !== null ? -1 : 1;
      }
      return a.sourcePath.localeCompare(b.sourcePath);
    });

    const primary = sorted[0];
    const redundant = sorted.slice(1);

    // Keep primary item's original status (active or unused)
    // Mark secondary redundant items as 'duplicate'
    for (const r of redundant) {
      const match = updatedItems.find((i) => i.sourcePath === r.sourcePath && i.name === r.name);
      if (match) {
        match.status = 'duplicate';
      }
    }

    const agents = Array.from(new Set(list.map((i) => i.agent)));
    findings.push({
      id: `duplicate_config:${groupKey}`,
      rule: 'duplicate_config',
      projectId: primary.projectId,
      sessionId: null,
      evidence: {
        name: primary.name,
        kind: primary.kind,
        primarySource: {
          agent: primary.agent,
          sourcePath: primary.sourcePath,
          projectId: primary.projectId,
          invocations30d: primary.invocations30d,
        },
        redundantSources: redundant.map((s) => ({
          agent: s.agent,
          sourcePath: s.sourcePath,
          projectId: s.projectId,
        })),
        sources: list.map((s) => ({
          agent: s.agent,
          sourcePath: s.sourcePath,
          projectId: s.projectId,
        })),
      },
      confidence: 'high',
      confidenceReason: `${reasonPrefix} '${primary.name}' is defined in multiple locations (${agents.join(', ')}). Primary is ${primary.sourcePath}`,
      estTokensWeek: redundant.reduce((sum, r) => sum + r.tokens, 0),
      firstSeen: now,
      lastSeen: now,
    });
  };

  // 1. Same agent + same kind + same name (Spec 5.3: multiple sources in one agent)
  const agentGroups = new Map<string, UsageResultItem[]>();
  for (const item of updatedItems) {
    if (item.kind === 'instruction') continue;
    const key = `${item.agent}:${item.kind}:${item.name.toLowerCase()}`;
    const l = agentGroups.get(key) ?? [];
    l.push(item);
    agentGroups.set(key, l);
  }
  for (const [key, list] of agentGroups) {
    const [agent, kind] = key.split(':');
    processGroup(
      `${agent}:${kind}:${list[0].name}`,
      list,
      `${agent.toUpperCase()} ${kind.toUpperCase()}`
    );
  }

  // 2. Identical content hashes across skills (Spec 5.3: identical content hashes)
  const hashGroups = new Map<string, UsageResultItem[]>();
  for (const item of updatedItems) {
    if (item.kind === 'skill' && item.details?.contentHash) {
      const hash = item.details.contentHash;
      const l = hashGroups.get(hash) ?? [];
      l.push(item);
      hashGroups.set(hash, l);
    }
  }
  for (const [hash, list] of hashGroups) {
    // Only flag if items belong to different agents and were not already grouped by agent
    const distinctAgents = new Set(list.map((i) => i.agent));
    if (distinctAgents.size > 1) {
      processGroup(
        `hash:${hash.slice(0, 12)}`,
        list,
        `Identical skill content (hash ${hash.slice(0, 8)})`
      );
    }
  }

  return { items: updatedItems, findings };
}
