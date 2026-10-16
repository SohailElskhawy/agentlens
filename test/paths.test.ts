import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
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

test('getPlatformPaths: respects ambient process.env when customHome is homedir()', () => {
  const p = getPlatformPaths(homedir());
  if (process.platform === 'linux' && process.env.XDG_DATA_HOME) {
    assert.equal(p.dataDir, join(process.env.XDG_DATA_HOME, 'agentlens'));
  } else if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    assert.equal(p.dataDir, join(process.env.LOCALAPPDATA, 'agentlens'));
  }
  assert.ok(p.dataDir.includes('agentlens'));
  assert.ok(p.stateDir.includes('agentlens'));
  assert.ok(p.dbPath.endsWith('agentlens.db'));
});

test('getPlatformPaths: respects custom XDG_DATA_HOME and LOCALAPPDATA when legacy db does not exist', () => {
  const cleanHome = '/fake/clean-user';
  const mockXdg = join(cleanHome, '.test-xdg-share');
  const pLinux = getPlatformPaths(cleanHome, { XDG_DATA_HOME: mockXdg }, 'linux');
  assert.equal(pLinux.dataDir, join(mockXdg, 'agentlens'));

  const mockLocal = 'C:\\fake\\AppData\\Local';
  const pWin = getPlatformPaths(cleanHome, { LOCALAPPDATA: mockLocal }, 'win32');
  assert.equal(pWin.dataDir, join(mockLocal, 'agentlens'));
  assert.equal(pWin.stateDir, join(mockLocal, 'agentlens/state'));
});

test('getPlatformPaths: no-arg call uses ambient env and homedir()', () => {
  const p = getPlatformPaths();
  assert.ok(p.dataDir.includes('agentlens'));
  assert.ok(p.stateDir.includes('agentlens'));
  assert.ok(p.dbPath.endsWith('agentlens.db'));
});

