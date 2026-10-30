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

test('audit skips labeled example fences but checks required fenced commands', () => {
  const root = mkdtempSync(join(process.cwd(), '.audit-drift-'));
  try {
    const home = join(root, 'home'); const project = join(root, 'project');
    mkdirSync(home); mkdirSync(project);
    writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node test' } }));
    writeFileSync(join(project, 'CLAUDE.md'), '# Examples\n```sh\nnpm run hypothetical\n```\n## Nested example\n```sh\nnpm run another-example\n```\n# Usage\nFor example:\n\n```sh\nnpm run sample\n```\n# Verification\n```sh\nnpm run required\n```\n');
    const db = openDb(':memory:'); upsertProject(db, project, 'project');
    const findings = runAudit(db, home).findings.filter(f => f.rule === 'instruction_drift');
    assert.deepEqual(findings[0].evidence.references, [{ kind: 'script', reference: 'required', source: 'CLAUDE.md' }]);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('subsequent audit preserves accepted and measuring recommendations and unrelated IDs', () => {
  const root = mkdtempSync(join(process.cwd(), '.audit-drift-'));
  try {
    const home = join(root, 'home'); mkdirSync(home);
    const db = openDb(':memory:');
    const ids = ['open', 'accepted', 'measuring'].map(name => {
      const project = join(root, name); mkdirSync(project);
      writeFileSync(join(project, 'package.json'), '{"scripts":{}}');
      writeFileSync(join(project, 'CLAUDE.md'), 'Run `npm run missing`.');
      return upsertProject(db, project, name);
    });
    runAudit(db, home);
    const recIds = ids.map(id => `rec:instruction_drift:${id}:instruction_drift:proj_${id}`);
    db.prepare("UPDATE recommendations SET status = ?, accepted_at = 123 WHERE id = ?").run('accepted', recIds[1]);
    db.prepare("UPDATE recommendations SET status = ?, accepted_at = 456 WHERE id = ?").run('measuring', recIds[2]);
    db.prepare("INSERT INTO recommendations (id, finding_rule, action, title, body, status) VALUES (?, 'instruction_drift', 'review', 'unrelated', '', 'open')").run('unrelated-id');
    for (const name of ['open', 'accepted', 'measuring']) writeFileSync(join(root, name, 'CLAUDE.md'), 'No commands.');
    runAudit(db, home);
    assert.equal(getFindings(db).filter(f => f.rule === 'instruction_drift').length, 0);
    const remaining = getRecommendations(db).filter(r => r.findingRule === 'instruction_drift');
    assert.deepEqual(remaining.map(r => r.id).sort(), [recIds[1], recIds[2], 'unrelated-id'].sort());
    assert.equal(remaining.find(r => r.id === recIds[1])?.status, 'accepted');
    assert.equal(remaining.find(r => r.id === recIds[2])?.status, 'measuring');
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
