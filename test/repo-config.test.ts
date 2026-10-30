import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, put } from './helpers.ts';
import { openDb, upsertProject, upsertFindings, setSetting } from '../src/db.ts';
import type { ConfidenceLevel } from '../src/types.ts';
import { buildRepoConfig, initRepoConfig } from '../src/repo-config.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const { CLAUDE_CONFIG_DIR: _c, CODEX_HOME: _x, ...baseEnv } = process.env;
const runCli = (args: string[], env: Record<string, string>) =>
  execFileSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, ...args], {
    env: { ...baseEnv, ...env },
    encoding: 'utf8',
    stdio: 'pipe',
  });

const finding = (id: string, evidence: unknown, estTokensWeek = 10000) => ({
  id: `finding:hot:${id}`,
  rule: 'hot_files',
  projectId: null as number | null,
  sessionId: null,
  confidence: 'high' as ConfidenceLevel,
  confidenceReason: 'Read repeatedly',
  evidence,
  estTokensWeek,
  firstSeen: Date.now(),
  lastSeen: Date.now(),
});

test('a. generates a valid .agentlens.json object from a seeded DB (budget, patterns, hotFiles)', () => {
  const projDir = tmp();
  const db = openDb(':memory:');
  const pid = upsertProject(db, projDir, 'seeded-project');
  setSetting(db, `budget_tokens_${pid}`, '150000');
  put(join(projDir, 'src/db.ts'), 'export const DB = 1;\n');
  put(join(projDir, 'src/generated/artifact.ts'), 'export const A = 1;\n');
  upsertFindings(db, [
    {
      ...finding('ok', { file: 'src/db.ts', reads: 9 }),
      projectId: pid,
    },
    {
      ...finding('gen', { file: 'src/generated/artifact.ts', reads: 5 }, 20000),
      projectId: pid,
    },
  ]);

  const cfg = buildRepoConfig(db, { projectRoot: projDir });
  assert.equal(cfg.projectName, 'seeded-project');
  assert.equal(cfg.weeklyBudgetTokens, 150000);

  for (const pattern of ['node_modules/', 'dist/', 'build/', '.next/', 'coverage/', 'package-lock.json']) {
    assert.ok(cfg.recommendedIgnorePatterns.includes(pattern), `missing pattern: ${pattern}`);
  }
  // hot_files-derived GENERIC directory pattern (plain directory glob, not path-specific file)
  assert.ok(cfg.recommendedIgnorePatterns.includes('src/generated/'), 'missing derived dir pattern');

  // Order follows findings ranking (est_tokens_week desc), not part of this assertion.
  assert.deepEqual([...cfg.hotFiles].sort(), [ 'src/db.ts', 'src/generated/artifact.ts']);
  assert.equal(cfg.hotFilesNote, undefined);
});

test('b. path redaction: absolute, .., and control-character hot-file paths are excluded, not written, no crash', () => {
  const projDir = tmp();
  const db = openDb(':memory:');
  const pid = upsertProject(db, projDir, 'redact-project');
  put(join(projDir, 'src/index.ts'), 'export const OK = 1;\n');
  upsertFindings(db, [
    { ...finding('abs', { file: '/etc/passwd', reads: 30 }), projectId: pid },
    { ...finding('dotdot', { file: '../outside/secrets.ts', reads: 20 }), projectId: pid },
    { ...finding('ctrl', { file: 'bad\u0001name.ts', reads: 15 }), projectId: pid },
    { ...finding('ok', { file: 'src/index.ts', reads: 10 }), projectId: pid },
  ]);

  const res = initRepoConfig(db, { projectRoot: projDir });
  assert.deepEqual(res.config.hotFiles, ['src/index.ts']);
  assert.ok(!res.config.recommendedIgnorePatterns.some((p) => p.includes('passwd') || p.includes('outside') || p.includes('bad')));

  // hash-only findings (no paths stored) must not invent paths: hotFiles stays with note
  const hashDb = openDb(':memory:');
  const hashPid = upsertProject(hashDb, projDir, 'hash-project');
  upsertFindings(hashDb, [
    { ...finding('hash', { argsHash: 'a'.repeat(64), reads: 40 }), projectId: hashPid },
  ]);
  const hashCfg = buildRepoConfig(hashDb, { projectRoot: projDir });
  assert.deepEqual(hashCfg.hotFiles, []);
  assert.match(hashCfg.hotFilesNote ?? '', /hash/i);
});

