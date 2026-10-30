import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, ftruncateSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { getFindings, type DB } from './db.ts';
import { extractFilesFromEvidence } from './cheatsheet.ts';
import { projectName as resolveProjectName, projectRoot as resolveProjectRoot } from './project.ts';
import { MAX_BOUNDED_READ_BYTES } from './ai/constants.ts';

const CONFIG_FILE = '.agentlens.json';
const BASE_PATTERNS = ['node_modules/', 'dist/', 'build/', '.next/', 'coverage/'];
const LOCKFILE_PATTERNS = [
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'composer.lock',
];
const MAX_HOT_FILES = 5;
const HASH_SEGMENT = /^[0-9a-f]{16,}$/i;
// Directory basenames generic enough to become an ignore pattern derived from a hot-file
// path. Anything else is path-specific and must never be emitted as a pattern.
const GENERIC_DIR_NAMES = new Set([
  'generated', 'gen', '__generated__', 'tmp', 'temp', 'cache', '.cache', 'out', 'output', 'artifacts',
  '.turbo', 'target', 'vendor', 'venv', '.venv', '__pycache__', 'snapshots', 'fixtures',
]);

export interface RepoConfigCandidate {
  projectName: string;
  // Semantics: null means no weekly token budget is configured for this project
  // (matches the repo's budget conventions: /api/project/budget deletes unset budget
  // settings, and src/summary.ts treats a missing budget_tokens_<id> as no budget).
  // Consumers must treat null as "unset", never as 0 consumed.
  weeklyBudgetTokens: number | null;
  recommendedIgnorePatterns: string[];
  hotFiles: string[];
  hotFilesNote?: string;
}

export interface RepoConfigResult {
  config: RepoConfigCandidate;
  configPath: string;
  wrote: boolean;
  backupPath: string | null;
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !/[\\:\x00-\x1f\x7f-\x9f]/.test(path) &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

// A hot-file path is emitted only when it refers to a real regular file inside the
// project root via a symlink-free path; stale DB paths and links out of root are dropped.
function isRealFileInRoot(root: string, rel: string): boolean {
  try {
    const abs = resolve(root, rel);
    const st = lstatSync(abs);
    if (!st.isFile() || st.nlink !== 1) return false;
    return realpathSync(abs) === resolve(realpathSync(root), rel);
  } catch {
    return false;
  }
}

function genericDirPattern(rel: string): string | null {
  const dir = dirname(rel);
  if (dir === '.') return null;
  const parts = dir.split('/');
  if (parts.some((part) => HASH_SEGMENT.test(part))) return null;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (GENERIC_DIR_NAMES.has(parts[i])) return `${parts.slice(0, i + 1).join('/')}/`;
  }
  return null;
}

function weeklyBudgetTokens(db: DB, projectId: number | null): number | null {
  if (projectId == null) return null;
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`budget_tokens_${projectId}`) as
      | { value: string }
      | undefined;
    const n = row ? Number(row.value) : NaN;
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function buildRepoConfig(
  db: DB,
  options: { projectRoot?: string; projectId?: number } = {},
): RepoConfigCandidate {
  let projectId: number | null = options.projectId ?? null;
  let root = options.projectRoot ? resolve(options.projectRoot) : undefined;
  let name = '';

  if (projectId != null) {
    try {
      const row = db.prepare('SELECT id, root, name FROM projects WHERE id = ?').get(projectId) as
        | { root: string; name: string }
        | undefined;
      if (row) {
        root = row.root;
        ({ name } = row);
      }
    } catch {}
  }

  if (!root) {
    root = resolveProjectRoot(options.projectRoot ?? process.cwd());
  }
  if (!name) {
    try {
      const row = db.prepare('SELECT id, name FROM projects WHERE root = ?').get(root) as
        | { id: number; name: string }
        | undefined;
      if (row) {
        projectId = row.id;
        name = row.name;
      }
    } catch {}
  }
  if (!name) name = resolveProjectName(root);

  // 1. Top hot-file paths from hot_files findings; hashes never become paths.
  let findings: Array<{ evidence: unknown }> = [];
  try {
    findings = getFindings(db, projectId != null ? { projectId, rule: 'hot_files' } : { rule: 'hot_files' });
  } catch {}
  const hotFiles: string[] = [];
  const dirPatterns: string[] = [];
  let sawHashOnly = false;
  for (const f of findings) {
    if (hotFiles.length >= MAX_HOT_FILES && dirPatterns.length > 0) break;
    const items = extractFilesFromEvidence(f.evidence);
    if (items.length === 0 && typeof (f.evidence as { argsHash?: string })?.argsHash === 'string') sawHashOnly = true;
    for (const item of items) {
      if (hotFiles.length >= MAX_HOT_FILES) break;
      if (!safeRelativePath(item.file) || !isRealFileInRoot(root, item.file)) continue;
      hotFiles.push(item.file);
      const pattern = genericDirPattern(item.file);
      if (pattern && !dirPatterns.includes(pattern)) dirPatterns.push(pattern);
    }
  }

  return {
    projectName: name,
    weeklyBudgetTokens: weeklyBudgetTokens(db, projectId),
    recommendedIgnorePatterns: [...BASE_PATTERNS, ...LOCKFILE_PATTERNS, ...dirPatterns],
    hotFiles,
    ...(sawHashOnly && hotFiles.length === 0
      ? { hotFilesNote: 'hot_files findings for this project store only hashes (argsHash), not file paths; no paths can be emitted.' }
      : {}),
  };
}

