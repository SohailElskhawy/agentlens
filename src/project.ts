import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const cache = new Map<string, string>();

/**
 * Maps a working directory to its project root: the enclosing git repo (a worktree maps to its main repo),
 * or the directory itself when it is not inside a repo or no longer exists.
 */
export function projectRoot(cwd: string): string {
  const hit = cache.get(cwd);
  if (hit) return hit;
  let root = cwd;
  for (let dir = cwd; ; dir = dirname(dir)) {
    const git = join(dir, '.git');
    if (existsSync(git)) {
      if (statSync(git).isFile()) { root = worktreeMain(git) ?? dir; break; }
      if (existsSync(join(git, 'HEAD'))) { root = dir; break; } // git ignores a .git dir without HEAD
    }
    if (dirname(dir) === dir) break;
  }
  cache.set(cwd, root);
  return root;
}

// A worktree's .git file holds "gitdir: <main>/.git/worktrees/<name>"; that dir's "commondir" points back to <main>/.git.
function worktreeMain(gitFile: string): string | undefined {
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitFile, 'utf8'));
  if (!m) return;
  const gitdir = resolve(dirname(gitFile), m[1].trim());
  const commonFile = join(gitdir, 'commondir');
  const common = existsSync(commonFile) ? resolve(gitdir, readFileSync(commonFile, 'utf8').trim()) : gitdir;
  return basename(common) === '.git' ? dirname(common) : undefined;
}

export const projectName = (root: string) => basename(root) || root;
