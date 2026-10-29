import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { openDb, setSetting, upsertEvents, upsertFindings, upsertSessions } from '../src/db.ts';
import { evaluateDiagnoses } from '../scripts/eval-diagnose.ts';
import { tmp } from './helpers.ts';

function fixture() {
  const root = tmp(); const snapshotPath = join(root, 'snapshot.db'); const outputDir = join(root, 'output');
  mkdirSync(outputDir); const db = openDb(snapshotPath);
  for (let i = 0; i < 11; i++) {
    const id = `s${String(i).padStart(2, '0')}`;
    upsertSessions(db, [{ id, agent: 'claude', projectId: null, cwd: '/private/source' }]);
    upsertEvents(db, [{ id: `e${id}`, agent: 'claude', sessionId: id, ts: 1, kind: 'assistant', input: i }]);
    upsertFindings(db, [{ id: `f${id}`, rule: 'retry_loop', sessionId: id, projectId: null, evidence: { tool: 'Bash', count: 3 }, confidence: 'high', confidenceReason: '', estTokensWeek: i, firstSeen: 1, lastSeen: 1 }]);
  }
  setSetting(db, 'ai_max_calls_per_day', '2'); setSetting(db, 'secret', 'do-not-copy'); db.close();
  return { evalRoot: root, snapshotPath, outputDir };
}

test('preview requires ten deterministic sessions and manifest approval plus opt-in before any runner call', async () => {
  const opts = fixture(); let calls = 0;
  const runner = async () => { calls++; return { ok: true, text: JSON.stringify({ summary: 'ok', causes: [], fixes: [] }) }; };
  const preview = await evaluateDiagnoses({ ...opts, runner, env: {} });
  assert.equal(preview.status, 'preview'); assert.equal(preview.manifest.sessions.length, 10);
  assert.deepEqual(preview.manifest.sessions.map(s => s.sessionId), ['s10','s09','s08','s07','s06','s05','s04','s03','s02','s01']);
  assert.match(preview.manifestHash, /^[a-f0-9]{64}$/);
  const artifact = readFileSync(join(opts.outputDir, 'preview.json'), 'utf8');
  assert.ok(!artifact.includes('/private/source')); assert.ok(!artifact.includes('do-not-copy'));
  assert.ok(!artifact.includes('Analyze this')); assert.ok(!artifact.includes(opts.snapshotPath));
  await assert.rejects(evaluateDiagnoses({ ...opts, runner, env: { AGENTLENS_EVAL_AI: '1' }, confirmationHash: '0'.repeat(64) }));
  await assert.rejects(evaluateDiagnoses({ ...opts, runner, env: {}, confirmationHash: preview.manifestHash }));
  assert.equal(calls, 0);
  const run = await evaluateDiagnoses({ ...opts, runner, env: { AGENTLENS_EVAL_AI: '1' }, confirmationHash: preview.manifestHash });
  assert.equal(run.status, 'complete'); assert.equal(calls, 2);
  assert.equal(run.results.filter(r => r.status === 'ok').length, 2);
  assert.equal(run.results.filter(r => r.status === 'error' && r.code === 'AI_DAILY_LIMIT').length, 8);
  const report = readFileSync(join(opts.outputDir, 'results.md'), 'utf8');
  assert.match(report, /unverified/i); assert.ok(!report.includes(opts.snapshotPath));
  const source = openDb(opts.snapshotPath);
  assert.equal((source.prepare('SELECT count(*) AS n FROM ai_calls').get() as { n: number }).n, 0);
  assert.equal((source.prepare("SELECT value FROM settings WHERE key='ai_enabled'").get()), undefined); source.close();
});

test('changed snapshot invalidates manifest and too few sessions cannot execute', async () => {
  const opts = fixture(); let calls = 0; const runner = async () => { calls++; return { ok: false, text: '' }; };
  const preview = await evaluateDiagnoses({ ...opts, runner, env: {} });
  const db = openDb(opts.snapshotPath); db.prepare("UPDATE events SET input = 999 WHERE session_id = 's10'").run(); db.close();
  await assert.rejects(evaluateDiagnoses({ ...opts, runner, env: { AGENTLENS_EVAL_AI: '1' }, confirmationHash: preview.manifestHash }));
  const db2 = openDb(opts.snapshotPath); db2.prepare('DELETE FROM findings').run(); db2.close();
  await assert.rejects(evaluateDiagnoses({ ...opts, runner, env: {} })); assert.equal(calls, 0);
});

test('invalid model output and runner failures are reported individually without leaking runner text', async () => {
  const opts = fixture(); let calls = 0;
  const runner = async () => { calls++; if (calls === 1) throw new Error('/private/source secret'); return { ok: true, text: 'invalid model output' }; };
  const preview = await evaluateDiagnoses({ ...opts, env: {}, runner });
  const run = await evaluateDiagnoses({ ...opts, env: { AGENTLENS_EVAL_AI: '1' }, runner, confirmationHash: preview.manifestHash });
  assert.deepEqual(run.results.slice(0, 2).map(r => r.status === 'error' && r.code), ['AI_RUN_FAILED', 'AI_INVALID_OUTPUT']);
  assert.equal(calls, 2);
  const output = readFileSync(join(opts.outputDir, 'results.json'), 'utf8');
  assert.ok(!output.includes('/private/source')); assert.ok(!output.includes('invalid model output'));
});

test('model changes invalidate confirmation and snapshot must stay inside the evaluation root', async () => {
  const opts = fixture(); let calls = 0; const runner = async () => { calls++; return { ok: false, text: '' }; };
  const preview = await evaluateDiagnoses({ ...opts, env: {}, runner });
  const db = openDb(opts.snapshotPath); setSetting(db, 'ai_model', 'changed'); db.close();
  await assert.rejects(evaluateDiagnoses({ ...opts, env: { AGENTLENS_EVAL_AI: '1' }, runner, confirmationHash: preview.manifestHash }));
  await assert.rejects(evaluateDiagnoses({ ...opts, evalRoot: opts.outputDir, env: {}, runner }));
  assert.equal(calls, 0);
});


test('CLI previews with an empty PATH and refuses an unconfirmed execution hash', () => {
  const opts = fixture(); const cli = fileURLToPath(new URL('../scripts/eval-diagnose.ts', import.meta.url));
  const run = (confirm?: string) => spawnSync(process.execPath, ['--no-warnings', cli, opts.evalRoot, opts.snapshotPath, opts.outputDir, ...(confirm ? [confirm] : [])],
    { encoding: 'utf8', env: { ...process.env, PATH: '', AGENTLENS_EVAL_AI: '1' } });
  const preview = run(); assert.equal(preview.status, 0); assert.match(preview.stdout, /^preview: manifest [a-f0-9]{64}/);
  const wrong = run('0'.repeat(64)); assert.notEqual(wrong.status, 0);
});
