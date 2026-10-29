import { constants, closeSync, existsSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { DB } from './db.ts';
import { MAX_BOUNDED_READ_BYTES } from './ai/constants.ts';
import { projectName as resolveProjectName, projectRoot as resolveProjectRoot } from './project.ts';

export interface HotFileCheatsheet {
  relativePath: string;
  reads: number;
  exports: string[];
}

export interface CheatsheetResult {
  projectId: number | null;
  projectName: string;
  projectRoot: string;
  files: HotFileCheatsheet[];
  markdown: string;
}

function extractFilesFromEvidence(evidence: any): Array<{ file: string; reads: number }> {
  if (!evidence || typeof evidence !== 'object') return [];
  const results: Array<{ file: string; reads: number }> = [];

  const defaultReads =
    typeof evidence.reads === 'number' && !Number.isNaN(evidence.reads) ? evidence.reads : 1;

  if (typeof evidence.file === 'string' && evidence.file.trim()) {
    results.push({ file: evidence.file.trim(), reads: defaultReads });
  }

  if (typeof evidence.target === 'string' && evidence.target.trim()) {
    results.push({ file: evidence.target.trim(), reads: defaultReads });
  }

  if (Array.isArray(evidence.files)) {
    for (const item of evidence.files) {
      if (typeof item === 'string' && item.trim()) {
        results.push({ file: item.trim(), reads: defaultReads });
      } else if (item && typeof item === 'object' && typeof item.file === 'string' && item.file.trim()) {
        const itemReads =
          typeof item.reads === 'number' && !Number.isNaN(item.reads) ? item.reads : defaultReads;
        results.push({ file: item.file.trim(), reads: itemReads });
      }
    }
  } else if (evidence.files && typeof evidence.files === 'object') {
    if (typeof evidence.files.file === 'string' && evidence.files.file.trim()) {
      const itemReads =
        typeof evidence.files.reads === 'number' && !Number.isNaN(evidence.files.reads)
          ? evidence.files.reads
          : defaultReads;
      results.push({ file: evidence.files.file.trim(), reads: itemReads });
    }
  }

  return results;
}

function normalizeCandidatePath(rawPath: string, root: string): string | null {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const trimmed = rawPath.trim();
  const absPath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed);
  const rel = relative(root, absPath);
  if (rel.startsWith('..') || isAbsolute(rel) || !rel || rel === '.') {
    return null;
  }
  return rel.split('\\').join('/');
}

