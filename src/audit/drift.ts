import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Finding } from '../types.ts';
import type { InstructionItem } from './scanners/instruction.ts';

// shortcut: skip files over 64 KiB rather than inspect partial instructions; raise the bound if needed.
function readBounded(root: string, path: string): string | null {
  const parts = relative(root, path).split('/');
  if (parts.some(part => !part || part === '..' || part === '.')) return null;
  let current = root;
  try {
    for (const part of parts) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) return null;
    }
  } catch { return null; }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65_536) return null;
    return readFileSync(fd, 'utf8');
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

// A symlink or inaccessible component is unknown, not evidence of a missing file.
function missing(root: string, path: string): boolean {
  let current = root;
  for (const part of path.replace(/^\.\//, '').split('/')) {
    if (!part || part === '.' || part === '..') return false;
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  }
  return false;
}

export function detectDrift(items: InstructionItem[], projects: { id: number; root: string; name: string }[]): Finding[] {
  const findings: Finding[] = [];
  const now = Date.now();
  for (const project of projects) {
    let scripts: Record<string, unknown> | null = null;
    try {
      const pkg = JSON.parse(readBounded(project.root, join(project.root, 'package.json')) ?? 'null');
      if (pkg && typeof pkg === 'object' && !Array.isArray(pkg) && (pkg.scripts === undefined || (pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)))) scripts = pkg.scripts ?? {};
    } catch {}
    const refs: { kind: string; reference: string; source: string }[] = [];
    for (const item of items) {
      if (item.projectId !== project.id || !['CLAUDE.md', 'AGENTS.md'].includes(item.name)) continue;
      const source = relative(project.root, item.sourcePath);
      if (source.startsWith('..') || resolve(project.root, source) !== item.sourcePath) continue;
      const text = readBounded(project.root, item.sourcePath);
      if (text === null) continue;
      for (const line of text.split('\n')) {
        if (/\b(?:example|examples|e\.g\.|optional|such as)\b/i.test(line)) continue;
        if (scripts) for (const match of line.matchAll(/\bnpm\s+run\s+([\w][\w:.-]*)(?=$|[\s`'";&|)])/g)) {
          if (!Object.hasOwn(scripts, match[1])) refs.push({ kind: 'script', reference: match[1], source });
        }
        // Require backticks or an explicit ./ prefix to avoid treating prose and package names as paths.
        for (const match of line.matchAll(/`([^`]+)`|(?<![\w/])(?<!:)\.\/[\w.-]+(?:\/[\w.-]+)*/g)) {
          const path = match[1] ?? match[0];
          if (!/^(?:\.\/)?[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,12}$/.test(path)) continue;
          if (missing(project.root, path)) refs.push({ kind: 'path', reference: path, source });
        }
      }
    }
    const unique = [...new Map(refs.map(r => [JSON.stringify(r), r])).values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.reference.localeCompare(b.reference) || a.source.localeCompare(b.source));
    if (unique.length) findings.push({ id: `instruction_drift:proj_${project.id}`, rule: 'instruction_drift', projectId: project.id, sessionId: null, evidence: { projectName: project.name, references: unique }, confidence: 'high', confidenceReason: 'Explicit instruction references are missing from the project', estTokensWeek: 0, firstSeen: now, lastSeen: now });
  }
  return findings;
}
