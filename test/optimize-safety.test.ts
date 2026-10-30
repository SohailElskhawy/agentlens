import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, linkSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { optimizeWorkspace } from '../src/optimize.ts';
import { MAX_BOUNDED_READ_BYTES } from '../src/ai/constants.ts';
import { tmp, put } from './helpers.ts';

function setup() {
  const base = tmp(), root = join(base, 'project'), home = join(base, 'home');
  mkdirSync(root); mkdirSync(home);
  const db = openDb(':memory:');
  return { base, root, home, db, run: (apply = false) => optimizeWorkspace(db, { projectRoot: root, home, apply }) };
}
const content = 'npm install\npnpm install\n';

test('rejects symlinked ignore files before changing earlier targets', () => {
  const s = setup(); const first = put(join(s.root, '.claudeignore'), 'original\n');
  const outside = put(join(s.base, 'outside'), 'outside');
  symlinkSync(outside, join(s.root, '.cursorignore'));
  assert.throws(() => s.run(true));
  assert.equal(readFileSync(first, 'utf8'), 'original\n');
  assert.equal(readFileSync(outside, 'utf8'), 'outside');
});

test('rejects symlinked instruction, ancestor and backup without mutations', () => {
  for (const kind of ['instruction', 'ancestor', 'backup']) {
    const s = setup(); const outside = put(join(s.base, 'outside'), content);
    if (kind === 'instruction') symlinkSync(outside, join(s.root, 'CLAUDE.md'));
    if (kind === 'ancestor') { mkdirSync(join(s.base, 'external')); put(join(s.base, 'external/CLAUDE.md'), content); symlinkSync(join(s.base, 'external'), join(s.root, '.claude')); }
    if (kind === 'backup') { put(join(s.root, 'CLAUDE.md'), content); symlinkSync(outside, join(s.root, 'CLAUDE.md.bak')); }
    assert.throws(() => s.run(true), kind);
    assert.equal(readFileSync(outside, 'utf8'), content);
    assert.equal(existsSync(join(s.root, '.claudeignore')), false);
  }
});

test('rejects oversized, FIFO, and hardlinked targets promptly', () => {
  for (const kind of ['oversize', 'fifo', 'hardlink']) {
    const s = setup(); const target = join(s.root, '.claudeignore');
    if (kind === 'oversize') writeFileSync(target, 'x'.repeat(MAX_BOUNDED_READ_BYTES + 1));
    if (kind === 'fifo') execFileSync('mkfifo', [target]);
    if (kind === 'hardlink') { const outside = put(join(s.base, 'outside'), 'outside'); linkSync(outside, target); }
    assert.throws(() => s.run(true), kind);
    assert.equal(existsSync(join(s.root, '.cursorignore')), false);
  }
});

test('preview does not write; apply backs up ignores and trims instructions', () => {
  const s = setup(); const ignore = put(join(s.root, '.claudeignore'), 'old\n');
  const instruction = put(join(s.root, 'CLAUDE.md'), content);
  chmodSync(ignore, 0o640); chmodSync(instruction, 0o640);
  const preview = s.run();
  assert.ok(preview.instructionTrims.length);
  assert.equal(readFileSync(ignore, 'utf8'), 'old\n');
  assert.equal(existsSync(ignore + '.bak'), false);
  s.run(true);
  assert.equal(readFileSync(ignore + '.bak', 'utf8'), 'old\n');
  assert.equal(readFileSync(instruction + '.bak', 'utf8'), content);
  assert.notEqual(readFileSync(instruction, 'utf8'), content);
  for (const path of [ignore, instruction]) assert.equal(statSync(path).mode & 0o777, 0o640);
});

test('existing backups are preserved and prevent all writes', () => {
  const s = setup(); const ignore = put(join(s.root, '.claudeignore'), 'old');
  put(ignore + '.bak', 'prior');
  assert.throws(() => s.run(true));
  assert.equal(readFileSync(ignore, 'utf8'), 'old');
  assert.equal(readFileSync(ignore + '.bak', 'utf8'), 'prior');
  assert.equal(existsSync(join(s.root, '.cursorignore')), false);
});

test('read-only later targets prevent all writes and backups', () => {
  for (const name of ['.cursorignore', 'AGENTS.md']) {
    const s = setup();
    const first = put(join(s.root, '.claudeignore'), 'old\n');
    const target = put(join(s.root, name), name.endsWith('.md') ? content : 'old ignore\n');
    chmodSync(first, 0o640); chmodSync(target, 0o444);
    assert.throws(() => s.run(true), name);
    assert.equal(readFileSync(first, 'utf8'), 'old\n');
    assert.equal(readFileSync(target, 'utf8'), name.endsWith('.md') ? content : 'old ignore\n');
    assert.equal(statSync(first).mode & 0o777, 0o640);
    assert.equal(statSync(target).mode & 0o777, 0o444);
    assert.equal(existsSync(first + '.bak'), false);
    assert.equal(existsSync(target + '.bak'), false);
    assert.equal(existsSync(join(s.root, '.cursorignore.bak')), false);
    if (name === 'AGENTS.md') assert.equal(existsSync(join(s.root, '.cursorignore')), false);
    s.db.close();
  }
});

test('unwritable destination and backup parents prevent all writes', () => {
  for (const kind of ['destination', 'backup']) {
    const s = setup();
    const first = put(join(s.root, '.claudeignore'), 'old\n');
    const parent = kind === 'destination' ? s.root : join(s.root, '.claude');
    if (kind === 'backup') put(join(parent, 'CLAUDE.md'), content);
    chmodSync(parent, 0o555);
    try {
      assert.throws(() => s.run(true), kind);
      assert.equal(readFileSync(first, 'utf8'), 'old\n');
      assert.equal(existsSync(first + '.bak'), false);
      assert.equal(existsSync(join(s.root, '.cursorignore')), false);
      if (kind === 'backup') {
        assert.equal(readFileSync(join(parent, 'CLAUDE.md'), 'utf8'), content);
        assert.equal(existsSync(join(parent, 'CLAUDE.md.bak')), false);
      }
    } finally { chmodSync(parent, 0o755); s.db.close(); }
  }
});

test('finding paths cannot inject ignore operators or core instruction rules', () => {
  const s = setup();
  s.db.prepare('INSERT INTO projects (id, root, name) VALUES (?, ?, ?)').run(1, s.root, 'project');
  const samples = ['output/report.json', '/etc/passwd', '../CLAUDE.md', 'docs/AGENTS.md', 'out\nCLAUDE.md', '!CLAUDE.md', '**/CLAUDE.md', 'foo[ab]', '#comment', 'C:\\temp\\file', 'CLAUDE.md ', 'C:/absolute'];
  s.db.prepare("INSERT INTO findings (id, rule, project_id, evidence, confidence, confidence_reason, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run('finding', 'large_tool_output', 1, JSON.stringify({ sampleFiles: samples }), 'high', '', 1, 1);
  const patterns = s.run().ignoreFiles[0].addedPatterns;
  assert.ok(patterns.includes('output/report.json'));
  for (const unsafe of samples.slice(1)) assert.ok(!patterns.includes(unsafe), unsafe);
});

test('preview rejects unsafe instructions and does not read global instructions', () => {
  const s = setup();
  symlinkSync(join(s.base, 'missing'), join(s.home, '.claude'));
  put(join(s.root, 'CLAUDE.md'), 'x'.repeat(MAX_BOUNDED_READ_BYTES + 1));
  assert.throws(() => s.run());
  assert.equal(existsSync(join(s.root, '.claudeignore')), false);
});
