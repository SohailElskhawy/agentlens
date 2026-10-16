import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { getPlatformPaths, getOpenCodeDataRoots, getOpenCodeConfigRoots } from '../src/paths.ts';

test('getPlatformPaths: Linux paths follow XDG defaults', () => {
  const home = '/fake/user';
  const p = getPlatformPaths(home, {}, 'linux');
  assert.equal(p.dataDir, join(home, '.local/share/agentlens'));
  assert.equal(p.stateDir, join(home, '.local/state/agentlens'));
  assert.equal(p.reportsDir, join(home, '.local/share/agentlens/reports'));
  assert.equal(p.dbPath, join(home, '.local/share/agentlens/agentlens.db'));
  assert.equal(p.summaryPath, join(home, '.local/state/agentlens/summary.json'));
  assert.equal(p.spoolPath, join(home, '.local/state/agentlens/claude-quota.jsonl'));
  assert.equal(p.candidatesPath, join(home, '.local/share/agentlens/discovery_candidates.json'));
});

test('getPlatformPaths: macOS paths follow Darwin Application Support and Caches', () => {
  const home = '/fake/macuser';
  const p = getPlatformPaths(home, {}, 'darwin');
  assert.equal(p.dataDir, join(home, 'Library/Application Support/agentlens'));
  assert.equal(p.stateDir, join(home, 'Library/Caches/agentlens'));
  assert.equal(p.reportsDir, join(home, 'Library/Application Support/agentlens/reports'));
  assert.equal(p.dbPath, join(home, 'Library/Application Support/agentlens/agentlens.db'));
  assert.equal(p.summaryPath, join(home, 'Library/Caches/agentlens/summary.json'));
});

test('getPlatformPaths: Windows paths use LOCALAPPDATA when present', () => {
  const home = 'C:\\Users\\fakeuser';
  const localAppData = 'C:\\Users\\fakeuser\\AppData\\Local';
  const p = getPlatformPaths(home, { LOCALAPPDATA: localAppData }, 'win32');
  assert.equal(p.dataDir, join(localAppData, 'agentlens'));
  assert.equal(p.stateDir, join(localAppData, 'agentlens/state'));
  assert.equal(p.dbPath, join(localAppData, 'agentlens/agentlens.db'));
});

test('getPlatformPaths: Windows paths fallback when LOCALAPPDATA is unset (Review Focus 1)', () => {
  const home = 'C:\\Users\\fakeuser';
  const p = getPlatformPaths(home, {}, 'win32');
  assert.equal(p.dataDir, join(home, 'AppData/Local/agentlens'));
  assert.equal(p.stateDir, join(home, 'AppData/Local/agentlens/state'));
});

test('getPlatformPaths: AGENTLENS_DATA_DIR and AGENTLENS_STATE_DIR override all OS defaults', () => {
  const home = '/fake/user';
  const p = getPlatformPaths(home, {
    AGENTLENS_DATA_DIR: '/custom/data',
    AGENTLENS_STATE_DIR: '/custom/state',
  }, 'darwin');
  assert.equal(p.dataDir, '/custom/data');
  assert.equal(p.stateDir, '/custom/state');
  assert.equal(p.dbPath, join('/custom/data', 'agentlens.db'));
});

test('getPlatformPaths: preserves legacy ~/.local/share/agentlens if db already exists', () => {
  const tmpHome = join(process.cwd(), 'scratch/tmp-home-legacy');
  const legacyDir = join(tmpHome, '.local/share/agentlens');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'agentlens.db'), '');

  try {
    const p = getPlatformPaths(tmpHome, {}, 'darwin');
    assert.equal(p.dataDir, legacyDir);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('getOpenCodeDataRoots: returns candidate data directories in priority order', () => {
  const roots = getOpenCodeDataRoots('/fake/user', {}, 'linux');
  assert.ok(roots.length >= 2);
  assert.equal(roots[0], join('/fake/user', '.local/share/opencode'));
});

test('getOpenCodeConfigRoots: returns candidate config directories in priority order', () => {
  const roots = getOpenCodeConfigRoots('/fake/user', {}, 'linux');
  assert.ok(roots.length >= 2);
  assert.equal(roots[0], join('/fake/user', '.config/opencode'));
});
