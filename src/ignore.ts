import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { DB } from './db.ts';
import { projectName, projectRoot } from './project.ts';

export interface IgnoreTargetResult {
  fileName: '.claudeignore' | '.cursorignore';
  filePath: string;
  backupPath: string | null;
  existed: boolean;
  addedPatterns: string[];
  updatedContent: string;
  applied: boolean;
}

export interface GenerateIgnoreResult {
  projectId: number | null;
  projectName: string;
  projectRoot: string;
  applied: boolean;
  findingPatterns: string[];
  ignoreFiles: IgnoreTargetResult[];
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

const BASELINE_GLOBS = [
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.db',
  '*.db-wal',
  '*.db-shm',
  '*.sqlite',
  '*.log',
];

const CORE_INSTRUCTION_DOC_FILES = new Set([
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  'README.md',
  'package.json',
  'tsconfig.json',
]);

const CORE_UPPER = new Set(Array.from(CORE_INSTRUCTION_DOC_FILES).map((s) => s.toUpperCase()));

function isSafeRelativePath(rel: string, root: string): boolean {
  if (typeof rel !== 'string' || !rel.trim()) return false;
  const trimmed = rel.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || isAbsolute(trimmed)) return false;

  const segments = trimmed.split(/[/\\]/);
  if (segments.some((s) => s === '..')) return false;

  const base = basename(trimmed);
  if (CORE_UPPER.has(base.toUpperCase())) return false;

  const fullPath = resolve(root, trimmed);
  if (!fullPath.startsWith(root + '/') && fullPath !== root) return false;

  try {
    const lstat = lstatSync(fullPath);
    if (lstat.isSymbolicLink()) return false;
    const real = realpathSync(fullPath);
    if (!real.startsWith(root + '/') && real !== root) return false;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') return false;
  }

  return true;
}

function isNoisyArtifact(rel: string, fullPath: string): boolean {
  const norm = rel.replace(/\\/g, '/');
  for (const dir of CANDIDATE_NOISE_DIRS) {
    if (norm === dir || norm === `${dir}/` || norm.startsWith(`${dir}/`)) {
      return true;
    }
  }

  const base = basename(norm);
  if (CANDIDATE_LOCKFILES.includes(base)) {
    return true;
  }

  if (/\.(log|min\.js|min\.css|map|db|db-wal|db-shm|sqlite|tsbuildinfo|pyc)$/i.test(base)) {
    return true;
  }

  try {
    const st = statSync(fullPath);
    if (st.isFile() && st.size > 40_000) {
      return true;
    }
  } catch {}

  return false;
}

function parseExistingIgnoreSet(content: string): Set<string> {
  const set = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    set.add(line);
    if (line.endsWith('/')) {
      set.add(line.slice(0, -1));
    } else {
      set.add(`${line}/`);
    }
  }
  return set;
}

