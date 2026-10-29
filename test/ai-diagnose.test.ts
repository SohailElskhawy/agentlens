import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, setSetting, upsertEvents, upsertFindings, upsertSessions } from '../src/db.ts';
import type { DB } from '../src/db.ts';
import { diagnoseSession, parseDiagnosis, prepareDiagnosis, renderDiagnosisMarkdown, worstSessions } from '../src/ai/diagnose.ts';
import { runAnalyst } from '../src/ai/runner.ts';
import { tmp } from './helpers.ts';

const good = {
  summary: 'Retry loop dominates this session',
  causes: [{ cause: 'Repeated Bash retries', evidence: 'retry_loop x3', est_tokens: 1200 }],
  fixes: [{ action: 'Stop after two retries', where: 'CLAUDE.md', snippet: 'Stop after two failed retries.' }],
};

function seed(db: DB, id = 's1', tokens = 50, projectId: number | null = null) {
  upsertSessions(db, [{ id, agent: 'claude', projectId, cwd: '/private/source' }]);
  upsertEvents(db, [{ id: `e-${id}`, agent: 'claude', sessionId: id, ts: 1, kind: 'assistant', model: 'claude-sonnet', input: 10, output: 5 }]);
  upsertFindings(db, [{ id: `f-${id}`, rule: 'retry_loop', projectId, sessionId: id, evidence: { tool: 'Bash', count: 3 }, confidence: 'high', confidenceReason: '', estTokensWeek: tokens, firstSeen: 1, lastSeen: 1 }]);
}

function enabled() {
  const db = openDb(':memory:');
  seed(db);
  setSetting(db, 'ai_enabled', 'true');
  return db;
}

function fake(text: string | Error, ok = true) {
  const calls: string[] = [];
  const runner = async (prompt: string) => {
    calls.push(prompt);
    if (text instanceof Error) throw text;
    return { ok, text, error: 'secret-runner-error' };
  };
  return Object.assign(runner, { calls });
}