// Throws with a specific message when content is not a valid agentlens config.
function validateExistingConfig(content: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw Error(`Existing .agentlens.json is not valid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Error('Existing .agentlens.json is not valid: top level must be a JSON object');
  }
  const cfg = parsed as Record<string, unknown>;
  if (cfg.weeklyBudgetTokens !== undefined && cfg.weeklyBudgetTokens !== null && !Number.isSafeInteger(cfg.weeklyBudgetTokens)) {
    throw Error('Existing .agentlens.json is not valid: weeklyBudgetTokens must be a positive integer or null');
  }
  for (const key of ['recommendedIgnorePatterns', 'hotFiles'] as const) {
    if (cfg[key] !== undefined && (!Array.isArray(cfg[key]) || !(cfg[key] as unknown[]).every((v) => typeof v === 'string'))) {
      throw Error(`Existing .agentlens.json is not valid: ${key} must be an array of strings`);
    }
  }
}

function readExistingConfig(configPath: string): string | null {
  let st;
  try {
    st = lstatSync(configPath);
  } catch {
    return null; // nothing there yet
  }
  if (st.isSymbolicLink()) throw Error(`Refusing to follow symlinked .agentlens.json: ${configPath}`);
  let fd: number;
  try {
    fd = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw Error(`Refusing to follow symlinked .agentlens.json: ${configPath}`);
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BOUNDED_READ_BYTES) {
      throw Error(`Unsafe or oversized .agentlens.json: ${configPath}`);
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const n = readSync(fd, bytes, offset, stat.size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    return bytes.subarray(0, offset).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function initRepoConfig(
  db: DB,
  options: { projectRoot?: string; projectId?: number; apply?: boolean } = {},
): RepoConfigResult {
  const config = buildRepoConfig(db, options);
  const root = resolve(options.projectRoot ?? process.cwd());
  const configPath = join(root, CONFIG_FILE);
  let wrote = false;
  let backupPath: string | null = null;

  if (options.apply) {
    const content = `${JSON.stringify(config, null, 2)}\n`;
    const prior = readExistingConfig(configPath);
    if (prior !== null) {
      validateExistingConfig(prior);
      backupPath = `${configPath}.bak`;
      try {
        writeFileSync(backupPath, prior, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Error(`Backup already exists: ${configPath}.bak`);
        throw error;
      }
    }
    const existing = prior !== null;
    const fd = openSync(
      configPath,
      existing ? constants.O_RDWR | constants.O_NOFOLLOW
        : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o666,
    );
    try {
      if (!fstatSync(fd).isFile()) throw Error(`Not a regular file: ${configPath}`);
      writeFileSync(fd, content);
      if (existing) ftruncateSync(fd, content.length);
    } finally {
      closeSync(fd);
    }
    wrote = true;
  }

  return { config, configPath, wrote, backupPath };
}
