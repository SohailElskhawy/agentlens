import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db.ts';
import { UNUSED_WINDOW_MS } from './constants.ts';
import type { AuditStatus, Finding, RawConfigItem } from '../types.ts';

export interface UsageResultItem extends RawConfigItem {
  invocations30d: number;
  lastInvoked: number | null;
  status: AuditStatus;
}

export function analyzeUsage(
  items: RawConfigItem[],
  db: DB,
  home: string
): { items: UsageResultItem[]; findings: Finding[] } {
  const now = Date.now();
  const thirtyDaysAgo = now - UNUSED_WINDOW_MS;
  const findings: Finding[] = [];

  // Query events in last 30 days
  const toolStats = new Map<string, { count: number; lastTs: number }>();
  try {
    const rows = db.prepare(`
      SELECT tool, count(*) AS count, max(ts) AS last_ts
      FROM events
      WHERE tool IS NOT NULL AND ts >= ?
      GROUP BY tool
    `).all(thirtyDaysAgo) as { tool: string; count: number; last_ts: number }[];

    for (const r of rows) {
      toolStats.set(r.tool.toLowerCase(), { count: r.count, lastTs: r.last_ts });
    }
  } catch {}

  // Read Claude skillUsage and pluginUsage from ~/.claude.json
  const claudeSkillUsage = new Map<string, { count: number; lastTs: number }>();
  const claudePluginUsage = new Map<string, { count: number; lastTs: number }>();
  try {
    const claudeJsonPath = join(home, '.claude.json');
    if (existsSync(claudeJsonPath)) {
      const data = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
      if (data.skillUsage && typeof data.skillUsage === 'object') {
        for (const [key, val] of Object.entries<any>(data.skillUsage)) {
          if (val && typeof val === 'object' && val.usageCount > 0) {
            claudeSkillUsage.set(key.toLowerCase(), {
              count: val.usageCount,
              lastTs: val.lastUsedAt ?? now,
            });
          }
        }
      }
      if (data.pluginUsage && typeof data.pluginUsage === 'object') {
        for (const [key, val] of Object.entries<any>(data.pluginUsage)) {
          if (val && typeof val === 'object' && val.usageCount > 0) {
            claudePluginUsage.set(key.toLowerCase(), {
              count: val.usageCount,
              lastTs: val.lastUsedAt ?? now,
            });
          }
        }
      }
    }
  } catch {}

  const resultItems: UsageResultItem[] = [];

  for (const item of items) {
    if (item.kind === 'instruction') {
      resultItems.push({
        ...item,
        invocations30d: 0,
        lastInvoked: null,
        status: 'active',
      });
      continue;
    }

    let invocations = 0;
    let lastInvoked: number | null = null;
    const nameLower = item.name.toLowerCase();

    if (item.kind === 'mcp') {
      const normName = nameLower.replace(/-/g, '_');
      // Check tool calls matching mcp server name
      for (const [toolName, stat] of toolStats) {
        if (
          toolName === nameLower ||
          toolName === normName ||
          toolName.startsWith(`mcp__${nameLower}__`) ||
          toolName.startsWith(`mcp__${normName}__`) ||
          toolName.startsWith(`mcp__claude_ai_${nameLower}__`) ||
          toolName.startsWith(`mcp__claude_ai_${normName}__`) ||
          toolName.startsWith(`mcp_${nameLower}_`) ||
          toolName.startsWith(`mcp_${normName}_`) ||
          toolName.startsWith(`${nameLower}__`) ||
          toolName.startsWith(`${normName}__`)
        ) {
          invocations += stat.count;
          lastInvoked = Math.max(lastInvoked ?? 0, stat.lastTs);
        }
      }
    } else if (item.kind === 'skill') {
      const normName = nameLower.replace(/-/g, '_');
      // Check Claude skill usage cache
      for (const [skillKey, stat] of claudeSkillUsage) {
        if (
          skillKey === nameLower ||
          skillKey === normName ||
          skillKey.endsWith(`:${nameLower}`) ||
          skillKey.endsWith(`:${normName}`)
        ) {
          invocations += stat.count;
          lastInvoked = Math.max(lastInvoked ?? 0, stat.lastTs);
        }
      }
      // Check tool calls
      for (const [toolName, stat] of toolStats) {
        if (
          toolName === nameLower ||
          toolName === normName ||
          toolName === `skill_${nameLower}` ||
          toolName === `skill_${normName}`
        ) {
          invocations += stat.count;
          lastInvoked = Math.max(lastInvoked ?? 0, stat.lastTs);
        }
      }
    } else if (item.kind === 'plugin') {
      const normName = nameLower.replace(/-/g, '_');
      for (const [pluginKey, stat] of claudePluginUsage) {
        if (
          pluginKey === nameLower ||
          pluginKey === normName ||
          pluginKey.startsWith(`${nameLower}@`) ||
          pluginKey.startsWith(`${normName}@`)
        ) {
          invocations += stat.count;
          lastInvoked = Math.max(lastInvoked ?? 0, stat.lastTs);
        }
      }
    }

    const isUnused = invocations === 0;
    const status: 'active' | 'unused' = isUnused ? 'unused' : 'active';

    if (isUnused && (item.kind === 'mcp' || item.kind === 'skill')) {
      findings.push({
        id: `unused_config:${item.kind}:${item.agent}:${item.projectId ?? 'global'}:${item.name}`,
        rule: 'unused_config',
        projectId: item.projectId,
        sessionId: null,
        evidence: {
          name: item.name,
          kind: item.kind,
          agent: item.agent,
          sourcePath: item.sourcePath,
        },
        confidence: 'high',
        confidenceReason: `${item.kind.toUpperCase()} server/tool '${item.name}' had 0 invocations in 30 days`,
        estTokensWeek: item.kind === 'mcp' ? Math.max(1_000, item.tokens * 10) : 0,
        firstSeen: now,
        lastSeen: now,
      });
    }

    resultItems.push({
      ...item,
      invocations30d: invocations,
      lastInvoked,
      status,
    });
  }

  return { items: resultItems, findings };
}
