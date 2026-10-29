import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { formatOptimizeReport, optimizeWorkspace } from '../src/optimize.ts';
import { tmp } from './helpers.ts';

function setup() {
  const base = tmp(), root = join(base, 'project');
  mkdirSync(root);
  const db = openDb(':memory:');
  return { root, db, run: (apply = false) => optimizeWorkspace(db, { projectRoot: root, apply }) };
}

// Oversized workspace file (> 40 KB, .md) that no agent reads per-turn.
function seedOversized(root: string): string {
  const path = join(root, 'big-notes.md');
  writeFileSync(path, 'x'.repeat(45_000));
  return path;
}

// Unused global audit item (no invocations in 30d); ignored when projectless run filters nothing.
function seedUnusedItem(db: ReturnType<typeof openDb>, root: string): void {
  db.prepare("INSERT INTO audit_items (id, agent, kind, name, source_path, tokens, status, updated_at) VALUES ('unused-mcp', 'claude', 'mcp', 'old-mcp', ?, 900, 'unused', 1)").run(join(root, 'old-mcp'));
}

test('no instruction cuts claim zero token savings even with oversized and unused items', () => {
  const s = setup();
  seedOversized(s.root);
  seedUnusedItem(s.db, s.root);
  const res = s.run();
  assert.ok(res.oversizedFiles.length === 1);
  assert.ok(res.unusedItems.length === 1);
  assert.equal(res.estimatedTokensSavedPerTurn, 0);
});

test('instruction trims are counted separately from oversized and unused tokens', () => {
  const s = setup();
  // npm+pnpm triggers the deterministic conflict-section cut (see trimmer.ts), so trimSum > 0.
  writeFileSync(join(s.root, 'CLAUDE.md'), 'npm install\npnpm install\n');
  seedOversized(s.root);
  seedUnusedItem(s.db, s.root);
  const res = s.run();
  const trimSum = res.instructionTrims.reduce((sum, t) => sum + t.tokensSaved, 0);
  assert.ok(trimSum > 0);
  assert.equal(res.estimatedTokensSavedPerTurn, trimSum);
  // Guard against the old behavior of adding oversized/unused estimates into the same figure.
  const unwanted = res.oversizedFiles.reduce((s, f) => s + f.estTokens, 0) + res.unusedItems.reduce((s, i) => s + i.tokens, 0);
  assert.ok(unwanted > trimSum);
  assert.equal(res.estimatedTokensSavedPerTurn + unwanted, trimSum + unwanted);
});

test('report states estimates are not realized savings and separates exposure categories', () => {
  const s = setup();
  writeFileSync(join(s.root, 'CLAUDE.md'), 'npm install\nnpm install\n');
  seedOversized(s.root);
  seedUnusedItem(s.db, s.root);
  const report = formatOptimizeReport(s.run());
  assert.match(report, /not (measured|realized) savings/i);
  assert.match(report, /context exposure/i);
  assert.match(report, /config exposure/i);
});

test('report says .claudeignore has no effect in Claude Code and mentions Read deny alternative', () => {
  const s = setup();
  const report = formatOptimizeReport(s.run());
  assert.match(report, /\.claudeignore.*no effect/i);
  assert.match(report, /Claude Code/i);
  assert.match(report, /Read/i);
  assert.match(report, /\bnot a security sandbox\b/i);
});

test('report does not claim ignore files shield tools or auto-ingestion', () => {
  const s = setup();
  seedOversized(s.root);
  const report = formatOptimizeReport(s.run());
  assert.doesNotMatch(report, /shield/i);
  assert.doesNotMatch(report, /auto-?ingestion|automatically ingest/i);
  assert.doesNotMatch(report, /protects? all tools|covers all tools/i);
  // Oversized files are exposure warnings, not "shielded from ingestion".
  assert.doesNotMatch(report, /Shielded/);
  assert.ok(existsSync(join(s.root, 'big-notes.md')));
});