const count = (db: DB, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const hashOf = (db: DB, id = 's1') => {
  const prepared = prepareDiagnosis(db, id);
  assert.equal(prepared.status, 'ready');
  return prepared.status === 'ready' ? prepared.preview.confirmationHash : '';
};

test('prepareDiagnosis returns a stable read-only descriptor and works with AI disabled', () => {
  const db = openDb(':memory:');
  seed(db);
  const before = count(db, 'settings');
  const a = prepareDiagnosis(db, 's1');
  const b = prepareDiagnosis(db, 's1');
  assert.deepEqual(a, b);
  assert.equal(a.status, 'ready');
  if (a.status !== 'ready') return;
  assert.match(a.preview.confirmationHash, /^[a-f0-9]{64}$/);
  assert.match(a.preview.inputHash, /^[a-f0-9]{64}$/);
  assert.notEqual(a.preview.confirmationHash, a.preview.inputHash);
  assert.equal(a.preview.agent, 'claude');
  assert.equal(a.preview.args.at(-1), a.preview.prompt);
  assert.ok(!JSON.stringify(a.preview).includes('/private/source'));
  assert.equal(count(db, 'settings'), before);
  assert.equal(count(db, 'ai_calls') + count(db, 'ai_notes'), 0);
  setSetting(db, 'ai_model', 'other-model');
  assert.notEqual(hashOf(db), a.preview.confirmationHash);
  db.close();
});

test('prepareDiagnosis reports unknown sessions, invalid settings and unsupported providers', () => {
  const db = openDb(':memory:');
  seed(db);
  assert.deepEqual(prepareDiagnosis(db, 'missing'), { status: 'error', code: 'UNKNOWN_SESSION', message: 'Unknown session ID' });
  setSetting(db, 'ai_agent', 'codex');
  const unsupported = prepareDiagnosis(db, 's1');
  assert.equal(unsupported.status === 'error' && unsupported.code, 'AI_PROVIDER_UNSUPPORTED');
  db.prepare("UPDATE settings SET value = 'maybe' WHERE key = 'ai_agent'").run();
  const invalid = prepareDiagnosis(db, 's1');
  assert.equal(invalid.status === 'error' && invalid.code, 'AI_INVALID_SETTINGS');
  db.close();
});

test('missing or stale confirmation returns a fresh preview without reserving or running', async () => {
  const db = enabled();
  const runner = fake(JSON.stringify(good));
  const missing = await diagnoseSession(db, 's1', { runner });
  assert.equal(missing.status, 'confirmation_required');
  const stale = await diagnoseSession(db, 's1', { runner, confirm: 'a'.repeat(64) });
  assert.equal(stale.status, 'confirmation_required');
  const hash = hashOf(db);
  setSetting(db, 'ai_model', 'changed-model');
  const changed = await diagnoseSession(db, 's1', { runner, confirm: hash });
  assert.equal(changed.status, 'confirmation_required');
  assert.equal(changed.status === 'confirmation_required' && changed.preview.model, 'changed-model');
  assert.equal(runner.calls.length, 0);
  assert.equal(count(db, 'ai_calls') + count(db, 'ai_notes'), 0);
  db.close();
});

test('exact confirmation reserves, runs once, caches normalized JSON and finalizes the call', async () => {
  const db = enabled();
  const runner = fake(`\`\`\`json\n${JSON.stringify({ ...good, extra: 'dropped' })}\n\`\`\``);
  const result = await diagnoseSession(db, 's1', { runner, confirm: hashOf(db) });
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(result.cached, false);
  assert.deepEqual(result.diagnosis, good);
  assert.equal(runner.calls.length, 1);
  const call = db.prepare('SELECT kind, agent, ok, duration_ms FROM ai_calls').get() as { kind: string; agent: string; ok: number; duration_ms: number };
  assert.equal(call.kind, 'diagnose');
  assert.equal(call.agent, 'claude');
  assert.equal(call.ok, 1);
  assert.ok(call.duration_ms >= 0);
  assert.equal((db.prepare('SELECT text FROM ai_notes').get() as { text: string }).text, JSON.stringify(good));
  // repeat reads the validated cache: no confirmation, no new reservation, no run
  const again = await diagnoseSession(db, 's1', { runner });
  assert.equal(again.status === 'ok' && again.cached, true);
  assert.equal(again.status === 'ok' && JSON.stringify(again.diagnosis), JSON.stringify(good));
  assert.equal(runner.calls.length, 1);
  assert.equal(count(db, 'ai_calls'), 1);
  db.close();
});

test('plain JSON is accepted and diagnosis never touches findings or recommendations', async () => {
  const db = enabled();
  const findings = db.prepare('SELECT * FROM findings ORDER BY id').all();
  const result = await diagnoseSession(db, 's1', { runner: fake(JSON.stringify(good)), confirm: hashOf(db) });
  assert.equal(result.status, 'ok');
  assert.deepEqual(db.prepare('SELECT * FROM findings ORDER BY id').all(), findings);
  assert.equal(count(db, 'recommendations'), 0);
  db.close();
});

test('cached validated results are readable at the daily cap but blocked when disabled or invalid', async () => {
  const db = enabled();
  await diagnoseSession(db, 's1', { runner: fake(JSON.stringify(good)), confirm: hashOf(db) });
  setSetting(db, 'ai_max_calls_per_day', '1');
  const runner = fake(JSON.stringify(good));
  const capped = await diagnoseSession(db, 's1', { runner });
  assert.equal(capped.status === 'ok' && capped.cached, true);
  setSetting(db, 'ai_enabled', 'false');
  const disabled = await diagnoseSession(db, 's1', { runner });
  assert.equal(disabled.status === 'error' && disabled.code, 'AI_DISABLED');
  setSetting(db, 'ai_enabled', 'true');
  db.prepare("UPDATE settings SET value = '-1' WHERE key = 'ai_max_calls_per_day'").run();
  const invalid = await diagnoseSession(db, 's1', { runner });
  assert.equal(invalid.status === 'error' && invalid.code, 'AI_INVALID_SETTINGS');
  assert.equal(runner.calls.length, 0);
  db.close();
});

test('cache misses at the cap fail with AI_DAILY_LIMIT and never run; disabled blocks confirmed calls', async () => {
  const db = enabled();
  setSetting(db, 'ai_max_calls_per_day', '0');
  const runner = fake(JSON.stringify(good));
  const capped = await diagnoseSession(db, 's1', { runner, confirm: hashOf(db) });
  assert.equal(capped.status === 'error' && capped.code, 'AI_DAILY_LIMIT');
  setSetting(db, 'ai_enabled', 'false');
  const disabled = await diagnoseSession(db, 's1', { runner, confirm: hashOf(db) });
  assert.equal(disabled.status === 'error' && disabled.code, 'AI_DISABLED');
  const unknown = await diagnoseSession(db, 'missing', { runner });
  assert.equal(unknown.status === 'error' && unknown.code, 'UNKNOWN_SESSION');
  assert.equal(runner.calls.length, 0);
  assert.equal(count(db, 'ai_calls') + count(db, 'ai_notes'), 0);
  db.close();
});

test('malformed, schema-invalid and oversized output is rejected, finalized as failed and never cached', async () => {
  const huge = { ...good, summary: 'x'.repeat(100_000) };
  const bad = ['not json', '{"summary":1}', JSON.stringify({ ...good, causes: [{ cause: 'c', evidence: 'e', est_tokens: -1 }] }),
    JSON.stringify({ ...good, causes: [{ cause: 'c', evidence: 'e', est_tokens: '5' }] }),
    JSON.stringify({ ...good, fixes: [{ action: 'a', where: 'w' }] }), JSON.stringify(huge), '[]', 'null',
    JSON.stringify({ ...good, causes: Array(500).fill(good.causes[0]) })];
  for (const text of bad) {
    const db = enabled();
    const result = await diagnoseSession(db, 's1', { runner: fake(text), confirm: hashOf(db) });
    assert.equal(result.status === 'error' && result.code, 'AI_INVALID_OUTPUT', text.slice(0, 40));
    assert.equal(count(db, 'ai_notes'), 0);
    assert.equal((db.prepare('SELECT ok FROM ai_calls').get() as { ok: number }).ok, 0);
    db.close();
  }
});

test('runner failures and throws are sanitized, counted against the cap and not cached', async () => {
  const db = enabled();
  const thrown = await diagnoseSession(db, 's1', { runner: fake(new Error('leak: sk-abcdefghijk123456789 prompt output')), confirm: hashOf(db) });
  assert.equal(thrown.status === 'error' && thrown.code, 'AI_RUN_FAILED');
  const failed = await diagnoseSession(db, 's1', { runner: fake('', false), confirm: hashOf(db) });
  assert.equal(failed.status === 'error' && failed.code, 'AI_RUN_FAILED');
  for (const r of [thrown, failed]) {
    const text = JSON.stringify(r);
    for (const secret of ['sk-abcdefghijk', 'secret-runner-error', 'leak', 'retry_loop', '--safe-mode']) assert.ok(!text.includes(secret), secret);
  }
  assert.deepEqual((db.prepare('SELECT ok FROM ai_calls ORDER BY id').all() as { ok: number }[]).map(r => r.ok), [0, 0]);
  assert.equal(count(db, 'ai_notes'), 0);
  db.close();
});

test('parseDiagnosis accepts plain and fenced JSON only in the exact shape', () => {
  assert.deepEqual(parseDiagnosis(JSON.stringify(good)), good);
  assert.deepEqual(parseDiagnosis(`\n\`\`\`\n${JSON.stringify(good)}\n\`\`\`\n`), good);
  assert.equal(parseDiagnosis(`Here you go: ${JSON.stringify(good)}`), null);
  assert.deepEqual(parseDiagnosis(JSON.stringify({ summary: '', causes: [], fixes: [] })), { summary: '', causes: [], fixes: [] });
});

test('markdown render shows estimates without claiming realized savings', () => {
  const md = renderDiagnosisMarkdown({ ...good, fixes: [{ action: 'a', where: 'w', snippet: '```js\nx\n```' }] });
  assert.ok(md.includes(good.summary) && md.includes('1,200'));
  assert.match(md, /estimate/i);
  assert.ok(!/sav(?:e|ed|ing|ings)\b|realized/i.test(md));
  assert.ok(md.includes('````'));
});

test('worstSessions orders by summed finding estimates, ties by id, optionally per project', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (root, name) VALUES ('/p1', 'p1')").run();
  const project = (db.prepare("SELECT id FROM projects WHERE root = '/p1'").get() as { id: number }).id;
  seed(db, 'b', 100, project);
  seed(db, 'a', 100, project);
  seed(db, 'c', 500, null);
  upsertFindings(db, [{ id: 'extra', rule: 'big_output', projectId: project, sessionId: 'a', evidence: { tool: 'Read', count: 1 }, confidence: 'high', confidenceReason: '', estTokensWeek: 5, firstSeen: 1, lastSeen: 1 }]);
  assert.deepEqual(worstSessions(db, 10), ['c', 'a', 'b']);
  assert.deepEqual(worstSessions(db, 2), ['c', 'a']);
  assert.deepEqual(worstSessions(db, 10, project), ['a', 'b']);
  assert.deepEqual(worstSessions(db, 10, 999), []);
  db.close();
});

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

