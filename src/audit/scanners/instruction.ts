import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { getOpenCodeConfigRoots } from '../../paths.ts';
import { CHARS_PER_TOKEN } from '../constants.ts';
import type { Agent, RawConfigItem } from '../../types.ts';

export type InstructionItem = RawConfigItem & { path: string };

function fileItem(
  agent: Agent | 'all',
  projectId: number | null,
  filePath: string,
  customName?: string
): InstructionItem | null {
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
      path: filePath,
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
  projectId: number | null,
  isDoc = false
): InstructionItem[] {
  const items: InstructionItem[] = [];
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return items;
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.md')) {
        const item = fileItem(agent, projectId, join(dir, name));
        if (item) {
          if (isDoc) item.details.isDoc = true;
          items.push(item);
        }
      }
    }
  } catch {}
  return items;
}

export function scanInstructions(
  arg1: string | { id: number; root: string; name: string }[],
  arg2?: string | { id: number; root: string; name: string }[]
): InstructionItem[] {
  let home: string;
  let projects: { id: number; root: string; name: string }[];
  if (typeof arg1 === 'string') {
    home = arg1;
    projects = Array.isArray(arg2) ? arg2 : [];
  } else {
    projects = Array.isArray(arg1) ? arg1 : [];
    home = typeof arg2 === 'string' ? arg2 : homedir();
  }

  const items: InstructionItem[] = [];

  // Global instructions
  const globalTargets: [Agent, string][] = [
    ['claude', join(home, '.claude/CLAUDE.md')],
    ['codex', join(home, '.codex/AGENTS.md')],
    ['antigravity', join(home, '.gemini/GEMINI.md')],
  ];

  for (const [agent, path] of globalTargets) {
    const item = fileItem(agent, null, path);
    if (item) items.push(item);
  }

  // OpenCode AGENTS.md across candidate config roots
  const opencodeRoots = getOpenCodeConfigRoots(home);
  for (const root of opencodeRoots) {
    const agentsPath = join(root, 'AGENTS.md');
    const item = fileItem('opencode', null, agentsPath);
    if (item) {
      items.push(item);
      break;
    }
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

    // Project docs (marked isDoc so they are not counted as always-loaded core instructions)
    items.push(...scanDirMarkdown(join(p.root, 'docs'), 'all', p.id, true));
  }

  return items;
}
