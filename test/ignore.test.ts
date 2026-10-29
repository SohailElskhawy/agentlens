import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, put } from './helpers.ts';
import { openDb } from '../src/db.ts';
import { generateIgnore, formatIgnoreReport } from '../src/ignore.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const { CLAUDE_CONFIG_DIR: _c, CODEX_HOME: _x, ...baseEnv } = process.env;
const runCli = (args: string[], env: Record<string, string> = {}) =>
  execFileSync(process.execPath, ['--no-warnings', CLI, ...args], {
    env: { ...baseEnv, ...env },
    encoding: 'utf8',
    stdio: 'pipe',
  });

test('1. Detects noisy dirs, lockfiles, and oversized/noisy findings while never ignoring core instructions', () => {
  const root = tmp();
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  put(join(root, 'package-lock.json'), '{}');
  put(join(root, 'CLAUDE.md'), '# Claude instructions');
  put(join(root, 'AGENTS.md'), '# Agent instructions');
  put(join(root, 'package.json'), '{"name": "test-pkg"}');

  // Create an oversized file (> 40_000 bytes) and a noisy log file
  const oversizedData = 'x'.repeat(45_000);
  put(join(root, 'large-export.json'), oversizedData);
  put(join(root, 'debug.log'), 'log data');

  const db = openDb(':memory:');
  const projStmt = db.prepare('INSERT INTO projects (root, name) VALUES (?, ?)');
  projStmt.run(root, 'test-project');
  const proj = db.prepare('SELECT id FROM projects WHERE root = ?').get(root) as { id: number };

  const findStmt = db.prepare(
    'INSERT INTO findings (id, rule, project_id, session_id, evidence, confidence, confidence_reason, est_tokens_week, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  // hot_files finding pointing to oversized file and to CLAUDE.md
  findStmt.run(
    'f1',
    'hot_files',
    proj.id,
    's1',
    JSON.stringify({ file: 'large-export.json' }),
    'high',
    'hot file re-read',
    10000,
    Date.now(),
    Date.now()
  );
  findStmt.run(
    'f2',
    'hot_files',
    proj.id,
    's1',
    JSON.stringify({ file: 'CLAUDE.md' }),
    'high',
    'instruction re-read',
    5000,
    Date.now(),
    Date.now()
  );
  // large_tool_output finding pointing to noisy log file and to package.json
  findStmt.run(
    'f3',
    'large_tool_output',
    proj.id,
    's1',
    JSON.stringify({ path: 'debug.log' }),
    'high',
    'noisy output',
    8000,
    Date.now(),
    Date.now()
  );
  findStmt.run(
    'f4',
    'large_tool_output',
    proj.id,
    's1',
    JSON.stringify({ target: 'package.json' }),
    'high',
    'large read',
    8000,
    Date.now(),
    Date.now()
  );

  const res = generateIgnore(db, { projectRoot: root, projectId: proj.id });

  assert.equal(res.projectName, 'test-project');
  assert.equal(res.projectId, proj.id);
  assert.equal(res.applied, false);
  assert.ok(res.estimatedTokensSavedPerTurn > 0);

  // findingPatterns includes large-export.json and debug.log, but NEVER CLAUDE.md or package.json
  assert.ok(res.findingPatterns.includes('large-export.json'));
  assert.ok(res.findingPatterns.includes('debug.log'));
  assert.ok(!res.findingPatterns.includes('CLAUDE.md'));
  assert.ok(!res.findingPatterns.includes('AGENTS.md'));
  assert.ok(!res.findingPatterns.includes('package.json'));

  // Verify ignore files target both .claudeignore and .cursorignore
  assert.equal(res.ignoreFiles.length, 2);
  for (const ig of res.ignoreFiles) {
    assert.ok(ig.addedPatterns.includes('dist/'));
    assert.ok(ig.addedPatterns.includes('node_modules/'));
    assert.ok(ig.addedPatterns.includes('package-lock.json'));
    assert.ok(ig.addedPatterns.includes('large-export.json'));
    assert.ok(ig.addedPatterns.includes('debug.log'));
    assert.ok(ig.addedPatterns.includes('*.min.js'));
    assert.ok(ig.addedPatterns.includes('*.map'));
    assert.ok(!ig.addedPatterns.includes('CLAUDE.md'));
    assert.ok(!ig.addedPatterns.includes('AGENTS.md'));
    assert.ok(!ig.addedPatterns.includes('package.json'));
  }

  // Report formatting test
  const report = formatIgnoreReport(res);
  assert.ok(report.includes('test-project'));
  assert.ok(report.includes('.claudeignore'));
  assert.ok(report.includes('.cursorignore'));

  // Test looking up root from projects table via projectId when projectRoot is omitted
  const resByProjId = generateIgnore(db, { projectId: proj.id });
  assert.equal(resByProjId.projectId, proj.id);
  assert.equal(resByProjId.projectName, 'test-project');
  assert.ok(resByProjId.projectRoot.length > 0);
  assert.ok(resByProjId.findingPatterns.includes('large-export.json'));
});

test('2. Dry-run by default (apply: false) does not create or modify files on disk', () => {
  const root = tmp();
  mkdirSync(join(root, 'dist'), { recursive: true });
  put(join(root, 'package-lock.json'), '{}');

  const db = openDb(':memory:');
  const res = generateIgnore(db, { projectRoot: root });

  assert.equal(res.applied, false);
  for (const ig of res.ignoreFiles) {
    assert.equal(ig.applied, false);
    assert.equal(ig.backupPath, null);
    assert.equal(ig.existed, false);
    assert.ok(ig.addedPatterns.length > 0);
    assert.ok(ig.updatedContent.includes('# agentlens-managed'));
    assert.ok(!existsSync(ig.filePath));
  }
});

test('3. --apply (apply: true) writes files, creates .bak backup on existing files, and is idempotent', () => {
  const root = tmp();
  mkdirSync(join(root, 'dist'), { recursive: true });

  // Pre-create .claudeignore with existing custom user content
  const existingContent = '# User custom ignore\ncustom-build-dir/\n';
  const claudeIgnorePath = join(root, '.claudeignore');
  put(claudeIgnorePath, existingContent);

  const db = openDb(':memory:');
  const res1 = generateIgnore(db, { projectRoot: root, apply: true });

  assert.equal(res1.applied, true);

  const claudeResult = res1.ignoreFiles.find((f) => f.fileName === '.claudeignore')!;
  assert.ok(claudeResult);
  assert.equal(claudeResult.applied, true);
  assert.equal(claudeResult.existed, true);
  assert.equal(claudeResult.backupPath, `${claudeIgnorePath}.bak`);

  // Verify .bak file created with original content
  assert.ok(existsSync(`${claudeIgnorePath}.bak`));
  assert.equal(readFileSync(`${claudeIgnorePath}.bak`, 'utf8'), existingContent);

  // Verify updated .claudeignore on disk contains both custom rule and added patterns
  const newContent = readFileSync(claudeIgnorePath, 'utf8');
  assert.ok(newContent.includes('# User custom ignore'));
  assert.ok(newContent.includes('custom-build-dir/'));
  assert.ok(newContent.includes('# agentlens-managed (workspace hygiene)'));
  assert.ok(newContent.includes('dist/'));

  // Verify .cursorignore was also created (didn't exist previously, so no backup)
  const cursorIgnorePath = join(root, '.cursorignore');
  const cursorResult = res1.ignoreFiles.find((f) => f.fileName === '.cursorignore')!;
  assert.ok(cursorResult);
  assert.equal(cursorResult.applied, true);
  assert.equal(cursorResult.existed, false);
  assert.equal(cursorResult.backupPath, null);
  assert.ok(existsSync(cursorIgnorePath));

  // Second run: idempotency test
  const res2 = generateIgnore(db, { projectRoot: root, apply: true });
  for (const ig of res2.ignoreFiles) {
    assert.equal(ig.addedPatterns.length, 0);
    assert.equal(ig.applied, false);
    assert.equal(ig.backupPath, null);
  }
});

test('4. Refuses symlinked ignore files and rejects .. path traversal in finding evidence', () => {
  const root = tmp();
  const externalFile = join(tmp(), 'external.txt');
  put(externalFile, '# external');

  // Case A: .claudeignore is a symlink
  symlinkSync(externalFile, join(root, '.claudeignore'));

  const db = openDb(':memory:');
  assert.throws(
    () => generateIgnore(db, { projectRoot: root }),
    /Refusing to read or write non-regular ignore file/
  );

  // Clean up and test .cursorignore as symlink
  const root2 = tmp();
  symlinkSync(externalFile, join(root2, '.cursorignore'));
  assert.throws(
    () => generateIgnore(db, { projectRoot: root2 }),
    /Refusing to read or write non-regular ignore file/
  );

  // Test broken symlink for .claudeignore
  const rootBroken = tmp();
  symlinkSync(join(rootBroken, 'non-existent-target.txt'), join(rootBroken, '.claudeignore'));
  assert.throws(
    () => generateIgnore(db, { projectRoot: rootBroken }),
    /Refusing to read or write non-regular ignore file/
  );

  // Test symlinked noisy directory is skipped via lstatSync
  const rootSymDir = tmp();
  const realDist = tmp();
  symlinkSync(realDist, join(rootSymDir, 'dist'));
  const resSymDir = generateIgnore(db, { projectRoot: rootSymDir });
  assert.ok(!resSymDir.ignoreFiles[0].addedPatterns.includes('dist/'));

  // Case B: .. path traversal and leading slash in finding evidence
  const root3 = tmp();
  const projStmt = db.prepare('INSERT INTO projects (root, name) VALUES (?, ?)');
  projStmt.run(root3, 'traversal-project');
  const proj = db.prepare('SELECT id FROM projects WHERE root = ?').get(root3) as { id: number };

  const findStmt = db.prepare(
    'INSERT INTO findings (id, rule, project_id, session_id, evidence, confidence, confidence_reason, est_tokens_week, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  findStmt.run(
    't1',
    'hot_files',
    proj.id,
    's1',
    JSON.stringify({ file: '../../secret.txt' }),
    'high',
    'traversal test',
    1000,
    Date.now(),
    Date.now()
  );
  findStmt.run(
    't2',
    'large_tool_output',
    proj.id,
    's1',
    JSON.stringify({ target: '/etc/passwd' }),
    'high',
    'absolute path test',
    1000,
    Date.now(),
    Date.now()
  );
  findStmt.run(
    't3',
    'hot_files',
    proj.id,
    's1',
    JSON.stringify({ path: 'sub/../../outside.log' }),
    'high',
    'nested traversal',
    1000,
    Date.now(),
    Date.now()
  );

  const res3 = generateIgnore(db, { projectRoot: root3, projectId: proj.id });
  assert.equal(res3.findingPatterns.length, 0);
  for (const ig of res3.ignoreFiles) {
    assert.ok(!ig.addedPatterns.some((p) => p.includes('secret') || p.includes('passwd') || p.includes('outside')));
  }
});

test('5. CLI agentlens generate-ignore works end-to-end with isolated AGENTLENS_DATA_DIR', () => {
  const root = tmp();
  mkdirSync(join(root, 'dist'), { recursive: true });
  put(join(root, 'package-lock.json'), '{}');

  const isolatedDataDir = tmp();

  // Test --json dry-run
  const jsonOut = runCli(['generate-ignore', '--project', root, '--json'], {
    AGENTLENS_DATA_DIR: isolatedDataDir,
  });
  const parsed = JSON.parse(jsonOut);
  assert.equal(parsed.applied, false);
  assert.ok(Array.isArray(parsed.ignoreFiles));
  assert.equal(parsed.ignoreFiles.length, 2);
  assert.ok(parsed.ignoreFiles[0].addedPatterns.includes('dist/'));
  assert.ok(!existsSync(join(root, '.claudeignore')));

  // Test --apply flag
  const applyOut = runCli(['generate-ignore', '--project', root, '--apply'], {
    AGENTLENS_DATA_DIR: isolatedDataDir,
  });
  assert.ok(applyOut.includes('APPLIED'));
  assert.ok(existsSync(join(root, '.claudeignore')));
  assert.ok(existsSync(join(root, '.cursorignore')));

  // Test --dry-run explicitly
  const dryRunOut = runCli(['generate-ignore', '--project', root, '--dry-run'], {
    AGENTLENS_DATA_DIR: isolatedDataDir,
  });
  assert.ok(dryRunOut.includes('PREVIEW (Dry Run)'));

  // Test positional path argument
  const rootPos = tmp();
  mkdirSync(join(rootPos, 'node_modules'), { recursive: true });
  const posJsonOut = runCli(['generate-ignore', rootPos, '--json'], {
    AGENTLENS_DATA_DIR: isolatedDataDir,
  });
  const parsedPos = JSON.parse(posJsonOut);
  assert.ok(parsedPos.ignoreFiles[0].addedPatterns.includes('node_modules/'));
});

test('6. Finding paths with newline, control chars, or gitignore operators (!, #) are rejected', () => {
  const root = tmp();
  const db = openDb(':memory:');
  const projStmt = db.prepare('INSERT INTO projects (root, name) VALUES (?, ?)');
  projStmt.run(root, 'injection-test');
  const proj = db.prepare('SELECT id FROM projects WHERE root = ?').get(root) as { id: number };

  const findStmt = db.prepare(
    'INSERT INTO findings (id, rule, project_id, session_id, evidence, confidence, confidence_reason, est_tokens_week, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  findStmt.run(
    'inj1',
    'hot_files',
    proj.id,
    's1',
    JSON.stringify({ file: 'x\nCLAUDE.md\ny.log' }),
    'high',
    'newline injection test',
    1000,
    Date.now(),
    Date.now()
  );
  findStmt.run(
    'inj2',
    'large_tool_output',
    proj.id,
    's1',
    JSON.stringify({ path: 'cr\rfile.log' }),
    'high',
    'cr injection test',
    1000,
    Date.now(),
    Date.now()
  );
  findStmt.run(
    'inj3',
    'hot_files',
    proj.id,
    's1',
    JSON.stringify({ target: 'null\0byte.log' }),
    'high',
    'null byte test',
    1000,
    Date.now(),
    Date.now()
  );
  findStmt.run(
    'inj4',
    'hot_files',
    proj.id,
    's1',
    JSON.stringify({ file: '!important.log' }),
    'high',
    'negation operator test',
    1000,
    Date.now(),
    Date.now()
  );
  findStmt.run(
    'inj5',
    'large_tool_output',
    proj.id,
    's1',
    JSON.stringify({ path: '#comment.log' }),
    'high',
    'comment character test',
    1000,
    Date.now(),
    Date.now()
  );

  const res = generateIgnore(db, { projectRoot: root, projectId: proj.id });
  assert.equal(res.findingPatterns.length, 0);

  for (const ig of res.ignoreFiles) {
    assert.ok(!ig.addedPatterns.some((p) => p.includes('CLAUDE.md')));
    assert.ok(!ig.addedPatterns.some((p) => p.includes('important.log')));
    assert.ok(!ig.addedPatterns.some((p) => p.includes('comment.log')));
    assert.ok(!ig.addedPatterns.some((p) => /[\r\n\0]/.test(p)));
    assert.ok(!ig.addedPatterns.some((p) => p.startsWith('!') || p.startsWith('#')));
    assert.ok(!ig.updatedContent.includes('CLAUDE.md'));
  }
});

test('7. When .claudeignore.bak is a symlink, generateIgnore throws and does NOT overwrite target', () => {
  const root = tmp();
  mkdirSync(join(root, 'dist'), { recursive: true });
  put(join(root, '.claudeignore'), 'custom-rule/\n');

  const targetFile = join(tmp(), 'safe-target.txt');
  put(targetFile, 'DO_NOT_OVERWRITE');
  symlinkSync(targetFile, join(root, '.claudeignore.bak'));

  const db = openDb(':memory:');
  assert.throws(
    () => generateIgnore(db, { projectPath: root, apply: true }),
    /Refusing to write backup to symlink or non-regular file: \.claudeignore\.bak/
  );

  // Target file must remain untouched
  assert.equal(readFileSync(targetFile, 'utf8'), 'DO_NOT_OVERWRITE');
});

test('8. CLI flag edge cases: missing --project value and --dry-run precedence over --apply', () => {
  const isolatedDataDir = tmp();
  const root = tmp();
  mkdirSync(join(root, 'dist'), { recursive: true });

  // Missing --project value at end of argv
  assert.throws(
    () => runCli(['generate-ignore', '--project'], { AGENTLENS_DATA_DIR: isolatedDataDir }),
    (err: any) => {
      assert.equal(err.status, 1);
      assert.ok(err.stderr.includes('Usage: agentlens generate-ignore [--project <dir>] [--apply] [--dry-run] [--json]'));
      return true;
    }
  );

  // --project followed immediately by another flag
  assert.throws(
    () => runCli(['generate-ignore', '--project', '--apply'], { AGENTLENS_DATA_DIR: isolatedDataDir }),
    (err: any) => {
      assert.equal(err.status, 1);
      assert.ok(err.stderr.includes('Usage: agentlens generate-ignore [--project <dir>] [--apply] [--dry-run] [--json]'));
      return true;
    }
  );

  // --apply followed by --dry-run: --dry-run must win
  const out1 = runCli(['generate-ignore', '--project', root, '--apply', '--dry-run', '--json'], {
    AGENTLENS_DATA_DIR: isolatedDataDir,
  });
  const parsed1 = JSON.parse(out1);
  assert.equal(parsed1.applied, false);
  assert.ok(!existsSync(join(root, '.claudeignore')));

  // --dry-run followed by --apply: --dry-run must win
  const out2 = runCli(['generate-ignore', '--project', root, '--dry-run', '--apply', '--json'], {
    AGENTLENS_DATA_DIR: isolatedDataDir,
  });
  const parsed2 = JSON.parse(out2);
  assert.equal(parsed2.applied, false);
  assert.ok(!existsSync(join(root, '.claudeignore')));
});
