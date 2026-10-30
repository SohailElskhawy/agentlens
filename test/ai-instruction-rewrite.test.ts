import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb, setSetting } from '../src/db.ts';
import { rewriteInstructions } from '../src/ai/instruction-rewrite.ts';
import { tmp, put } from './helpers.ts';

const duplicate = '- Always run the full test suite before merging changes.';
const stale = '- Remove obsolete docs/old-guide.md reference from this long instruction.';
const original = `# Rules\n${duplicate}\n${stale}\n- Keep the private contact person@example.com safe.\n## Essential\n- Preserve this important rule exactly.\n`;
const compact = '# Rules\n- Keep the private contact person@example.com safe.\n## Essential\n- Preserve this important rule exactly.\n';
const output = (cutIds: string[]) => async () => ({ ok: true, text: JSON.stringify({ cutIds }) });
function setup(text = original) { const db = openDb(':memory:'); const dir = tmp(); put(join(dir, 'CLAUDE.md'), duplicate + '\n'); const file = put(join(dir, 'AGENTS.md'), text); return { db, file, dir }; }
async function preview(db: ReturnType<typeof openDb>, file: string) { const p = await rewriteInstructions(db, file, { preview: true }); assert.equal(p.status, 'confirmation_required'); if (p.status !== 'confirmation_required') throw Error(); return p.preview; }

test('AI selects offered duplicate and stale cuts while protected text stays local', async () => {
  const { db, file } = setup(); setSetting(db, 'ai_enabled', 'true'); const p = await preview(db, file);
  assert.doesNotMatch(p.prompt, /person@example\.com/);
  const payload = JSON.parse(p.prompt.slice(p.prompt.indexOf('\n') + 1));
  assert.deepEqual(payload.cuts.map((c: { type: string }) => c.type), ['duplicate_line', 'stale_path']);
  const r = await rewriteInstructions(db, file, { runner: output(['cut-1', 'cut-2']), confirm: p.confirmationHash, apply: true });
  assert.equal(r.status, 'ok'); assert.equal(readFileSync(file, 'utf8'), compact); assert.equal(readFileSync(file + '.bak', 'utf8'), original); db.close();
});

test('requires enabled AI and exact preview and defaults to no write', async () => {
  const { db, file } = setup(); let calls = 0; const runner = async () => { calls++; return { ok: true, text: JSON.stringify({ cutIds: ['cut-1', 'cut-2'] }) }; };
  assert.equal((await rewriteInstructions(db, file, { runner })).status, 'error'); const p = await preview(db, file); setSetting(db, 'ai_enabled', 'true');
  assert.equal((await rewriteInstructions(db, file, { runner, confirm: 'a'.repeat(64) })).status, 'confirmation_required'); assert.equal(calls, 0);
  const r = await rewriteInstructions(db, file, { runner, confirm: p.confirmationHash }); assert.equal(r.status, 'ok'); assert.equal(calls, 1); assert.equal(readFileSync(file, 'utf8'), original); if (r.status === 'ok') assert.equal(r.applied, false); db.close();
});

test('rejects invalid IDs, unflagged content plans and insufficient savings', async () => {
  for (const response of [{ cutIds: ['cut-99'] }, { content: compact.replace('## Essential\n', '') }, { cutIds: [] }, { cutIds: ['cut-1', 'cut-1'] }]) {
    const { db, file } = setup(); setSetting(db, 'ai_enabled', 'true'); const p = await preview(db, file);
    const r = await rewriteInstructions(db, file, { runner: async () => ({ ok: true, text: JSON.stringify(response) }), confirm: p.confirmationHash });
    assert.equal(r.status, 'rejected'); if (r.status === 'rejected' && Array.isArray(response.cutIds) && response.cutIds.length === 0) assert.match(r.reason, /10%/);
    assert.equal(readFileSync(file, 'utf8'), original); assert.equal((db.prepare('SELECT count(*) AS n FROM ai_notes').get() as { n: number }).n, 0); db.close();
  }
});

test('never offers headings, fenced code or conflict cuts even if flagged', async () => {
  const code = Array.from({ length: 18 }, (_, i) => `code line ${i} with docs/missing.ts reference`).join('\n');
  const text = `${original}# docs/missing.md\ndocs/missing-title.md\n===\n\`\`\`\`\n~~~\n\`\`\`\n${code}\n\`\`\`\`\nUse npm install for this project.\nUse pnpm install for this project.\n`;
  const { db, file } = setup(text); const p = await preview(db, file); const payload = JSON.parse(p.prompt.slice(p.prompt.indexOf('\n') + 1));
  assert.deepEqual(payload.cuts.map((c: { type: string }) => c.type), ['duplicate_line', 'stale_path']); db.close();
});