function safeReadFileBounded(absPath: string, root: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(absPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_BOUNDED_READ_BYTES) return null;
    const resolved = realpathSync(absPath);
    const rel = relative(root, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    return readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function isTsJsFile(filePath: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/i.test(filePath);
}

function extractExports(content: string, filePath: string): string[] {
  if (!isTsJsFile(filePath)) return [];

  const exports: string[] = [];
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    if (exports.length >= 12) break;
    const line = rawLine.trim();
    if (!line.startsWith('export')) continue;

    // 1. Function: export (async )?function <name>(...) -> fn <name>(...)
    const fnMatch = /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(line);
    if (fnMatch) {
      const name = fnMatch[1];
      let paramStr = '(...)';
      const parenIdx = line.indexOf('(', fnMatch[0].length);
      if (parenIdx !== -1) {
        let depth = 0;
        let endParen = -1;
        for (let i = parenIdx; i < line.length; i++) {
          if (line[i] === '(') depth++;
          else if (line[i] === ')') {
            depth--;
            if (depth === 0) {
              endParen = i;
              break;
            }
          }
        }
        if (endParen !== -1) {
          paramStr = line.slice(parenIdx, endParen + 1);
        }
      }
      if (paramStr.length > 80) {
        paramStr = paramStr.slice(0, 77) + '...)';
      }
      let decl = `fn ${name}${paramStr}`;
      if (decl.length > 80) {
        decl = decl.slice(0, 80);
      }
      exports.push(decl);
      continue;
    }

    // 2. Interface: export interface <Name> -> interface <Name>
    const ifaceMatch = /^export\s+(?:declare\s+)?interface\s+([A-Za-z0-9_$]+)\b/.exec(line);
    if (ifaceMatch) {
      exports.push(`interface ${ifaceMatch[1]}`);
      continue;
    }

    // 3. Type: export type <Name> -> type <Name>
    const typeMatch = /^export\s+(?:declare\s+)?type\s+([A-Za-z0-9_$]+)\b/.exec(line);
    if (typeMatch) {
      exports.push(`type ${typeMatch[1]}`);
      continue;
    }

    // 4. Const / Let: export const <Name> / export let <Name> -> const <Name>
    const constMatch = /^export\s+(?:declare\s+)?(?:const|let)\s+([A-Za-z0-9_$]+)\b/.exec(line);
    if (constMatch) {
      exports.push(`const ${constMatch[1]}`);
      continue;
    }

    // 5. Class: export class <Name> -> class <Name>
    const classMatch = /^export\s+(?:default\s+)?(?:declare\s+)?class\s+([A-Za-z0-9_$]+)\b/.exec(line);
    if (classMatch) {
      exports.push(`class ${classMatch[1]}`);
      continue;
    }
  }

  return exports;
}

export function formatCheatsheetMarkdown(res: CheatsheetResult): string {
  if (!res.files || res.files.length === 0) {
    return `No hot_files with exported symbols found for ${res.projectName}.`;
  }
  const lines: string[] = [
    `## Architecture Cheat-Sheet (${res.projectName})`,
    `<!-- Generated by agentlens cheatsheet from top hot_files -->`,
  ];
  for (const f of res.files) {
    const formattedExports = f.exports.map((e) => `\`${e}\``).join(', ');
    lines.push(`- \`${f.relativePath}\` (${f.reads} reads): ${formattedExports}`);
  }
  return lines.join('\n');
}

export function generateCheatsheet(
  db: DB,
  opts?: { projectRoot?: string; projectId?: number; top?: number },
): CheatsheetResult {
  let projectId: number | null = opts?.projectId ?? null;
  let root = '';
  let projectName = '';

  if (projectId != null) {
    try {
      const row = db
        .prepare('SELECT id, root, name FROM projects WHERE id = ?')
        .get(projectId) as { id: number; root: string; name: string } | undefined;
      if (row) {
        root = existsSync(row.root) ? realpathSync(row.root) : row.root;
        projectName = row.name;
      }
    } catch {}
  }

  if (!root) {
    const candidate = resolveProjectRoot(resolve(opts?.projectRoot ?? process.cwd()));
    root = candidate;
    try {
      root = realpathSync(candidate);
    } catch {}

    if (projectId == null) {
      try {
        const row = db
          .prepare('SELECT id, name FROM projects WHERE root = ? OR root = ?')
          .get(root, candidate) as { id: number; name: string } | undefined;
        if (row) {
          projectId = row.id;
          projectName = row.name;
        }
      } catch {}
    }

    if (!projectName) {
      projectName = resolveProjectName(root);
    }
  }

  let top = opts?.top !== undefined ? Math.floor(opts.top) : 5;
  if (Number.isNaN(top) || top < 1) top = 1;
  if (top > 20) top = 20;

  let findingsRows: Array<{ evidence: string }> = [];
  try {
    if (projectId != null) {
      findingsRows = db
        .prepare("SELECT evidence FROM findings WHERE project_id = ? AND rule = 'hot_files'")
        .all(projectId) as any;
    } else {
      findingsRows = db
        .prepare("SELECT evidence FROM findings WHERE project_id IS NULL AND rule = 'hot_files'")
        .all() as any;
    }
  } catch {
    findingsRows = [];
  }

  const fileMap = new Map<string, number>();
  for (const row of findingsRows) {
    let evidence: any = {};
    try {
      evidence = JSON.parse(row.evidence || '{}');
    } catch {}
    const items = extractFilesFromEvidence(evidence);
    const seenInFinding = new Map<string, number>();
    for (const item of items) {
      const rel = normalizeCandidatePath(item.file, root);
      if (!rel) continue;
      seenInFinding.set(rel, Math.max(seenInFinding.get(rel) ?? 0, item.reads));
    }
    for (const [rel, reads] of seenInFinding) {
      fileMap.set(rel, (fileMap.get(rel) ?? 0) + reads);
    }
  }

  const sortedCandidates = Array.from(fileMap.entries())
    .map(([relativePath, reads]) => ({ relativePath, reads }))
    .sort((a, b) => {
      if (b.reads !== a.reads) return b.reads - a.reads;
      return a.relativePath.localeCompare(b.relativePath);
    });

  const files: HotFileCheatsheet[] = [];
  for (const cand of sortedCandidates) {
    if (files.length >= top) break;
    const absPath = resolve(root, cand.relativePath);
    const content = safeReadFileBounded(absPath, root);
    if (content === null) continue;

    const exportedDecls = extractExports(content, cand.relativePath);
    if (exportedDecls.length > 0) {
      files.push({
        relativePath: cand.relativePath,
        reads: cand.reads,
        exports: exportedDecls,
      });
    }
  }

  const baseResult = {
    projectId,
    projectName,
    projectRoot: root,
    files,
  };

  return {
    ...baseResult,
    markdown: formatCheatsheetMarkdown({ ...baseResult, markdown: '' }),
  };
}
