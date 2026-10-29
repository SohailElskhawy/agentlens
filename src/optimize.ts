import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CHARS_PER_TOKEN } from './audit/constants.ts';
import type { InstructionItem } from './audit/scanners/instruction.ts';
import { MAX_BOUNDED_READ_BYTES } from './ai/constants.ts';
import { trimInstructions, type InstructionTrimmerResult, type TrimmingCut } from './audit/trimmer.ts';
import { getAuditItems, getFindings, type DB } from './db.ts';
import { projectName, projectRoot as resolveProjectRoot } from './project.ts';
import type { Agent, AuditItem } from './types.ts';

export interface IgnoreFileUpdate {
  fileName: '.claudeignore' | '.cursorignore';
  filePath: string;
  existed: boolean;
  existingPatternsCount: number;
  addedPatterns: string[];
  updatedContent: string;
}

export interface OversizedFileWarning {
  relativePath: string;
  bytes: number;
  estTokens: number;
  reason: string;
}

export interface InstructionTrimAction extends InstructionTrimmerResult {
  backupPath: string;
  applied: boolean;
}

export interface WorkspaceOptimizeResult {
  projectId: number | null;
  projectName: string;
  projectRoot: string;
  applied: boolean;
  ignoreFiles: IgnoreFileUpdate[];
  oversizedFiles: OversizedFileWarning[];
  instructionTrims: InstructionTrimAction[];
  unusedItems: AuditItem[];
  duplicateOrConflictItems: AuditItem[];
  estimatedTokensSavedPerTurn: number;
}

const CANDIDATE_NOISE_DIRS = [
  'node_modules',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.turbo',
  '.cache',
  'target',
  'vendor',
  'venv',
  '.venv',
  '__pycache__',
];

const CANDIDATE_LOCKFILES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'composer.lock',
];

const BASELINE_GLOB_IGNORES = [
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.db',
  '*.db-wal',
  '*.db-shm',
  '*.sqlite',
  '*.log',
];

const CORE_INSTRUCTION_FILES = new Set([
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
]);

const OVERSIZED_FILE_BYTES = 40_000; // ~10k tokens

type Snapshot = { path: string; content: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; mode: number };

// Check every existing component without following links, including missing leaf paths.
function checkPath(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw Error(`Path outside project: ${path}`);
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    let st;
    try { st = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (st.isSymbolicLink()) throw Error(`Symlink not allowed: ${current}`);
    if (current !== path && !st.isDirectory()) throw Error(`Not a directory: ${current}`);
  }
}

function snapshot(root: string, path: string): Snapshot | null {
  checkPath(root, path);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_BOUNDED_READ_BYTES) throw Error(`Unsafe or oversized file: ${path}`);
    const bytes = Buffer.alloc(MAX_BOUNDED_READ_BYTES + 1);
    const n = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd), pathStat = lstatSync(path);
    if (n !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs ||
        pathStat.dev !== st.dev || pathStat.ino !== st.ino || pathStat.nlink !== 1) throw Error(`File changed while reading: ${path}`);
    const content = bytes.subarray(0, n).toString('utf8');
    if (!Buffer.from(content).equals(bytes.subarray(0, n))) throw Error(`Invalid UTF-8: ${path}`);
    return { path, content, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, mode: st.mode };
  } finally { closeSync(fd); }
}

function sameSnapshot(a: Snapshot | null, b: Snapshot | null): boolean {
  return a === null ? b === null : b !== null && a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.content === b.content;
}

