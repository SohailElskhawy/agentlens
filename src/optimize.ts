import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { CHARS_PER_TOKEN } from './audit/constants.ts';
import { scanInstructions } from './audit/scanners/instruction.ts';
import { trimInstructions, type InstructionTrimmerResult, type TrimmingCut } from './audit/trimmer.ts';
import { getAuditItems, getFindings, type DB } from './db.ts';
import { projectName, projectRoot as resolveProjectRoot } from './project.ts';
import type { AuditItem } from './types.ts';

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
  const home = options.home ?? process.env.AGENTLENS_SOURCE_HOME ?? homedir();

  let root = options.projectRoot ? resolveProjectRoot(resolve(options.projectRoot)) : undefined;
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
        if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          if (entry.name.startsWith('.')) continue;
          if (!prefix && CORE_INSTRUCTION_FILES.has(entry.name)) continue;
          if (!prefix && CANDIDATE_LOCKFILES.includes(entry.name)) continue;

          const extMatch = /\.(md|json|jsonl|csv|sql|txt|xml|yaml|yml|log)$/i.test(entry.name);
          if (!extMatch) continue;

          const fullPath = join(dir, entry.name);
          const relPath = `${prefix}${entry.name}`;
          const st = statSync(fullPath);
          if (st.size >= OVERSIZED_FILE_BYTES) {
            const estTokens = Math.ceil(st.size / CHARS_PER_TOKEN);
            oversizedFiles.push({
              relativePath: relPath,
              bytes: st.size,
              estTokens,
              reason: `Oversized workspace file (${Math.round(st.size / 1024)} KB / ~${estTokens.toLocaleString()} tok) slows context & grep scans`,
            });
            desiredPatterns.push(relPath);
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
        if (typeof sf === 'string' && sf.trim() && !CORE_INSTRUCTION_FILES.has(basename(sf))) {
          desiredPatterns.push(sf.trim());
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

  for (const fileName of ignoreTargets) {
    const filePath = join(root, fileName);
    const existed = existsSync(filePath);
    const existingContent = existed ? readFileSync(filePath, 'utf-8') : '';
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

      if (apply && existsSync(root)) {
        writeFileSync(filePath, updatedContent, 'utf-8');
      }
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
  const scannedInstructions = scanInstructions(home, projectList).filter(
    (item) => item.projectId === (projId ?? 1) && !item.details?.isDoc
  );
  const trimResults = trimInstructions(scannedInstructions, projectList);
  const instructionTrims: InstructionTrimAction[] = [];

  for (const trim of trimResults) {
    const backupPath = `${trim.filePath}.bak`;
    let wasApplied = false;
    if (apply && existsSync(trim.filePath) && trim.cuts.length > 0) {
      const originalContent = readFileSync(trim.filePath, 'utf-8');
      copyFileSync(trim.filePath, backupPath);
      const originalLines = originalContent.split('\n');
      const trimmedLines = applyCutsToLines(originalLines, trim.cuts);
      writeFileSync(trim.filePath, trimmedLines.join('\n'), 'utf-8');
      wasApplied = true;
    }
    instructionTrims.push({
      ...trim,
      backupPath,
      applied: wasApplied,
    });
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