test('c. dry-run default: no file written without --apply', () => {
  const projDir = tmp();
  const db = openDb(':memory:');
  upsertProject(db, projDir, 'dry-run-project');
  const res = initRepoConfig(db, { projectRoot: projDir });
  assert.equal(res.wrote, false);
  assert.equal(existsSync(join(projDir, '.agentlens.json')), false);
});

test('d. --apply writes the file + .bak backup preserving prior content; refuses symlinked target without following it', () => {
  const projDir = tmp();
  const db = openDb(':memory:');
  upsertProject(db, projDir, 'apply-project');

  // First apply writes fresh file
  const first = initRepoConfig(db, { projectRoot: projDir, apply: true });
  assert.equal(first.wrote, true);
  const written = JSON.parse(readFileSync(join(projDir, '.agentlens.json'), 'utf8'));
  assert.deepEqual(written, first.config);

  // Second apply backs up prior content
  writeFileSync(join(projDir, '.agentlens.json'), '{"weeklyBudgetTokens":42}\n');
  const second = initRepoConfig(db, { projectRoot: projDir, apply: true });
  assert.equal(second.wrote, true);
  assert.equal(second.backupPath, join(projDir, '.agentlens.json.bak'));
  assert.equal(readFileSync(second.backupPath!, 'utf8'), '{"weeklyBudgetTokens":42}\n');

  // Symlinked target is refused (O_NOFOLLOW), the link is not followed
  const linkProj = tmp();
  const outside = tmp();
  put(join(outside, 'victim.json'), '{"secret":true}\n');
  symlinkSync(join(outside, 'victim.json'), join(linkProj, '.agentlens.json'));
  const linkDb = openDb(':memory:');
  upsertProject(linkDb, linkProj, 'link-project');
  assert.throws(() => initRepoConfig(linkDb, { projectRoot: linkProj, apply: true }), /agentlens\.json/);
  assert.equal(readFileSync(join(outside, 'victim.json'), 'utf8'), '{"secret":true}\n');
  assert.ok(lstatSync(join(linkProj, '.agentlens.json')).isSymbolicLink());
});

test('e. schema validation: malformed existing .agentlens.json → clear error, no overwrite', () => {
  const projDir = tmp();
  const db = openDb(':memory:');
  upsertProject(db, projDir, 'malformed-project');
  writeFileSync(join(projDir, '.agentlens.json'), '{ not json !!!');

  assert.throws(
    () => initRepoConfig(db, { projectRoot: projDir, apply: true }),
    (error: Error) => /agentlens\.json/.test(error.message) && error.message.length > 30,
  );
  assert.equal(readFileSync(join(projDir, '.agentlens.json'), 'utf8'), '{ not json !!!');
  assert.equal(existsSync(join(projDir, '.agentlens.json.bak')), false);
});

test('f. empty DB → still valid minimal object (budget null semantics)', () => {
  const projDir = tmp();
  const db = openDb(':memory:');
  upsertProject(db, projDir, 'empty-project');
  const res = initRepoConfig(db, { projectRoot: projDir });
  // Semantics: weeklyBudgetTokens === null means no weekly token budget is configured
  // for this project (matches src/server.ts /api/project/budget: unset budgets are
  // deleted from settings). Consumers must treat null as "unset", never as 0 spent.
  assert.equal(res.config.weeklyBudgetTokens, null);
  assert.deepEqual(res.config.hotFiles, []);
  assert.ok(res.config.recommendedIgnorePatterns.length >= 6);
  const round = buildRepoConfig(db, { projectRoot: projDir });
  assert.deepEqual(round, res.config);
});

test('g. CLI agentlens init-config --project <tmp> --json prints candidate without writing; --apply writes', () => {
  const dataDir = tmp();
  const projDir = tmp();
  const db = openDb(join(dataDir, 'agentlens.db'));
  upsertProject(db, projDir, 'cli-config-proj');
  db.close();

  const jsonOut = runCli(['init-config', '--project', projDir, '--json'], {
    AGENTLENS_DATA_DIR: dataDir,
  });
  const parsed = JSON.parse(jsonOut);
  assert.equal(parsed.projectName, 'cli-config-proj');
  assert.equal(parsed.weeklyBudgetTokens, null);
  assert.equal(existsSync(join(projDir, '.agentlens.json')), false);

  const applyOut = runCli(['init-config', '--project', projDir, '--apply'], {
    AGENTLENS_DATA_DIR: dataDir,
  });
  assert.ok(applyOut.includes('.agentlens.json'));
  const onDisk = JSON.parse(readFileSync(join(projDir, '.agentlens.json'), 'utf8'));
  assert.equal(onDisk.projectName, 'cli-config-proj');
});
