import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, upsertProject } from '../src/db.ts';
import { runAudit } from '../src/audit/runner.ts';
import { trimInstructions, generateUnifiedDiff } from '../src/audit/trimmer.ts';
import type { InstructionItem } from '../src/audit/scanners/instruction.ts';

test('trimInstructions detects duplicates, long code blocks, stale paths, and conflicts', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-trimmer-test-'));

  try {
    const projectDir = join(tmp, 'my-project');
    mkdirSync(projectDir, { recursive: true });

    // Existing file for valid path reference
    writeFileSync(join(projectDir, 'src_real.ts'), 'export const x = 1;');

    const claudeMdPath = join(projectDir, 'CLAUDE.md');
    const agentsMdPath = join(projectDir, 'AGENTS.md');

    // Duplicate line across both files
    const dupLine = 'Always verify that code builds before committing any changes to git repo.';
    const claudeContent = [
      '# Claude Guidelines',
      dupLine,
      'Refer to ./src_real.ts for existing code.',
      'Refer to ./stale_nonexistent_file.ts for old code.',
      '```typescript',
      'const a = 1;',
      'const b = 2;',
      'const c = 3;',
      'const d = 4;',
      'const e = 5;',
      'const f = 6;',
      'const g = 7;',
      'const h = 8;',
      'const i = 9;',
      'const j = 10;',
      'const k = 11;',
      'const l = 12;',
      'const m = 13;',
      'const n = 14;',
      'const o = 15;',
      'const p = 16;',
      '```',
      'Run npm test to run the full test suite.',
      'Run yarn test for the legacy tests.',
    ].join('\n');

    const agentsContent = [
      '# Agents Guidelines',
      dupLine,
      'Run npm run check for types.',
    ].join('\n');

    writeFileSync(claudeMdPath, claudeContent);
    writeFileSync(agentsMdPath, agentsContent);

    const instructions: InstructionItem[] = [
      {
        kind: 'instruction',
        path: claudeMdPath,
        sourcePath: claudeMdPath,
        agent: 'claude',
        projectId: 1,
        tokens: 300,
        name: 'CLAUDE.md',
        details: { chars: claudeContent.length, lines: 25 },
      },
      {
        kind: 'instruction',
        path: agentsMdPath,
        sourcePath: agentsMdPath,
        agent: 'codex',
        projectId: 1,
        tokens: 80,
        name: 'AGENTS.md',
        details: { chars: agentsContent.length, lines: 3 },
      },
    ];

    const results = trimInstructions(instructions, [{ id: 1, root: projectDir, name: 'my-project' }]);
    assert.ok(results.length > 0);

    const claudeTrim = results.find((r) => r.fileName === 'CLAUDE.md');
    assert.ok(claudeTrim, 'Should trim CLAUDE.md');
    assert.ok(claudeTrim.tokensSaved > 0);
    assert.ok(claudeTrim.cuts.length >= 3, `Expected cuts >= 3, got ${claudeTrim.cuts.length}`);

    // Verify stale path detected
    const staleCut = claudeTrim.cuts.find((c) => c.type === 'stale_path');
    assert.ok(staleCut, 'Should detect stale path');
    assert.ok(staleCut.description.includes('stale_nonexistent_file.ts'));

    // Verify long code block detected
    const codeCut = claudeTrim.cuts.find((c) => c.type === 'long_code_block');
    assert.ok(codeCut, 'Should detect oversized code block');

    // Verify unified diff format
    assert.ok(claudeTrim.unifiedDiff.startsWith('--- a/CLAUDE.md\n+++ b/CLAUDE.md'));
    assert.ok(claudeTrim.unifiedDiff.includes('@@'));

    // Verify fix prompt generated
    assert.ok(claudeTrim.fixPrompt.includes('CLAUDE.md'));
    assert.ok(claudeTrim.fixPrompt.includes('tokens/turn'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('runAudit includes trimmings and unified diffs in output and database', () => {
  const tmp = mkdtempSync(join(process.cwd(), '.agentlens-trim-audit-'));

  try {
    const home = join(tmp, 'home');
    const projectDir = join(tmp, 'proj');
    mkdirSync(home, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    const claudePath = join(projectDir, 'CLAUDE.md');
    writeFileSync(claudePath, [
      '# Instructions',
      'Check missing file ./does_not_exist.ts before running.',
    ].join('\n'));

    const db = openDb(':memory:');
    upsertProject(db, projectDir, 'test-proj');

    const result = runAudit(db, home);
    assert.ok(result.trimmings);
    const trim = result.trimmings.find((t) => t.fileName === 'CLAUDE.md');
    assert.ok(trim);
    assert.ok(trim.cuts.some((c) => c.type === 'stale_path'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
