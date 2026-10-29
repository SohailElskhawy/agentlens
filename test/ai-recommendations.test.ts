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
  assert.ok(preview.preview.prompt.includes('private'));
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

test('preview includes bounded evidence, baseline and project metadata and invalidates on changes', async () => {
  const { upsertProject, upsertFindings, upsertAuditItems } = await import('../src/db.ts');
  const { tmp, put } = await import('./helpers.ts');
  const { join } = await import('node:path');
  const dir = tmp(); const db = openDb(':memory:'); const project = upsertProject(db, dir, 'project');
  const finding = { id: 'finding:one', rule: 'retry_loop', projectId: project, sessionId: null, evidence: { tool: 'Bash', count: 3, sourcePath: '/home/person/secret', args: 'SECRET_ARGS', model: 'not-for-rule' }, confidence: 'high' as const, confidenceReason: '', estTokensWeek: 5, firstSeen: 1, lastSeen: 1 };
  upsertFindings(db, [finding]);
  const rec = { ...recs[0], id: `rec:retry_loop:${project}:finding:one`, projectId: project, body: 'Baseline advice /home/person/private sk-proj-abcdefghijk' };
  put(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: 'SECRET_VERSION' }, scripts: { test: 'SECRET_COMMAND' }, description: 'SECRET_DESCRIPTION' }));
  put(join(dir, 'AGENTS.md'), '# Architecture\nSECRET_INSTRUCTION_BODY\n');
  upsertAuditItems(db, [{ id: 'i', agent: 'all', projectId: project, kind: 'instruction', name: 'AGENTS.md', sourcePath: join(dir, 'AGENTS.md'), tokens: 1, invocations30d: 0, lastInvoked: null, details: {}, status: 'active', updatedAt: 1 }]);
  const preview = async () => { const r = await enrichRecommendations(db, [rec], { preview: true }); assert.equal(r.status, 'confirmation_required'); if (r.status !== 'confirmation_required') throw Error(); return r.preview; };
  const first = await preview();
  for (const value of ['Baseline advice', 'Bash', '"count":3', 'react', 'test', 'Architecture']) assert.ok(first.prompt.includes(value), value);
  for (const value of ['SECRET_', '/home/person', 'sk-proj-abcdefghijk', 'sourcePath', 'not-for-rule']) assert.ok(!first.prompt.includes(value), value);
  upsertFindings(db, [{ ...finding, evidence: { ...finding.evidence, count: 4 } }]); assert.notEqual((await preview()).inputHash, first.inputHash);
  put(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '1' } })); assert.notEqual((await preview()).inputHash, first.inputHash);
  put(join(dir, 'AGENTS.md'), '# Changed heading\nSECRET_INSTRUCTION_BODY'); assert.notEqual((await preview()).inputHash, first.inputHash);
  put(join(dir, 'package.json'), 'x'.repeat(65537) + 'PAST_LIMIT'); put(join(dir, 'AGENTS.md'), '# Oversized\n' + 'x'.repeat(65537));
  const oversized = await preview(); assert.ok(!oversized.prompt.includes('PAST_LIMIT')); assert.ok(!oversized.prompt.includes('Oversized'));
  db.close();
});

test('long top twenty entries remain valid JSON and only selected IDs are accepted', async () => {
  const db = openDb(':memory:'); setSetting(db, 'ai_enabled', 'true');
  const { upsertFindings } = await import('../src/db.ts');
  const many = Array.from({ length: 20 }, (_, i) => ({ ...recs[0], id: `rec:retry_loop:global:${i}:` + 'x'.repeat(200 - `rec:retry_loop:global:${i}:`.length), body: 'b'.repeat(600), actionSnippet: 's'.repeat(300) }));
  upsertFindings(db, many.map(r => ({ id: r.id.slice('rec:retry_loop:global:'.length), rule: 'retry_loop', projectId: null, sessionId: null, evidence: { tool: 't'.repeat(100), count: 1e100, args: 'z'.repeat(10000) }, confidence: 'high' as const, confidenceReason: '', estTokensWeek: 1, firstSeen: 1, lastSeen: 1 })));
  const p = await enrichRecommendations(db, many, { topN: 20, preview: true }); assert.equal(p.status, 'confirmation_required'); if (p.status !== 'confirmation_required') throw Error();
  assert.ok(p.preview.prompt.length <= 12000);
  const payload = JSON.parse(p.preview.prompt.slice(p.preview.prompt.indexOf('\n') + 1));
  const entries = Array.isArray(payload) ? payload : payload.recommendations;
  assert.ok(entries.length < 20 && entries.length > 0);
  const last = many[19].id; const runner = async () => ({ ok: true, text: JSON.stringify([{ id: last, aiBody: 'bad' }]) });
  const result = await enrichRecommendations(db, many, { topN: 20, runner, confirm: p.preview.confirmationHash });
  assert.equal(result.status === 'error' && result.code, 'AI_INVALID_OUTPUT'); db.close();
});

