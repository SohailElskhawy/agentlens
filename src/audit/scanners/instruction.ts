import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CHARS_PER_TOKEN } from '../constants.ts';
import type { Agent, RawConfigItem } from '../../types.ts';

function fileItem(
  agent: Agent | 'all',
  projectId: number | null,
  filePath: string,
  customName?: string
): RawConfigItem | null {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
    const content = readFileSync(filePath, 'utf-8');
    const tokens = Math.ceil(content.length / CHARS_PER_TOKEN);
    return {
      agent,
      projectId,
      kind: 'instruction',
      name: customName ?? basename(filePath),
      sourcePath: filePath,
      tokens,
      details: {
        chars: content.length,
        lines: content.split('\n').length,
      },
    };
  } catch {
    return null;
  }
}

function scanDirMarkdown(
  dir: string,
  agent: Agent | 'all',
  projectId: number | null
): RawConfigItem[] {
  const items: RawConfigItem[] = [];
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return items;
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.md')) {
        const item = fileItem(agent, projectId, join(dir, name));
        if (item) items.push(item);
      }
    }
  } catch {}
  return items;
}

export function scanInstructions(
  home: string,
  projects: { id: number; root: string; name: string }[]
): RawConfigItem[] {
  const items: RawConfigItem[] = [];

  // Global instructions
  const globalTargets: [Agent, string][] = [
    ['claude', join(home, '.claude/CLAUDE.md')],
    ['codex', join(home, '.codex/AGENTS.md')],
    ['opencode', join(home, '.config/opencode/AGENTS.md')],
    ['antigravity', join(home, '.gemini/GEMINI.md')],
  ];

  for (const [agent, path] of globalTargets) {
    const item = fileItem(agent, null, path);
    if (item) items.push(item);
  }

  // Global Claude rules
  items.push(...scanDirMarkdown(join(home, '.claude/rules'), 'claude', null));

  // Per-project instructions
  for (const p of projects) {
    // Project root instruction files
    const pTargets: [Agent | 'all', string][] = [
      ['claude', join(p.root, 'CLAUDE.md')],
      ['claude', join(p.root, '.claude/CLAUDE.md')],
      ['codex', join(p.root, 'AGENTS.md')],
      ['codex', join(p.root, '.codex/AGENTS.md')],
      ['antigravity', join(p.root, 'GEMINI.md')],
      ['antigravity', join(p.root, '.gemini/GEMINI.md')],
    ];

    for (const [agent, path] of pTargets) {
      const item = fileItem(agent, p.id, path);
      if (item) items.push(item);
    }

    // Project rules
    items.push(...scanDirMarkdown(join(p.root, '.claude/rules'), 'claude', p.id));

    // Project docs
    items.push(...scanDirMarkdown(join(p.root, 'docs'), 'all', p.id));
  }

  return items;
}
