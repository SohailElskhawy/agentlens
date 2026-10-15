import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { startServer } from '../src/server.ts';

const server = await startServer(openDb(':memory:'), 0);
const port = (server.address() as AddressInfo).port;
after(() => server.close());

function get(path: string, host = `127.0.0.1:${port}`): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), body }));
    }).on('error', reject).end();
  });
}

test('API endpoints answer with JSON, even on an empty database', async () => {
  for (const p of ['summary', 'daily', 'projects', 'models', 'sessions', 'quota', 'health']) {
    const r = await get(`/api/${p}`);
    assert.equal(r.status, 200, p);
    assert.match(r.type, /application\/json/);
    JSON.parse(r.body);
  }
  assert.equal(JSON.parse((await get('/api/session?id=nope')).body), null);
});

test('invalid numeric params are ignored, not errors', async () => {
  assert.equal((await get('/api/summary?from=abc&project=&limit=-5')).status, 200);
  for (const qs of ['limit=2.5', 'project=%20', 'from=0x10']) assert.equal((await get(`/api/sessions?${qs}`)).status, 200, qs);
});

test('malformed request targets get 400 and the server keeps serving', async () => {
  for (const p of ['//', '//x:99999/']) assert.equal((await get(p)).status, 400, p);
  assert.equal((await get('/api/health')).status, 200);
});

test('listen failure rejects instead of hanging', async () => {
  const db = openDb(':memory:');
  await assert.rejects(startServer(db, port), { code: 'EADDRINUSE' });
  db.close();
});

test('serves the dashboard and blocks path traversal', async () => {
  const index = await get('/');
  assert.equal(index.status, 200);
  assert.match(index.body, /<title>agentlens<\/title>/);
  assert.equal((await get('/../src/db.ts')).status, 404);
  assert.equal((await get('/%2e%2e/package.json')).status, 404);
  assert.equal((await get('/nope.js')).status, 404);
});

test('rejects foreign Host headers (DNS rebinding)', async () => {
  assert.equal((await get('/api/summary', 'evil.example:80')).status, 403);
  assert.equal((await get('/api/summary', `localhost:${port}`)).status, 200);
});