test('apply guards changed files and existing backups', async () => {
  for (const mode of ['backup', 'changed']) {
    const { db, file } = setup(); setSetting(db, 'ai_enabled', 'true'); const p = await preview(db, file); if (mode === 'backup') put(file + '.bak', 'existing');
    const runner = async () => { if (mode === 'changed') writeFileSync(file, 'changed'); return { ok: true, text: JSON.stringify({ cutIds: ['cut-1', 'cut-2'] }) }; };
    assert.equal((await rewriteInstructions(db, file, { runner, confirm: p.confirmationHash, apply: true })).status, 'error'); assert.equal(readFileSync(file, 'utf8'), mode === 'changed' ? 'changed' : original); if (mode === 'backup') assert.equal(readFileSync(file + '.bak', 'utf8'), 'existing'); db.close();
  }
});

test('changed target or sibling invalidates consent; failed runner is not cached', async () => {
  for (const change of ['target', 'sibling']) {
    const { db, file, dir } = setup(); setSetting(db, 'ai_enabled', 'true'); const p = await preview(db, file);
    if (change === 'target') put(file, original + '- Another rule.\n'); else put(join(dir, 'CLAUDE.md'), duplicate + '\n' + stale + '\n');
    let calls = 0; const runner = async () => { calls++; return { ok: false, text: '' }; };
    assert.equal((await rewriteInstructions(db, file, { confirm: p.confirmationHash, runner })).status, 'confirmation_required'); assert.equal(calls, 0);
    const fresh = await preview(db, file); assert.equal((await rewriteInstructions(db, file, { confirm: fresh.confirmationHash, runner })).status, 'error'); assert.equal(calls, 1); db.close();
  }
});

test('no eligible cuts or no possible 10% savings avoids an AI call', async () => {
  for (const text of ['# Rules\n\n\n\n- Keep everything.\n', `# Rules\n${stale}\n${'- Keep this important rule.\n'.repeat(100)}`]) {
    const { db, file } = setup(text); setSetting(db, 'ai_enabled', 'true'); let calls = 0;
    assert.equal((await rewriteInstructions(db, file, { runner: async () => { calls++; return { ok: false, text: '' }; }, confirm: 'a'.repeat(64) })).status, 'error'); assert.equal(calls, 0); db.close();
  }
});

test('diff is accepted by git apply with and without trailing newline', async () => {
  for (const newline of [true, false]) {
    const { db, file, dir } = setup(newline ? original : original.trimEnd()); setSetting(db, 'ai_enabled', 'true'); const p = await preview(db, file);
    const r = await rewriteInstructions(db, file, { runner: output(['cut-1', 'cut-2']), confirm: p.confirmationHash }); if (r.status !== 'ok') throw Error(JSON.stringify(r));
    put(join(dir, 'd.patch'), r.diff + '\n'); const git = spawnSync('git', ['apply', 'd.patch'], { cwd: dir, encoding: 'utf8' }); assert.equal(git.status, 0, git.stderr); assert.equal(readFileSync(file, 'utf8'), newline ? compact : compact.trimEnd()); db.close();
  }
});

test('CLI requires explicit AI and provides preview without a call', () => {
  const { file, dir, db } = setup(); db.close(); openDb(join(dir, 'agentlens.db')).close();
  const run = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'optimize', file, ...args], { cwd: process.cwd(), env: { ...process.env, AGENTLENS_DATA_DIR: dir, AGENTLENS_STATE_DIR: dir, AGENTLENS_SOURCE_HOME: dir }, encoding: 'utf8' });
  assert.equal(run('--preview').status, 1); const result = run('--ai', '--preview', '--json'); assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).status, 'confirmation_required'); assert.equal(run('--ai').status, 1); assert.equal(readFileSync(file, 'utf8'), original);
});

test('validated cache respects settings and cap', async () => {
  const { db, file } = setup(); setSetting(db, 'ai_enabled', 'true'); const p = await preview(db, file); let calls = 0;
  const runner = async () => { calls++; return { ok: true, text: JSON.stringify({ cutIds: ['cut-1', 'cut-2'] }) }; };
  assert.equal((await rewriteInstructions(db, file, { runner, confirm: p.confirmationHash })).status, 'ok'); setSetting(db, 'ai_max_calls_per_day', '0'); assert.equal((await rewriteInstructions(db, file, { runner })).status, 'ok'); assert.equal(calls, 1); setSetting(db, 'ai_enabled', 'false'); assert.equal((await rewriteInstructions(db, file, { runner })).status, 'error'); db.close();
});

test('selection preserves unselected flagged lines and rejects invented code cuts', async () => {
  const { db, file } = setup(); setSetting(db, 'ai_enabled', 'true'); const p = await preview(db, file);
  const r = await rewriteInstructions(db, file, { runner: output(['cut-2']), confirm: p.confirmationHash });
  assert.equal(r.status, 'ok'); if (r.status === 'ok') { assert.match(r.diff, /\+- Always run the full test suite/); assert.match(r.diff, /\+- Preserve this important rule exactly/); }
  const invalid = await rewriteInstructions(db, file, { runner: output(['long_code_block']), confirm: p.confirmationHash });
  // Use a fresh database because a valid selection is cached for this input.
  db.close(); const other = openDb(':memory:'); setSetting(other, 'ai_enabled', 'true');
  const bad = await rewriteInstructions(other, file, { runner: output(['long_code_block']), confirm: p.confirmationHash }); assert.equal(bad.status, 'rejected');
  assert.equal(invalid.status, 'ok'); other.close();
});

