import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CHARS_PER_TOKEN } from '../constants.ts';
import type { Agent, RawConfigItem } from '../../types.ts';

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  if (!content.startsWith('---')) return {};
  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return {};
  const front = content.slice(3, endIdx);
  const nameMatch = front.match(/^name:\s*(.+)$/m);
  const descMatch = front.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim() : undefined,
    description: descMatch ? descMatch[1].trim() : undefined,
  };
}

function scanSkillDir(
  dir: string,
  agent: Agent,
  projectId: number | null
): RawConfigItem[] {
  const items: RawConfigItem[] = [];
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return items;
    for (const sub of readdirSync(dir)) {
      if (sub === '.system') continue;
      const subPath = join(dir, sub);
      if (!statSync(subPath).isDirectory()) continue;

      const skillMd = join(subPath, 'SKILL.md');
      if (existsSync(skillMd) && statSync(skillMd).isFile()) {
        const content = readFileSync(skillMd, 'utf-8');
        const meta = parseSkillFrontmatter(content);
        const tokens = Math.ceil(content.length / CHARS_PER_TOKEN);
        const contentHash = createHash('sha256').update(content).digest('hex');
        items.push({
          agent,
          projectId,
          kind: 'skill',
          name: meta.name || sub,
          sourcePath: skillMd,
          tokens,
          details: {
            description: meta.description,
            chars: content.length,
            contentHash,
          },
        });
      }
    }
  } catch {}
  return items;
}

export function scanSkills(
  home: string,
  projects: { id: number; root: string; name: string }[]
): RawConfigItem[] {
  const items: RawConfigItem[] = [];

  // Global skills
  items.push(...scanSkillDir(join(home, '.claude/skills'), 'claude', null));
  items.push(...scanSkillDir(join(home, '.codex/skills'), 'codex', null));
  items.push(...scanSkillDir(join(home, '.config/opencode/skills'), 'opencode', null));
  items.push(...scanSkillDir(join(home, '.gemini/config/skills'), 'antigravity', null));
  items.push(...scanSkillDir(join(home, '.gemini/config/plugins/superpowers/skills'), 'antigravity', null));

  // Per-project skills
  for (const p of projects) {
    items.push(...scanSkillDir(join(p.root, '.claude/skills'), 'claude', p.id));
    items.push(...scanSkillDir(join(p.root, '.codex/skills'), 'codex', p.id));
    items.push(...scanSkillDir(join(p.root, '.gemini/skills'), 'antigravity', p.id));
  }

  return items;
}