export function generateIgnore(
  db: DB,
  opts?: { projectRoot?: string; projectId?: number; apply?: boolean }
): GenerateIgnoreResult {
  const apply = Boolean(opts?.apply);
  let root: string | undefined;
  let projId: number | null = opts?.projectId ?? null;
  let projName = '';

  if (projId != null) {
    try {
      const row = db.prepare('SELECT id, root, name FROM projects WHERE id = ?').get(projId) as
        | { id: number; root: string; name: string }
        | undefined;
      if (row) {
        if (!opts?.projectRoot) {
          root = row.root;
        }
        projName = row.name;
      }
    } catch {}
  }

  const rawRoot = root ?? opts?.projectRoot ?? process.cwd();
  const resolvedRoot = projectRoot(resolve(rawRoot));
  let finalRoot: string;
  try {
    finalRoot = realpathSync(resolvedRoot);
  } catch {
    finalRoot = resolvedRoot;
  }

  if (projId == null) {
    try {
      const row = db.prepare('SELECT id, name FROM projects WHERE root = ? OR root = ?').get(finalRoot, resolvedRoot) as
        | { id: number; name: string }
        | undefined;
      if (row) {
        projId = row.id;
        projName = row.name;
      }
    } catch {}
  }

  if (!projName) {
    projName = projectName(finalRoot);
  }

  const desiredPatterns: string[] = [];

  // 1. Inspect standard noisy directories & lockfiles present inside root (skipping symlinks)
  for (const dir of CANDIDATE_NOISE_DIRS) {
    const p = join(finalRoot, dir);
    try {
      const st = lstatSync(p);
      if (!st.isSymbolicLink() && st.isDirectory()) {
        desiredPatterns.push(`${dir}/`);
      }
    } catch {}
  }

  for (const lock of CANDIDATE_LOCKFILES) {
    const p = join(finalRoot, lock);
    try {
      const st = lstatSync(p);
      if (!st.isSymbolicLink() && st.isFile()) {
        desiredPatterns.push(lock);
      }
    } catch {}
  }

  // 2. Inspect findings in db for projectId where rule IN ('hot_files', 'large_tool_output')
  const findingPatterns: string[] = [];
  if (projId != null) {
    try {
      const rows = db
        .prepare(`SELECT rule, evidence FROM findings WHERE project_id = ? AND rule IN ('hot_files', 'large_tool_output')`)
        .all(projId) as Array<{ rule: string; evidence: string }>;

      for (const row of rows) {
        let ev: any = {};
        if (typeof row.evidence === 'string') {
          try {
            ev = JSON.parse(row.evidence);
          } catch {}
        } else if (typeof row.evidence === 'object' && row.evidence !== null) {
          ev = row.evidence;
        }

        const candidates = [ev.file, ev.target, ev.path];
        for (const cand of candidates) {
          if (typeof cand !== 'string') continue;
          const trimmed = cand.trim();
          if (!trimmed) continue;
          if (!isSafeRelativePath(trimmed, finalRoot)) continue;

          const fullPath = resolve(finalRoot, trimmed);
          if (isNoisyArtifact(trimmed, fullPath)) {
            if (!findingPatterns.includes(trimmed)) {
              findingPatterns.push(trimmed);
            }
            desiredPatterns.push(trimmed);
          }
        }
      }
    } catch {}
  }

  // 3. Include baseline globs
  for (const glob of BASELINE_GLOBS) {
    desiredPatterns.push(glob);
  }

  const uniqueDesired = Array.from(new Set(desiredPatterns));

  // Compute estimatedTokensSavedPerTurn
  let estimatedTokensSavedPerTurn = 0;
  for (const pat of uniqueDesired) {
    if (pat.endsWith('/')) {
      estimatedTokensSavedPerTurn += 8_000;
    } else if (CANDIDATE_LOCKFILES.includes(pat)) {
      estimatedTokensSavedPerTurn += 4_000;
    } else {
      const full = join(finalRoot, pat);
      try {
        const st = statSync(full);
        if (st.isFile()) {
          estimatedTokensSavedPerTurn += Math.ceil(st.size / 4);
        } else {
          estimatedTokensSavedPerTurn += 1_000;
        }
      } catch {
        estimatedTokensSavedPerTurn += 1_000;
      }
    }
  }

  const ignoreTargets: Array<'.claudeignore' | '.cursorignore'> = ['.claudeignore', '.cursorignore'];
  const ignoreFiles: IgnoreTargetResult[] = [];

  for (const fileName of ignoreTargets) {
    const filePath = join(finalRoot, fileName);
    let existed = false;
    let existingContent = '';

    try {
      const st = lstatSync(filePath);
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new Error('Refusing to read or write non-regular ignore file');
      }
      existed = true;
      existingContent = readFileSync(filePath, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        existed = false;
        existingContent = '';
      } else {
        throw err;
      }
    }

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
    }

    let backupPath: string | null = null;
    let appliedFile = false;

    if (apply && addedPatterns.length > 0) {
      if (existed) {
        backupPath = `${filePath}.bak`;
        copyFileSync(filePath, backupPath);
      }
      writeFileSync(filePath, updatedContent, 'utf8');
      appliedFile = true;
    }

    ignoreFiles.push({
      fileName,
      filePath,
      backupPath,
      existed,
      addedPatterns,
      updatedContent,
      applied: appliedFile,
    });
  }

  return {
    projectId: projId,
    projectName: projName,
    projectRoot: finalRoot,
    applied: apply,
    findingPatterns,
    ignoreFiles,
    estimatedTokensSavedPerTurn,
  };
}

export function formatIgnoreReport(res: GenerateIgnoreResult): string {
  const modeLabel = res.applied ? 'APPLIED' : 'PREVIEW (Dry Run)';
  const lines: string[] = [
    '',
    '==================================================',
    `Ignore File Generation ${modeLabel}: ${res.projectName}`,
    `Root: ${res.projectRoot}`,
    '==================================================',
    '',
    `Estimated Savings: ~${res.estimatedTokensSavedPerTurn.toLocaleString()} tokens/turn`,
    '',
  ];

  if (res.findingPatterns.length > 0) {
    lines.push(`Finding Patterns (${res.findingPatterns.length}):`);
    for (const pat of res.findingPatterns) {
      lines.push(`   - ${pat}`);
    }
    lines.push('');
  }

  lines.push('Ignore Targets:');
  for (const ig of res.ignoreFiles) {
    if (ig.addedPatterns.length === 0) {
      lines.push(`   - ${ig.fileName}: up to date (0 missing patterns)`);
    } else {
      const verb = ig.applied ? 'applied' : 'will add';
      const backupInfo = ig.backupPath ? ` (backup: ${basename(ig.backupPath)})` : '';
      lines.push(`   - ${ig.fileName}: ${verb} ${ig.addedPatterns.length} pattern(s)${backupInfo}`);
      for (const p of ig.addedPatterns) {
        lines.push(`       + ${p}`);
      }
    }
  }
  lines.push('');
  if (!res.applied) {
    lines.push(`Run 'agentlens generate-ignore --project "${res.projectRoot}" --apply' to apply changes.`);
  } else {
    lines.push('Ignore rules applied successfully.');
  }
  return lines.join('\n');
}
