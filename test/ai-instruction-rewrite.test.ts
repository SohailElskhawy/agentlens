import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, setSetting } from '../src/db.ts';
import { rewriteInstructions } from '../src/ai/instruction-rewrite.ts';
import { tmp, put } from './helpers.ts';

const original = '# Rules\n\n\n\n- Keep all tests passing.\n\n\n\n- Never execute generated commands.\n\n\n\n';
const compact = '# Rules\n- Keep all tests passing.\n- Never execute generated commands.\n';
const output = (text: string) => async () => ({ ok: true, text: JSON.stringify({ content: text }) });
function setup() { const db = openDb(':memory:'); const file = put(join(tmp(), 'AGENTS.md'), original); return { db, file }; }

test('requires enabled AI and exact preview; sends redacted payload and leaves file intact', async () => {
  const { db, file } = setup(); let calls = 0;
  const runner = async () => { calls++; return { ok: true, text: JSON.stringify({ content: compact }) }; };
  assert.equal((await rewriteInstructions(db, file, { runner })).status, 'error');
  const p = await rewriteInstructions(db, file, { preview: true }); assert.equal(p.status, 'confirmation_required'); if (p.status !== 'confirmation_required') throw Error();
  setSetting(db, 'ai_enabled', 'true');
  assert.equal((await rewriteInstructions(db, file, { runner, confirm: 'a'.repeat(64) })).status, 'confirmation_required');
  assert.equal(calls, 0);
  const r = await rewriteInstructions(db, file, { runner, confirm: p.preview.confirmationHash });
  assert.equal(r.status, 'ok'); assert.equal(calls, 1); assert.equal(readFileSync(file, 'utf8'), original);
  if (r.status === 'ok') { assert.match(r.diff, /--- a\/AGENTS.md/); assert.equal(r.applied, false); }
  db.close();
});

test('rejects small savings and loss of headings or rules with a diff', async () => {
  for (const [candidate, reason] of [[original, '10%'], [compact.replace('# Rules', '# Other'), 'heading'], [compact.replace('- Keep all tests passing.\n', ''), 'rule']]) {
    const { db, file } = setup(); setSetting(db, 'ai_enabled', 'true');
    const p = await rewriteInstructions(db, file, { preview: true }); if (p.status !== 'confirmation_required') throw Error();
    const r = await rewriteInstructions(db, file, { runner: output(candidate), confirm: p.preview.confirmationHash });
    assert.equal(r.status, 'rejected'); if (r.status === 'rejected') { assert.match(r.reason, new RegExp(reason, 'i')); assert.ok(r.diff); }
    assert.equal(readFileSync(file, 'utf8'), original); db.close();
  }
});

test('apply backs up once and guards changed files and existing backups', async () => {
  for (const mode of ['apply', 'backup', 'changed']) {
    const { db, file } = setup(); setSetting(db, 'ai_enabled', 'true');
    const p = await rewriteInstructions(db, file, { preview: true }); if (p.status !== 'confirmation_required') throw Error();
    if (mode === 'backup') put(file + '.bak', 'existing');
    const runner = async () => { if (mode === 'changed') writeFileSync(file, 'changed'); return { ok: true, text: JSON.stringify({ content: compact }) }; };
    const r = await rewriteInstructions(db, file, { runner, confirm: p.preview.confirmationHash, apply: true });
    if (mode === 'apply') { assert.equal(r.status, 'ok'); assert.equal(readFileSync(file, 'utf8'), compact); assert.equal(readFileSync(file + '.bak', 'utf8'), original); }
    else { assert.equal(r.status, 'error'); assert.equal(readFileSync(file, 'utf8'), mode === 'changed' ? 'changed' : original); if (mode === 'backup') assert.equal(readFileSync(file + '.bak', 'utf8'), 'existing'); }
    db.close();
  }
});

test('stale content and failed runner never send without matching consent', async () => {
  const { db, file } = setup(); setSetting(db, 'ai_enabled', 'true');
  const p = await rewriteInstructions(db, file, { preview: true }); if (p.status !== 'confirmation_required') throw Error();
  put(file, original + '\n\n\n- Another rule.\n'); let calls = 0;
  const runner = async () => { calls++; return { ok: false, text: '' }; };
  assert.equal((await rewriteInstructions(db, file, { confirm: p.preview.confirmationHash, runner })).status, 'confirmation_required'); assert.equal(calls, 0);
  const fresh = await rewriteInstructions(db, file, { preview: true }); if (fresh.status !== 'confirmation_required') throw Error();
  assert.equal((await rewriteInstructions(db, file, { confirm: fresh.preview.confirmationHash, runner })).status, 'error'); assert.equal(calls, 1);
  db.close();
});

