import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSetting, upsertRecommendations } from '../src/db.ts';
import { enrichRecommendations } from '../src/ai/recommendations.ts';
import { startServer } from '../src/server.ts';
import type { Recommendation } from '../src/types.ts';
import type { AddressInfo } from 'node:net';

const recs: Recommendation[] = Array.from({ length: 6 }, (_, i) => ({ id: `rec:${i}`, findingRule: 'retry_loop', projectId: null, action: 'improve', title: 'private title', body: 'private body', actionSnippet: 'private snippet', score: 100 - i, status: 'open' }));
const output = JSON.stringify([{ id: 'rec:0', aiBody: 'Try fewer retries', aiActionSnippet: 'stop' }]);
const count = (db: ReturnType<typeof openDb>, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

test('disabled fallback, consent, safe payload, immutable fields, cap and validated cache', async () => {
  const db = openDb(':memory:'); let calls = 0; let sent = '';
  const runner = async (prompt: string) => { calls++; sent = prompt; return { ok: true, text: output }; };
  const original = structuredClone(recs);
  const off = await enrichRecommendations(db, recs, { runner });
  assert.equal(off.status, 'error'); assert.equal(off.status === 'error' && off.code, 'AI_DISABLED');
  assert.deepEqual(off.recommendations, original); assert.equal(calls, 0);
  setSetting(db, 'ai_enabled', 'true');
  const preview = await enrichRecommendations(db, recs, { runner });
  assert.equal(preview.status, 'confirmation_required'); if (preview.status !== 'confirmation_required') return;
  assert.ok(!preview.preview.prompt.includes('private'));
  assert.ok(!preview.preview.prompt.includes('rec:5'));
  const stale = await enrichRecommendations(db, recs, { runner, confirm: 'a'.repeat(64) });
  assert.equal(stale.status, 'confirmation_required'); assert.equal(count(db, 'ai_calls'), 0);
  const result = await enrichRecommendations(db, recs, { runner, confirm: preview.preview.confirmationHash });
  assert.equal(result.status, 'ok'); assert.equal(calls, 1); assert.equal(sent, preview.preview.prompt);
  assert.deepEqual(recs, original); assert.deepEqual(result.recommendations[0], { ...original[0], aiBody: 'Try fewer retries', aiActionSnippet: 'stop' });
  assert.deepEqual(result.recommendations.slice(1), original.slice(1));
  setSetting(db, 'ai_max_calls_per_day', '0');
  const cached = await enrichRecommendations(db, recs, { runner });
  assert.equal(cached.status, 'ok'); assert.equal(calls, 1);
  const capped = await enrichRecommendations(db, recs.slice(1), { runner, confirm: preview.preview.confirmationHash });
  assert.equal(capped.status, 'confirmation_required');
  if (capped.status === 'confirmation_required') {
    const limited = await enrichRecommendations(db, recs.slice(1), { runner, confirm: capped.preview.confirmationHash });
    assert.equal(limited.status === 'error' && limited.code, 'AI_DAILY_LIMIT');
  }
  db.close();
});

test('malformed or unknown output is rejected and never cached', async () => {
  for (const text of ['bad', JSON.stringify([{ id: 'unknown', aiBody: 'x' }]), JSON.stringify([{ id: 'rec:0', aiBody: 'x'.repeat(4001) }]), JSON.stringify([{ id: 'rec:0', aiBody: 'x' }, { id: 'rec:0', aiBody: 'y' }])]) {
    const db = openDb(':memory:'); setSetting(db, 'ai_enabled', 'true');
    const runner = async () => ({ ok: true, text });
    const preview = await enrichRecommendations(db, recs, { runner });
    assert.equal(preview.status, 'confirmation_required'); if (preview.status !== 'confirmation_required') throw Error();
    const result = await enrichRecommendations(db, recs, { runner, confirm: preview.preview.confirmationHash });
    assert.equal(result.status === 'error' && result.code, 'AI_INVALID_OUTPUT');
    assert.equal(count(db, 'ai_notes'), 0); assert.deepEqual(result.recommendations, recs); db.close();
  }
});

test('GET only serves validated cache and never invokes the runner', async () => {
  const db = openDb(':memory:'); upsertRecommendations(db, recs); setSetting(db, 'ai_enabled', 'true'); let calls = 0;
  const runner = async () => { calls++; return { ok: true, text: output }; };
  const server = await startServer(db, 0, '127.0.0.1', { aiRunner: runner });
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async () => (await (await fetch(`${url}/api/recommendations?ai=1`)).json()) as { recommendations: Recommendation[] };
    assert.equal((await get()).recommendations[0].id, 'rec:0'); assert.equal(calls, 0); assert.equal(count(db, 'ai_calls'), 0);
    const p = await enrichRecommendations(db, recs, { runner }); assert.equal(p.status, 'confirmation_required'); if (p.status !== 'confirmation_required') return;
    await enrichRecommendations(db, recs, { runner, confirm: p.preview.confirmationHash });
    assert.equal((await get()).recommendations[0].aiBody, 'Try fewer retries'); assert.equal(calls, 1);
    db.prepare("UPDATE ai_notes SET text = ? WHERE kind = 'recommendations'").run(JSON.stringify([{ id: 'unknown', aiBody: 'bad' }]));
    assert.equal((await get()).recommendations[0].aiBody, undefined); assert.equal(calls, 1); assert.equal(count(db, 'ai_calls'), 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); }
});

test('POST previews and confirms with origin and byte limits', async () => {
  const db = openDb(':memory:'); upsertRecommendations(db, recs); setSetting(db, 'ai_enabled', 'true'); let calls = 0;
  const server = await startServer(db, 0, '127.0.0.1', { aiRunner: async () => { calls++; return { ok: true, text: output }; } });
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (body: string, origin = url) => fetch(`${url}/api/ai/recommendations`, { method: 'POST', headers: { origin }, body });
    assert.equal((await post('{}', 'http://evil.example')).status, 403);
    assert.equal((await post('é'.repeat(8193))).status, 413);
    assert.equal((await post('{')).status, 400);
    const preview = await (await post('{}')).json() as { status: string; preview: { confirmationHash: string } };
    assert.equal(preview.status, 'confirmation_required'); assert.equal(calls, 0);
    const result = await (await post(JSON.stringify({ confirm: preview.preview.confirmationHash }))).json() as { status: string };
    assert.equal(result.status, 'ok'); assert.equal(calls, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); }
});

test('CLI preview works disabled and ordinary recommend stays deterministic', async () => {
  const { spawnSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const { tmp } = await import('./helpers.ts');
  const dir = tmp(); const db = openDb(join(dir, 'agentlens.db')); upsertRecommendations(db, recs); db.close();
  const run = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'recommend', ...args], { cwd: process.cwd(), env: { ...process.env, AGENTLENS_DATA_DIR: dir, AGENTLENS_STATE_DIR: dir, AGENTLENS_SOURCE_HOME: dir }, encoding: 'utf8' });
  const plain = run(); assert.equal(plain.status, 0); assert.equal(JSON.parse(plain.stdout)[0].body, 'private body');
  const off = run('--ai'); assert.equal(off.status, 1); assert.equal(JSON.parse(off.stdout).code, 'AI_DISABLED');
  const preview = run('--ai', '--preview'); assert.equal(preview.status, 0); assert.equal(JSON.parse(preview.stdout).status, 'confirmation_required');
  assert.equal(run('--preview').status, 1);
});
