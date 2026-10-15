import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, projectName } from '../src/project.ts';
import { tmp, put } from './helpers.ts';

test('a subdirectory of a repo maps to the repo root', () => {
  const repo = join(tmp(), 'app');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'src/deep'), { recursive: true });
  assert.equal(projectRoot(join(repo, 'src/deep')), repo);
  assert.equal(projectName(repo), 'app');
});

test('a git worktree maps to its main repository', () => {
  const base = tmp();
  const main = join(base, 'main');
  put(join(main, '.git/worktrees/feat/commondir'), '../..\n');
  const wt = join(base, 'wt-feat');
  put(join(wt, '.git'), `gitdir: ${join(main, '.git/worktrees/feat')}\n`);
  assert.equal(projectRoot(wt), main);
});

test('a directory outside any repo, or one that no longer exists, is its own project', () => {
  const plain = tmp();
  assert.equal(projectRoot(plain), plain);
  const gone = join(tmp(), 'deleted/long/ago');
  assert.equal(projectRoot(gone), gone);
});
