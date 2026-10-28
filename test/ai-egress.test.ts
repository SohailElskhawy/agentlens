import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, setSetting, upsertEvents, upsertFindings, upsertSessions } from '../src/db.ts';
import { redact, buildPrompt, sessionDigest } from '../src/ai/payload.ts';
import { cached } from '../src/ai/cache.ts';
import { prepareDiagnosis } from '../src/ai/diagnose.ts';
import { buildAnalystCommand, runAnalyst } from '../src/ai/runner.ts';
import { tmp } from './helpers.ts';

const secrets = ['sk-abcdefghijk123456789', 'sk-proj-abcdefghijk123456789', 'sk_proj_abcdefghijk123456789',
  'ghp_abcdefghijk123456789', 'github_pat_abcdefghijk123456789', 'AKIA1234567890ABCDEF',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345',
  'alice@example.com', '/home/alice/project', '/Users/alice/project', 'C:\\Users\\alice\\project',
  'API_KEY=unusual-secret-value'];

test('redacts common credentials, env lines, emails and home paths', () => {
  for (const secret of secrets) assert.ok(!redact(secret).includes(secret), secret);
  assert.equal(redact('ordinary metadata'), 'ordinary metadata');
});

test('redacts multiline values before JSON escaping, caps and hashes the exact prompt', () => {
  const data = { nested: ['before\nAPI_KEY=multiline-secret\nafter', 'x'.repeat(13000)] };
  const result = buildPrompt('diagnose', data);
  assert.ok(!result.prompt.includes('multiline-secret'));
  assert.ok(result.prompt.length <= 12000);
  assert.match(result.prompt, /truncated/i);
  assert.equal(result.inputHash, createHash('sha256').update(result.prompt).digest('hex'));
  assert.deepEqual(buildPrompt('diagnose', data), result);
});

test('cache isolates kind, hash, agent and model and never stores failed generation', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  const generate = async () => ({ ok: true, text: `answer-${++calls}` });
  const opts = { agent: 'claude' as const, model: 'one' };
  assert.equal((await cached(db, 'diagnose', 'a'.repeat(64), generate, opts)).text, 'answer-1');
  assert.equal((await cached(db, 'diagnose', 'a'.repeat(64), generate, opts)).text, 'answer-1');
  await cached(db, 'other', 'a'.repeat(64), generate, opts);
  await cached(db, 'diagnose', 'b'.repeat(64), generate, opts);
  await cached(db, 'diagnose', 'a'.repeat(64), generate, { agent: 'codex', model: 'one' });
  await cached(db, 'diagnose', 'a'.repeat(64), generate, { agent: 'claude', model: 'two' });
  assert.equal(calls, 5);
  let failures = 0;
  const fail = async () => { failures++; return { ok: false, text: '' }; };
  await cached(db, 'diagnose', 'c'.repeat(64), fail, opts);
  await cached(db, 'diagnose', 'c'.repeat(64), fail, opts);
  assert.equal(failures, 2);
  await assert.rejects(cached(db, 'diagnose', 'd'.repeat(64), async () => { throw Error('failed'); }, opts));
  assert.equal((db.prepare('SELECT count(*) AS n FROM ai_notes').get() as { n: number }).n, 5);
  db.close();
});

test('session digest excludes arbitrary evidence, identifiers, paths and private source text', () => {
  const db = openDb(':memory:');
  upsertSessions(db, [{ id: 's1', agent: 'claude', projectId: null, cwd: '/private/source' }]);
  upsertEvents(db, [{ id: 'e1', agent: 'claude', sessionId: 's1', ts: 1, kind: 'assistant', model: 'model', input: 42, output: 4, textHash: 'private-hash' }]);
  upsertFindings(db, [{ id: 'private-id', rule: 'retry_loop', projectId: null, sessionId: 's1', evidence: { tool: 'Bash', count: 3, raw: 'private-source-text' }, confidence: 'high', confidenceReason: 'private-reason', estTokensWeek: 50, firstSeen: 1, lastSeen: 1 }]);
  const digest = JSON.stringify(sessionDigest(db, 's1'));
  for (const value of ['private-source-text', 'private-reason', 'private-id', 'private-hash', '/private/source']) assert.ok(!digest.includes(value));
  for (const value of ['retry_loop', 'Bash', '42']) assert.ok(digest.includes(value));
  assert.equal(sessionDigest(db, 'unknown'), null);
  db.close();
});

