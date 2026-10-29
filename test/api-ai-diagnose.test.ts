import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, setSetting, upsertEvents, upsertFindings, upsertSessions } from '../src/db.ts';
import { startServer } from '../src/server.ts';

const good = {
  summary: 'Retry loop dominates this session',
  causes: [{ cause: 'Repeated Bash retries', evidence: 'retry_loop x3', est_tokens: 1200 }],
  fixes: [{ action: 'Stop after two retries', where: 'CLAUDE.md', snippet: 'Stop after two failed retries.' }],
};

const db = openDb(':memory:');
upsertSessions(db, [{ id: 's1', agent: 'claude', projectId: null, cwd: '/private/source' }]);
upsertEvents(db, [{ id: 'e1', agent: 'claude', sessionId: 's1', ts: 1, kind: 'assistant', model: 'claude-sonnet', input: 10, output: 5 }]);
upsertFindings(db, [{ id: 'f1', rule: 'retry_loop', projectId: null, sessionId: 's1', evidence: { tool: 'Bash', count: 3 }, confidence: 'high', confidenceReason: '', estTokensWeek: 50, firstSeen: 1, lastSeen: 1 }]);

const prompts: string[] = [];
let runnerText = JSON.stringify(good);
const server = await startServer(db, 0, '127.0.0.1', {
  aiRunner: async (prompt) => { prompts.push(prompt); return { ok: true, text: runnerText }; },
});
const port = (server.address() as AddressInfo).port;
after(() => { server.close(); db.close(); });

function post(payload: string | object, headers: Record<string, string> = {}): Promise<{ status: number; body: any; raw: string }> {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/ai/diagnose', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => { let body: any = raw; try { body = JSON.parse(raw); } catch {} resolve({ status: res.statusCode!, body, raw }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

test('diagnose is 403 with the gate code while AI is disabled or invalid', async () => {
  let res = await post({ sessionId: 's1' });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'AI_DISABLED');
  setSetting(db, 'ai_enabled', 'true');
  setSetting(db, 'ai_agent', 'bogus');
  res = await post({ sessionId: 's1' });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'AI_INVALID_SETTINGS');
  setSetting(db, 'ai_agent', 'auto');
  assert.equal(prompts.length, 0);
});

test('missing or stale confirm returns a preview and reserves nothing', async () => {
  for (const confirm of [undefined, 'stale']) {
    const res = await post(confirm ? { sessionId: 's1', confirm } : { sessionId: 's1' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'confirmation_required');
    const p = res.body.preview;
    assert.deepEqual(Object.keys(p).sort(), ['agent', 'confirmationHash', 'model', 'prompt']);
    assert.equal(p.agent, 'claude');
    assert.match(p.confirmationHash, /^[a-f0-9]{64}$/);
    assert.ok(p.prompt.length > 0);
    assert.ok(!res.raw.includes('/private/source'));
  }
  assert.equal(count('ai_calls'), 0);
  assert.equal(prompts.length, 0);
});

test('confirmed diagnosis runs the injected runner, then the validated cache serves without a new call', async () => {
  const preview = (await post({ sessionId: 's1' })).body.preview;
  const ok = await post({ sessionId: 's1', confirm: preview.confirmationHash });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'ok');
  assert.equal(ok.body.cached, false);
  assert.deepEqual(ok.body.diagnosis, good);
  assert.deepEqual(prompts, [preview.prompt]);
  assert.equal(count('ai_calls'), 1);

  const hit = await post({ sessionId: 's1' });
  assert.equal(hit.status, 200);
  assert.equal(hit.body.status, 'ok');
  assert.equal(hit.body.cached, true);
  assert.deepEqual(hit.body.diagnosis, good);
  assert.equal(prompts.length, 1);
  assert.equal(count('ai_calls'), 1);
});

test('unknown sessions, bad input and oversize bodies get sibling-style errors', async () => {
  assert.equal((await post({ sessionId: 'nope' })).status, 404);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ sessionId: 5 })).status, 400);
  assert.equal((await post({ sessionId: 's1', confirm: 5 })).status, 400);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post({ sessionId: 's1', pad: 'x'.repeat(17000) })).status, 413);
});

test('the body cap counts bytes, and multibyte characters split across chunks survive', async () => {
  assert.equal((await post({ sessionId: 's1', pad: 'é'.repeat(9000) })).status, 413); // 9k chars, 18k bytes
  upsertSessions(db, [{ id: 'sé€', agent: 'claude', projectId: null, cwd: '/private/source' }]);
  const buf = Buffer.from(JSON.stringify({ sessionId: 'sé€' }));
  const cut = buf.indexOf(0xe2) + 1; // inside the 3-byte €
  const res = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/ai/diagnose', method: 'POST', headers: { 'content-type': 'application/json' } }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode!)); });
    req.on('error', reject);
    req.write(buf.subarray(0, cut));
    setTimeout(() => req.end(buf.subarray(cut)), 30);
  });
  assert.equal(res, 200);
});

test('daily limit is 429 and failed output is an error that never echoes runner text', async () => {
  setSetting(db, 'ai_max_calls_per_day', '1'); // the confirmed call above already used it
  setSetting(db, 'ai_model', 'm2'); // new model => new cache key and hash
  const preview = (await post({ sessionId: 's1' })).body.preview;
  let res = await post({ sessionId: 's1', confirm: preview.confirmationHash });
  assert.equal(res.status, 429);
  assert.equal(res.body.code, 'AI_DAILY_LIMIT');

  setSetting(db, 'ai_max_calls_per_day', '20');
  runnerText = 'secret-model-output not json';
  res = await post({ sessionId: 's1', confirm: preview.confirmationHash });
  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'AI_INVALID_OUTPUT');
  assert.ok(!res.raw.includes('secret-model-output'));
  assert.ok(!res.raw.includes(preview.prompt));
});

test('cross-origin requests are rejected before reaching the diagnosis', async () => {
  const before = prompts.length;
  const res = await post({ sessionId: 's1', confirm: 'x' }, { origin: 'https://untrusted.example' });
  assert.equal(res.status, 403);
  assert.equal(res.raw, 'forbidden origin');
  assert.equal(prompts.length, before);
});