test('filtered GET uses canonical cache and disabled GET stays deterministic', async () => {
  const db = openDb(':memory:'); const items: Recommendation[] = recs.map((r, i) => ({ ...r, status: i === 0 ? 'accepted' : 'open' })); upsertRecommendations(db, items);
  const runner = async () => ({ ok: true, text: output }); const server = await startServer(db, 0, '127.0.0.1', { aiRunner: runner });
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/recommendations`;
    const get = async (query: string) => await (await fetch(url + query)).json() as { recommendations: Recommendation[] };
    assert.deepEqual(await get('?ai=1'), await get(''));
    setSetting(db, 'ai_enabled', 'true');
    const { getRecommendations } = await import('../src/db.ts'); const all = getRecommendations(db);
    const p = await enrichRecommendations(db, all, { runner }); if (p.status !== 'confirmation_required') throw Error();
    await enrichRecommendations(db, all, { runner, confirm: p.preview.confirmationHash });
    assert.equal((await get('?status=accepted&ai=1')).recommendations[0].aiBody, 'Try fewer retries');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); }
});


test('project files cannot escape through symlinks or block on special files', async () => {
  const { upsertProject, upsertAuditItems } = await import('../src/db.ts');
  const { tmp, put } = await import('./helpers.ts'); const { join } = await import('node:path');
  const { symlinkSync } = await import('node:fs'); const { spawnSync } = await import('node:child_process');
  const dir = tmp(); const outside = tmp(); const db = openDb(':memory:'); const project = upsertProject(db, dir, 'project');
  put(join(outside, 'outside.md'), '# OUTSIDE_HEADING'); put(join(outside, 'package.json'), '{"dependencies":{"outside-dep":"1"}}');
  symlinkSync(join(outside, 'outside.md'), join(dir, 'AGENTS.md')); symlinkSync(join(outside, 'package.json'), join(dir, 'package.json'));
  assert.equal(spawnSync('mkfifo', [join(dir, 'FIFO.md')]).status, 0);
  upsertAuditItems(db, ['AGENTS.md', 'FIFO.md'].map(name => ({ id: name, agent: 'all' as const, projectId: project, kind: 'instruction' as const, name, sourcePath: join(dir, name), tokens: 1, invocations30d: 0, lastInvoked: null, details: {}, status: 'active' as const, updatedAt: 1 })));
  const result = await enrichRecommendations(db, [{ ...recs[0], projectId: project }], { preview: true });
  assert.equal(result.status, 'confirmation_required'); if (result.status !== 'confirmation_required') throw Error();
  assert.ok(!result.preview.prompt.includes('OUTSIDE_HEADING')); assert.ok(!result.preview.prompt.includes('outside-dep')); db.close();
});

test('web/app.js contains Enrich with AI wiring, api call, and escaped enrichment rendering', async () => {
  const { readFileSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const check = spawnSync(process.execPath, ['--check', 'web/app.js'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const appJs = readFileSync('web/app.js', 'utf8');
  assert.ok(appJs.includes('#btn-enrich-ai') || appJs.includes('id="btn-enrich-ai"'), 'must contain #btn-enrich-ai');
  assert.ok(appJs.includes('/api/ai/recommendations'), 'must contain /api/ai/recommendations');
  assert.ok(appJs.includes("api('recommendations', { ai: '1' })"), "must contain api('recommendations', { ai: '1' })");
  assert.ok(appJs.includes('ai-rec-enrichment'), 'must contain ai-rec-enrichment');
  assert.ok(appJs.includes('ai-rec-body'), 'must contain ai-rec-body');
  assert.ok(appJs.includes('AI snippet'), 'must contain AI snippet');
  assert.ok(appJs.includes('rec-ai-error'), 'must contain rec-ai-error');
  assert.ok(appJs.includes('esc(g.title)') && appJs.includes('esc(g.body)'), 'preserves deterministic title and body on groups');
  assert.ok(appJs.includes('esc(r.title)') && appJs.includes('esc(r.body)'), 'preserves deterministic title and body on individual');
  assert.ok(appJs.includes('esc(g.aiBody)') && appJs.includes('esc(r.aiBody)'), 'escapes aiBody');
});

test('end-to-end HTTP flow: ai status check, preview, confirm, and enriched recs with immutable deterministic fields', async () => {
  const db = openDb(':memory:');
  upsertRecommendations(db, recs);
  let calls = 0;
  const runner = async () => { calls++; return { ok: true, text: output }; };
  const server = await startServer(db, 0, '127.0.0.1', { aiRunner: runner });
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const offRes = await (await fetch(`${url}/api/ai/status`)).json() as { enabled: boolean };
    assert.equal(offRes.enabled, false);

    setSetting(db, 'ai_enabled', 'true');
    const onRes = await (await fetch(`${url}/api/ai/status`)).json() as { enabled: boolean };
    assert.equal(onRes.enabled, true);

    const previewRes = await (await fetch(`${url}/api/ai/recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })).json() as { status: string; preview: { confirmationHash: string } };
    assert.equal(previewRes.status, 'confirmation_required');
    assert.ok(previewRes.preview?.confirmationHash);
    assert.equal(calls, 0);

    const confirmRes = await (await fetch(`${url}/api/ai/recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: previewRes.preview.confirmationHash }),
    })).json() as { status: string };
    assert.equal(confirmRes.status, 'ok');
    assert.equal(calls, 1);

    const recsRes = await (await fetch(`${url}/api/recommendations?ai=1`)).json() as { recommendations: Recommendation[] };
    const r0 = recsRes.recommendations.find(r => r.id === 'rec:0');
    assert.ok(r0, 'rec:0 found');
    assert.equal(r0.aiBody, 'Try fewer retries');
    assert.equal(r0.aiActionSnippet, 'stop');
    assert.equal(r0.id, recs[0].id);
    assert.equal(r0.score, recs[0].score);
    assert.equal(r0.title, recs[0].title);
    assert.equal(r0.body, recs[0].body);
    assert.equal(r0.action, recs[0].action);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  }
});