const dupLong = '- Always run the full lint, typecheck and test gates before merging any branch — even for tiny fixes.';
const staleLong = '- Remove obsolete docs/old-guide.md reference from this long instruction right away — urgent.';
// Pad the last line with multibyte characters until the UTF-8 size matches so the fixture byte count is exact.
function sized(lines: string[], bytes: number) {
  const base = lines.join('\n');
  const missing = bytes - Buffer.byteLength(base, 'utf8') - 2;
  if (missing < 4) throw Error('fixture already exceeds target size');
  const rem = missing % 3;
  const pad = rem === 0 ? '—'.repeat(missing / 3) : rem === 2 ? '—'.repeat((missing - 2) / 3) + 'é' : '—'.repeat((missing - 4) / 3) + 'éé';
  return base + '\n' + pad + '\n';
}
const big = sized(['# Rules', ...Array<string>(40).fill(dupLong), ...Array<string>(4).fill(staleLong)], 10_439);
const tooBigPrompt = sized(['# Rules', ...Array<string>(150).fill(dupLong)], 20_000);

test('reads a ~10.4KB multibyte target and flows through preview, selection and apply', async () => {
  assert.equal(Buffer.byteLength(big, 'utf8'), 10_439);
  const { db, file, dir } = setup(big);
  put(join(dir, 'CLAUDE.md'), dupLong + '\n');
  setSetting(db, 'ai_enabled', 'true'); const p = await preview(db, file);
  assert.ok(p.prompt.length < 12000);
  const ids = JSON.parse(p.prompt.slice(p.prompt.indexOf('\n') + 1)).cuts.map((c: { id: string }) => c.id);
  assert.ok(ids.length >= 40);
  const r = await rewriteInstructions(db, file, { runner: output(ids), confirm: p.confirmationHash, apply: true });
  assert.equal(r.status, 'ok');
  const kept = readFileSync(file, 'utf8'); assert.ok(!kept.includes('quality gate') && !kept.includes('docs/old-guide.md'));
  assert.equal(readFileSync(file + '.bak', 'utf8'), big); db.close();
});

test('targets and siblings over the 64 KiB read budget fail before the analyst is invoked', async () => {
  const dir = tmp(); const path = put(join(dir, 'AGENTS.md'), 'x'.repeat(65_537));
  const db = openDb(':memory:'); setSetting(db, 'ai_enabled', 'true'); let calls = 0;
  const result = await rewriteInstructions(db, path, { runner: async () => { calls++; return { ok: true, text: '{}' }; }, confirm: 'a'.repeat(64) });
  assert.equal(result.status, 'error'); if (result.status !== 'error') throw Error();
  assert.match(result.message, /at most 65536 bytes/); assert.equal(calls, 0); db.close();
  const other = tmp(); const target = put(join(other, 'AGENTS.md'), original);
  put(join(other, 'CLAUDE.md'), 'y'.repeat(65_537)); const odb = openDb(':memory:');
  assert.equal((await rewriteInstructions(odb, target, { preview: true })).status, 'confirmation_required'); odb.close();
});

test('the 12000 character egress cap still bounds prompts built from the larger read budget', async () => {
  const { db, file, dir } = setup(tooBigPrompt);
  put(join(dir, 'CLAUDE.md'), dupLong + '\n');
  setSetting(db, 'ai_enabled', 'true'); let calls = 0;
  const result = await rewriteInstructions(db, file, { runner: async () => { calls++; return { ok: true, text: '{}' }; }, confirm: 'a'.repeat(64) });
  assert.equal(result.status, 'error'); if (result.status !== 'error') throw Error();
  assert.match(result.message, /12000 character prompt limit/); assert.equal(calls, 0); db.close();
});

test('bounded reads reject symlink and FIFO targets and ignore unsafe siblings', async () => {
  const { symlinkSync } = await import('node:fs');
  for (const kind of ['symlink', 'fifo', 'oversize']) {
    const dir = tmp(); const path = join(dir, 'AGENTS.md');
    if (kind === 'symlink') { const target = put(join(dir, 'other'), original); symlinkSync(target, path); }
    else if (kind === 'fifo') { assert.equal(spawnSync('mkfifo', [path]).status, 0); }
    else put(path, 'x'.repeat(10001));
    const db = openDb(':memory:'); assert.equal((await rewriteInstructions(db, path, { preview: true })).status, 'error'); db.close();
  }
  const dir = tmp(); const target = put(join(dir, 'AGENTS.md'), original); const external = put(join(dir, 'other'), duplicate); symlinkSync(external, join(dir, 'CLAUDE.md'));
  const db = openDb(':memory:'); const p = await preview(db, target); const payload = JSON.parse(p.prompt.slice(p.prompt.indexOf('\n') + 1)); assert.deepEqual(payload.cuts.map((c: { type: string }) => c.type), ['stale_path']); db.close();
});