function safePattern(path: string): boolean {
  if (!path || path !== path.trim() || isAbsolute(path) || /[\\:\x00-\x1f\x7f-\x9f*?!\[\]#]/.test(path)) return false;
  const parts = path.split('/');
  return parts.every(part => part !== '' && part !== '.' && part !== '..' && !CORE_INSTRUCTION_FILES.has(part));
}

function applyCutsToLines(originalLines: string[], cuts: TrimmingCut[]): string[] {
  const newLines = [...originalLines];
  const sortedCuts = [...cuts].sort((a, b) => b.startLine - a.startLine);
  for (const cut of sortedCuts) {
    const s = Math.max(0, cut.startLine - 1);
    const count = cut.endLine - cut.startLine + 1;
    if (cut.replacementText !== undefined) {
      newLines.splice(s, count, cut.replacementText);
    } else {
      newLines.splice(s, count);
    }
  }
  return newLines;
}

function parseExistingIgnoreSet(content: string): Set<string> {
  const set = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    set.add(line);
    // Also normalize trailing slash variants so `dist` matches `dist/`
    if (line.endsWith('/')) set.add(line.slice(0, -1));
    else set.add(`${line}/`);
  }
  return set;
}

export function optimizeWorkspace(
  db: DB,
  options: {
    projectRoot?: string;
    projectId?: number;
    home?: string;
    apply?: boolean;
  } = {}
): WorkspaceOptimizeResult {
  const apply = Boolean(options.apply);
  // Keep the home option for API compatibility; project optimization never scans global files.

  const selectedRoot = options.projectRoot ? resolve(options.projectRoot) : undefined;
  let root = selectedRoot ? resolveProjectRoot(selectedRoot) : undefined;
  if (selectedRoot && root && relative(root, selectedRoot).startsWith('..')) throw Error('Resolved project root is outside the selected project');
  let projId: number | null = options.projectId ?? null;
  let projName = '';

  if (projId != null && !root) {
    const row = db.prepare('SELECT id, root, name FROM projects WHERE id = ?').get(projId) as
      | { id: number; root: string; name: string }
      | undefined;
    if (row) {
      root = row.root;
      projName = row.name;
    }
  }

  if (!root) {
    root = resolveProjectRoot(process.cwd());
  }

  if (projId == null) {
    const row = db.prepare('SELECT id, name FROM projects WHERE root = ?').get(root) as
      | { id: number; name: string }
      | undefined;
    if (row) {
      projId = row.id;
      projName = row.name;
    }
  }

  root = resolve(root);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw Error('Project root must be a canonical directory without symlinks');

  if (!projName) {
    projName = projectName(root);
  }

  const desiredPatterns: string[] = [];
  const oversizedFiles: OversizedFileWarning[] = [];

  // 1. Check present noise directories & lockfiles in project root
  if (existsSync(root)) {
    for (const dir of CANDIDATE_NOISE_DIRS) {
      try {
        const p = join(root, dir);
        if (existsSync(p) && statSync(p).isDirectory()) {
          desiredPatterns.push(`${dir}/`);
        }
      } catch {}
    }

    for (const lock of CANDIDATE_LOCKFILES) {
      try {
        const p = join(root, lock);
        if (existsSync(p) && statSync(p).isFile()) {
          desiredPatterns.push(lock);
        }
      } catch {}
    }

    // Scan root and docs/ directories for oversized state/dump files (> 40 KB)
    const scanDirs: Array<{ dir: string; prefix: string }> = [
      { dir: root, prefix: '' },
      { dir: join(root, 'docs'), prefix: 'docs/' },
    ];
    for (const { dir, prefix } of scanDirs) {
      try {
        checkPath(root, dir);
        if (!existsSync(dir) || !lstatSync(dir).isDirectory()) continue;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          if (entry.name.startsWith('.')) continue;
          if (!prefix && CORE_INSTRUCTION_FILES.has(entry.name)) continue;
          if (!prefix && CANDIDATE_LOCKFILES.includes(entry.name)) continue;

          const extMatch = /\.(md|json|jsonl|csv|sql|txt|xml|yaml|yml|log)$/i.test(entry.name);
          if (!extMatch) continue;

          const fullPath = join(dir, entry.name);
          const relPath = `${prefix}${entry.name}`;
          const st = lstatSync(fullPath);
          if (!st.isFile()) continue;
          if (st.size >= OVERSIZED_FILE_BYTES) {
            const estTokens = Math.ceil(st.size / CHARS_PER_TOKEN);
            oversizedFiles.push({
              relativePath: relPath,
              bytes: st.size,
              estTokens,
              reason: `Oversized workspace file (${Math.round(st.size / 1024)} KB / ~${estTokens.toLocaleString()} tok) slows context & grep scans`,
            });
            if (safePattern(relPath)) desiredPatterns.push(relPath);
          }
        }
      } catch {}
    }
  }

  // 2. Include sampleFiles from large_tool_output findings for this project
  if (projId != null) {
    const findings = getFindings(db, { projectId: projId, rule: 'large_tool_output' });
    for (const f of findings) {
      const sampleFiles = Array.isArray(f.evidence?.sampleFiles) ? f.evidence.sampleFiles : [];
      for (const sf of sampleFiles) {
        if (typeof sf === 'string' && safePattern(sf)) {
          desiredPatterns.push(sf);
        }
      }
    }
  }

  // 3. Add baseline generated/binary globs
  for (const glob of BASELINE_GLOB_IGNORES) {
    desiredPatterns.push(glob);
  }

  // Deduplicate desired patterns while preserving order
  const uniqueDesired = Array.from(new Set(desiredPatterns));

  const ignoreTargets: Array<'.claudeignore' | '.cursorignore'> = ['.claudeignore', '.cursorignore'];
  const ignoreFiles: IgnoreFileUpdate[] = [];
  const planned: Array<{ path: string; before: Snapshot | null; content: string }> = [];
  const snapshots = new Map<string, Snapshot | null>();

  for (const fileName of ignoreTargets) {
    const filePath = join(root, fileName);
    const before = snapshot(root, filePath);
    const existed = before !== null;
    const existingContent = before?.content ?? '';
    const existingSet = parseExistingIgnoreSet(existingContent);

    const addedPatterns = uniqueDesired.filter((pat) => !existingSet.has(pat));
    let updatedContent = existingContent;

    if (addedPatterns.length > 0) {
      const prefix = existingContent.length > 0 && !existingContent.endsWith('\n') ? '\n\n' : existingContent.length > 0 ? '\n' : '';
      const managedBlock = [
        '# agentlens-managed (workspace hygiene)',
        ...addedPatterns,
        '',
      ].join('\n');
      updatedContent = existingContent + prefix + managedBlock;

      planned.push({ path: filePath, before, content: updatedContent });
    }

    ignoreFiles.push({
      fileName,
      filePath,
      existed,
      existingPatternsCount: existingSet.size / 2,
      addedPatterns,
      updatedContent,
    });
  }

  // 4. Run instruction trimmer on project instruction files (exclude docs/*.md)
  const projectList = [{ id: projId ?? 1, root, name: projName }];
  const scannedInstructions: InstructionItem[] = [];
  const targets: Array<[Agent, string]> = [
    ['claude', 'CLAUDE.md'], ['claude', '.claude/CLAUDE.md'],
    ['codex', 'AGENTS.md'], ['codex', '.codex/AGENTS.md'],
    ['antigravity', 'GEMINI.md'], ['antigravity', '.gemini/GEMINI.md'],
  ];
  const rules = join(root, '.claude/rules');
  checkPath(root, rules);
  if (existsSync(rules)) {
    if (!lstatSync(rules).isDirectory()) throw Error(`Not a directory: ${rules}`);
    for (const name of readdirSync(rules)) if (name.endsWith('.md')) targets.push(['claude', `.claude/rules/${name}`]);
  }
  for (const [agent, name] of targets) {
    const path = join(root, name), data = snapshot(root, path);
    snapshots.set(path, data);
    if (!data) continue;
    scannedInstructions.push({ agent, projectId: projId ?? 1, kind: 'instruction', name: basename(path),
      sourcePath: path, path, tokens: Math.ceil(data.content.length / CHARS_PER_TOKEN), details: {} });
  }
  const trimResults = trimInstructions(scannedInstructions, projectList, path => snapshots.get(path)!.content);
  const instructionTrims: InstructionTrimAction[] = [];
  for (const trim of trimResults) {
    const before = snapshots.get(trim.filePath)!;
    const backupPath = `${trim.filePath}.bak`;
    planned.push({ path: trim.filePath, before, content: applyCutsToLines(before.content.split('\n'), trim.cuts).join('\n') });
    instructionTrims.push({ ...trim, backupPath, applied: apply });
  }

  if (apply) {
    // Preflight every target and exclusive backup before creating anything.
    for (const entry of planned) {
      if (!sameSnapshot(entry.before, snapshot(root, entry.path))) throw Error(`File changed: ${entry.path}`);
      if (entry.before && snapshot(root, `${entry.path}.bak`) !== null) throw Error(`Backup already exists: ${entry.path}.bak`);
    }
    // All instruction inputs affect cuts, including files that do not themselves change.
    for (const [path, before] of snapshots) {
      if (!sameSnapshot(before, snapshot(root, path))) throw Error(`File changed: ${path}`);
    }
    for (const entry of planned) {
      if (entry.before) {
        checkPath(root, `${entry.path}.bak`);
        writeFileSync(`${entry.path}.bak`, entry.before.content, { flag: 'wx', mode: entry.before.mode });
      }
    }
    for (const entry of planned) {
      if (!sameSnapshot(entry.before, snapshot(root, entry.path))) throw Error(`File changed: ${entry.path}`);
    }
    for (const entry of planned) {
      checkPath(root, entry.path);
      const fd = openSync(entry.path, entry.before ? constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK :
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.before?.mode ?? 0o666);
      try {
        const st = fstatSync(fd), current = lstatSync(entry.path);
        if (!st.isFile() || st.nlink !== 1 || st.dev !== current.dev || st.ino !== current.ino ||
          (entry.before && (st.dev !== entry.before.dev || st.ino !== entry.before.ino || st.size !== entry.before.size ||
            st.mtimeMs !== entry.before.mtimeMs || st.ctimeMs !== entry.before.ctimeMs))) throw Error(`File changed: ${entry.path}`);
        checkPath(root, entry.path);
        if (entry.before) {
          const bytes = Buffer.alloc(entry.before.size + 1);
          const count = readSync(fd, bytes, 0, bytes.length, 0);
          if (count !== entry.before.size || bytes.subarray(0, count).toString('utf8') !== entry.before.content) throw Error(`File changed: ${entry.path}`);
          ftruncateSync(fd, 0);
        }
        writeFileSync(fd, entry.content);
      } finally { closeSync(fd); }
    }
  }

  // 5. Inspect audit_items in DB for unused MCPs/skills and duplicates
  const auditItems = getAuditItems(db, {
    projectId: projId ?? undefined,
    includeGlobal: true,
  });
  const unusedItems = auditItems.filter((i) => i.status === 'unused');
  const duplicateOrConflictItems = auditItems.filter(
    (i) => i.status === 'duplicate' || i.status === 'conflict'
  );

  const trimTokensSaved = instructionTrims.reduce((s, t) => s + t.tokensSaved, 0);
  const unusedTokensSaved = unusedItems.reduce((s, i) => s + (i.tokens || 0), 0);
  const oversizedTokensSaved = oversizedFiles.reduce((s, f) => s + Math.min(f.estTokens, 15_000), 0);
  const estimatedTokensSavedPerTurn = trimTokensSaved + unusedTokensSaved + oversizedTokensSaved;

  return {
    projectId: projId,
    projectName: projName,
    projectRoot: root,
    applied: apply,
    ignoreFiles,
    oversizedFiles,
    instructionTrims,
    unusedItems,
    duplicateOrConflictItems,
    estimatedTokensSavedPerTurn,
  };
}