test('refuses before any request when redaction would alter the file or blank lines cannot save 10%', async () => {
  for (const text of [original + 'Contact person@example.com\n', original + 'See /home/alice/notes.md\n', '# Rules\n- One.\n- Two.\n']) {
    const { db, file } = setup(); setSetting(db, 'ai_enabled', 'true'); put(file, text); let calls = 0;
    const runner = async () => { calls++; return { ok: true, text: JSON.stringify({ content: compact }) }; };
    for (const opts of [{ preview: true }, { runner, confirm: 'a'.repeat(64) }]) {
      const r = await rewriteInstructions(db, file, opts); assert.equal(r.status, 'error');
    }
    assert.equal(calls, 0); assert.equal(readFileSync(file, 'utf8'), text); db.close();
  }
});

test('diff is a real unified diff that git apply accepts, with and without trailing newline', async () => {
  const { spawnSync } = await import('node:child_process');
  for (const [orig, cand] of [[original, compact], ['# Rules\n\n\n\n\n\n- Keep all tests passing.\n\n\n\n\n\n- Never execute generated commands.', compact.trimEnd()]]) {
    const { db, file } = setup(); setSetting(db, 'ai_enabled', 'true'); put(file, orig);
    const p = await rewriteInstructions(db, file, { preview: true }); if (p.status !== 'confirmation_required') throw Error();
    const r = await rewriteInstructions(db, file, { runner: output(cand), confirm: p.preview.confirmationHash });
    if (r.status !== 'ok') throw Error(JSON.stringify(r));
    const dir = join(file, '..'); put(join(dir, 'd.patch'), r.diff + '\n');
    const git = spawnSync('git', ['apply', '--unsafe-paths', '--directory=.', 'd.patch'], { cwd: dir, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr); assert.equal(readFileSync(file, 'utf8'), cand); db.close();
  }
});

test('CLI requires explicit AI and provides a preview without a call', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = tmp(); const file = put(join(dir, 'CLAUDE.md'), original); const db = openDb(join(dir, 'agentlens.db')); db.close();
  const run = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'optimize', file, ...args], { cwd: process.cwd(), env: { ...process.env, AGENTLENS_DATA_DIR: dir, AGENTLENS_STATE_DIR: dir, AGENTLENS_SOURCE_HOME: dir }, encoding: 'utf8' });
  assert.equal(run('--preview').status, 1);
  const preview = run('--ai', '--preview', '--json'); assert.equal(preview.status, 0); assert.equal(JSON.parse(preview.stdout).status, 'confirmation_required');
  assert.equal(run('--ai').status, 1); assert.equal(readFileSync(file, 'utf8'), original);
});

test('invalid results are not cached and validated cache respects settings and cap', async () => {
  const { db, file } = setup(); setSetting(db, 'ai_enabled', 'true'); let calls = 0;
  const p = await rewriteInstructions(db, file, { preview: true }); if (p.status !== 'confirmation_required') throw Error();
  const invalid = async () => { calls++; return { ok: true, text: JSON.stringify({ content: original }) }; };
  assert.equal((await rewriteInstructions(db, file, { runner: invalid, confirm: p.preview.confirmationHash })).status, 'rejected');
  assert.equal((db.prepare('SELECT count(*) AS n FROM ai_notes').get() as { n: number }).n, 0);
  const valid = async () => { calls++; return { ok: true, text: JSON.stringify({ content: compact }) }; };
  assert.equal((await rewriteInstructions(db, file, { runner: valid, confirm: p.preview.confirmationHash })).status, 'ok');
  setSetting(db, 'ai_max_calls_per_day', '0'); assert.equal((await rewriteInstructions(db, file, { runner: valid })).status, 'ok'); assert.equal(calls, 2);
  setSetting(db, 'ai_enabled', 'false'); assert.equal((await rewriteInstructions(db, file, { runner: valid })).status, 'error'); assert.equal(calls, 2); db.close();
});