test('preview is exact, read-only, works disabled and rejects unsupported providers and unknown input', async () => {
  const dir = tmp();
  const db = openDb(join(dir, 'agentlens.db'));
  upsertSessions(db, [{ id: 's1', agent: 'claude', projectId: null, cwd: '/secret/source' }]);
  setSetting(db, 'ai_model', 'example-model');
  const prompt = buildPrompt('diagnose', sessionDigest(db, 's1')).prompt;
  const command = buildAnalystCommand(prompt, { agent: 'claude', model: 'example-model' });
  let actual: unknown;
  await runAnalyst(prompt, { agent: 'claude', model: 'example-model', exec: async (bin, args) => { actual = { bin, args }; return { stdout: '{"result":"ok"}', stderr: '' }; } });
  assert.deepEqual(actual, command);
  const descriptor = prepareDiagnosis(db, 's1');
  assert.ok(descriptor.status === 'ready');
  const prepared = descriptor.status === 'ready' ? descriptor.preview : null;
  assert.deepEqual({ prompt: prepared?.prompt, bin: prepared?.bin, args: prepared?.args }, { prompt, ...command });
  assert.match(prepared?.confirmationHash ?? '', /^[a-f0-9]{64}$/);
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', cli, 'ai', 'preview', ...args], { env: { ...process.env, AGENTLENS_DATA_DIR: dir, AGENTLENS_STATE_DIR: dir, AGENTLENS_SOURCE_HOME: dir, PATH: '' }, encoding: 'utf8' });
  const preview = run('session', 's1');
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout), prepared);
  assert.ok(!preview.stdout.includes('/secret/source'));
  assert.equal((db.prepare('SELECT count(*) AS n FROM ai_calls').get() as { n: number }).n, 0);
  const unknownKind = run('other', 's1');
  assert.notEqual(unknownKind.status, 0);
  assert.match(unknownKind.stderr, /usage/i);
  const unknownSession = run('diagnose', 'missing');
  assert.notEqual(unknownSession.status, 0);
  assert.match(unknownSession.stderr, /unknown session/i);
  assert.deepEqual(JSON.parse(run('diagnose', 's1').stdout), JSON.parse(preview.stdout));
  assert.equal((db.prepare('SELECT count(*) AS n FROM ai_notes').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT count(*) AS n FROM settings').get() as { n: number }).n, 1);
  setSetting(db, 'ai_agent', 'codex');
  const unsupported = run('diagnose', 's1');
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /not supported/i);
  db.close();
});

test('escaped multiline JSON and secret object keys do not bypass redaction', () => {
  const secret = 'escaped-secret-value';
  const key = 'sk-proj-abcdefghijk123456789';
  const { prompt } = buildPrompt('diagnose', { nested: JSON.stringify({ config: `before\nAPI_KEY=${secret}\nafter` }), [key]: 'value' });
  assert.ok(!prompt.includes(secret));
  assert.ok(!prompt.includes(key));
});

test('cache rejects non-hash input before recording anything', async () => {
  const db = openDb(':memory:');
  await assert.rejects(cached(db, 'diagnose', 'raw secret prompt', async () => ({ ok: true, text: 'answer' })));
  assert.equal((db.prepare('SELECT count(*) AS n FROM ai_notes').get() as { n: number }).n, 0);
  db.close();
});

test('preview errors do not expose malformed finding evidence', () => {
  const dir = tmp();
  const db = openDb(join(dir, 'agentlens.db'));
  upsertSessions(db, [{ id: 's1', agent: 'claude', projectId: null }]);
  db.prepare("INSERT INTO findings VALUES ('f', 'retry_loop', NULL, 's1', ?, 'high', '', 0, 0, 0)").run('private-invalid-evidence');
  db.close();
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--no-warnings', cli, 'ai', 'preview', 'session', 's1'], {
    env: { ...process.env, AGENTLENS_DATA_DIR: dir, AGENTLENS_SOURCE_HOME: dir, AGENTLENS_STATE_DIR: dir }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.ok(!result.stderr.includes('private-invalid-evidence'));
});

test('long sessions keep findings and tools inside the capped prompt', () => {
  const db = openDb(':memory:');
  upsertSessions(db, [{ id: 's1', agent: 'claude', projectId: null }]);
  upsertEvents(db, Array.from({ length: 300 }, (_, i) => ({ id: `e${i}`, agent: 'claude', sessionId: 's1', ts: i + 1, kind: 'assistant', model: 'claude-sonnet', input: 1000, output: 50 })));
  upsertFindings(db, [{ id: 'f', rule: 'retry_loop', projectId: null, sessionId: 's1', evidence: { tool: 'Bash', count: 3 }, confidence: 'high', confidenceReason: '', estTokensWeek: 50, firstSeen: 1, lastSeen: 1 }]);
  const { prompt } = buildPrompt('diagnose', sessionDigest(db, 's1'));
  assert.ok(prompt.length <= 12000);
  assert.ok(prompt.includes('retry_loop') && !prompt.includes('[truncated]'));
  db.close();
});