export function formatOptimizeReport(res: WorkspaceOptimizeResult): string {
  const modeLabel = res.applied ? 'APPLIED' : 'PREVIEW (Dry Run)';
  const lines: string[] = [
    '',
    '==================================================',
    `Workspace Optimization ${modeLabel}: ${res.projectName}`,
    `Root: ${res.projectRoot}`,
    '==================================================',
    '',
    `Estimated Savings: ~${res.estimatedTokensSavedPerTurn.toLocaleString()} tokens/turn`,
    '',
  ];

  lines.push('1. Ignore Rules (.claudeignore & .cursorignore):');
  for (const ig of res.ignoreFiles) {
    if (ig.addedPatterns.length === 0) {
      lines.push(`   - ${ig.fileName}: up to date (0 missing patterns)`);
    } else {
      const statusVerb = res.applied ? 'wrote' : 'will add';
      lines.push(`   - ${ig.fileName}: ${statusVerb} ${ig.addedPatterns.length} pattern(s): ${ig.addedPatterns.join(', ')}`);
    }
  }
  lines.push('');

  if (res.oversizedFiles.length > 0) {
    lines.push('2. Oversized Workspace Files Shielded from Auto-Ingestion:');
    for (const f of res.oversizedFiles) {
      lines.push(`   - ${f.relativePath} (${Math.round(f.bytes / 1024)} KB / ~${f.estTokens.toLocaleString()} tokens)`);
    }
    lines.push('');
  }

  lines.push('3. Instruction File Trimming (CLAUDE.md / AGENTS.md / GEMINI.md):');
  if (res.instructionTrims.length === 0) {
    lines.push('   - All project instruction files are clean (0 redundant cuts needed).');
  } else {
    for (const t of res.instructionTrims) {
      const stateStr = t.applied ? `trimmed (backup at ${basename(t.backupPath)})` : 'can be trimmed';
      lines.push(`   - ${t.fileName} [${t.agent}]: ${t.cuts.length} cut(s), saves ~${t.tokensSaved.toLocaleString()} tok/turn (${stateStr})`);
      for (const c of t.cuts) {
        lines.push(`       * Line ${c.startLine}: ${c.description} (-${c.tokensSaved} tok)`);
      }
    }
  }
  lines.push('');

  if (res.unusedItems.length > 0) {
    lines.push(`4. Unused MCP Servers & Skills (0 calls in 30d):`);
    for (const u of res.unusedItems.slice(0, 12)) {
      lines.push(`   - [${u.agent}] ${u.kind.toUpperCase()} '${u.name}' (~${u.tokens.toLocaleString()} tok) -> ${u.sourcePath}`);
    }
    if (res.unusedItems.length > 12) {
      lines.push(`   ... and ${res.unusedItems.length - 12} more unused item(s)`);
    }
    lines.push('');
  }

  if (!res.applied) {
    lines.push(`Run 'agentlens optimize --project "${res.projectRoot}" --apply' to write .claudeignore/.cursorignore and trim instructions.`);
  } else {
    lines.push(`Workspace optimizations applied successfully.`);
  }
  lines.push('==================================================\n');

  return lines.join('\n');
}