// PATH is empty and AI is never confirmed, so these runs cannot reach a real agent CLI.
test('diagnose CLI validates arguments before any call and previews without AI enabled', () => {
  const dir = tmp();
  const db = openDb(join(dir, 'agentlens.db'));
  seed(db, 's1', 50);
  seed(db, 's2', 90);
  db.close();
  const run = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', cli, 'diagnose', ...args],
    { env: { ...process.env, AGENTLENS_DATA_DIR: dir, AGENTLENS_STATE_DIR: dir, AGENTLENS_SOURCE_HOME: dir, PATH: '' }, encoding: 'utf8' });
  const hash = 'a'.repeat(64);
  for (const args of [[], ['s1', 's2'], ['--worst', '0'], ['--worst', 'abc'], ['--worst', '1.5'], ['--worst', '9999'], ['s1', '--worst', '1'],
    ['--project', '/x', 's1'], ['s1', '--preview', '--confirm', hash], ['s1', '--confirm', 'nothex'], ['--bogus'], ['--worst', '1', '--project', '']]) {
    const r = run(...args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr, /usage|worst|project|confirm|option/i, args.join(' '));
  }
  const unknown = run('missing', '--preview');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown session/i);
  const single = run('s1', '--preview', '--json');
  assert.equal(single.status, 0, single.stderr);
  const parsed = JSON.parse(single.stdout);
  assert.match(parsed.confirmationHash ?? parsed[0]?.preview?.confirmationHash, /^[a-f0-9]{64}$/);
  const batch = run('--worst', '2', '--preview');
  assert.equal(batch.status, 0, batch.stderr);
  assert.ok(batch.stdout.indexOf('s2') < batch.stdout.indexOf('s1'));
  assert.equal((batch.stdout.match(/[a-f0-9]{64}/g) ?? []).length >= 2, true);
  const disabled = run('s1');
  assert.notEqual(disabled.status, 0);
  assert.match(disabled.stderr, /AI_DISABLED/);
  const dbAfter = openDb(join(dir, 'agentlens.db'));
  setSetting(dbAfter, 'ai_enabled', 'true');
  dbAfter.close();
  const needsConfirm = run('s1', '--confirm', hash);
  assert.notEqual(needsConfirm.status, 0);
  assert.match(needsConfirm.stderr, /confirm/i);
  const check = openDb(join(dir, 'agentlens.db'));
  assert.equal(count(check, 'ai_calls') + count(check, 'ai_notes'), 0);
  check.close();
});

test('a failed capability probe gives upgrade guidance and consumes the reserved attempt', async () => {
  const db = enabled();
  let calls = 0;
  const result = await diagnoseSession(db, 's1', {
    confirm: hashOf(db),
    runner: (prompt, opts) => runAnalyst(prompt, { ...opts, exec: async (_bin, args) => {
      calls++;
      assert.ok(args.includes('--help'));
      assert.ok(!args.includes(prompt));
      return { stdout: 'unsupported old help', stderr: 'private output' };
    } }),
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'error');
  if (result.status === 'error') {
    assert.equal(result.code, 'AI_RUN_FAILED');
    assert.match(result.message, /upgrade Claude Code/i);
    assert.ok(!result.message.includes('private output'));
  }
  assert.equal(count(db, 'ai_calls'), 1);
  assert.equal((db.prepare('SELECT ok FROM ai_calls').get() as { ok: number }).ok, 0);
  assert.equal(count(db, 'ai_notes'), 0);
  db.close();
});
