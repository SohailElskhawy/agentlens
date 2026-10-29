import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, upsertProject, getFindings, getRecommendations } from '../src/db.ts';
import { runAudit } from '../src/audit/runner.ts';

test('audit reports only actionable project instruction drift and removes it when fixed', () => {
  const root = mkdtempSync(join(process.cwd(), '.audit-drift-'));
  try {
    const home = join(root, 'home');
    const project = join(root, 'project');
    const other = join(root, 'other');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(home, '.claude/CLAUDE.md'), 'npm run globalmissing `src/global.ts`');
    writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node test' } }));
    writeFileSync(join(project, 'src/ok.ts'), '');
    writeFileSync(join(project, 'CLAUDE.md'), [
      'Run `npm run missing` and `npm run test`.',
      'Read `src/deleted.ts` and `src/ok.ts`.',
      'See https://example.com/src/url.ts and `/absolute/file.ts`.',
      'Ignore `src/*.ts`, `$ROOT/src/file.ts`, and package `@scope/pkg`.',
      'For example, use `src/example.ts`.',
    ].join('\n'));
    writeFileSync(join(other, 'AGENTS.md'), 'Run `npm run missing` and read `src/deleted.ts`.');
    writeFileSync(join(other, 'package.json'), '{invalid');
    mkdirSync(join(other, 'src'));
    writeFileSync(join(other, 'src/deleted.ts'), '');
    const db = openDb(':memory:');
    const id = upsertProject(db, project, 'project');
    upsertProject(db, other, 'other');
    const first = runAudit(db, home).findings.filter(f => f.rule === 'instruction_drift');
    assert.equal(first.length, 1);
    assert.equal(first[0].projectId, id);
    assert.deepEqual(first[0].evidence.references, [
      { kind: 'path', reference: 'src/deleted.ts', source: 'CLAUDE.md' },
      { kind: 'script', reference: 'missing', source: 'CLAUDE.md' },
    ]);
    assert.equal(first[0].estTokensWeek, 0);
    assert.match(getRecommendations(db).find(r => r.findingRule === 'instruction_drift')!.body, /src\/deleted\.ts.*npm run missing/);
    writeFileSync(join(project, 'src/deleted.ts'), '');
    writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: '', missing: '' } }));
    runAudit(db, home);
    assert.equal(getFindings(db).filter(f => f.rule === 'instruction_drift').length, 0);
    assert.equal(getRecommendations(db).filter(r => r.findingRule === 'instruction_drift').length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
