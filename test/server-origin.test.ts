import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetting, openDb } from '../src/db.ts';
import { startServer } from '../src/server.ts';

const db = openDb(':memory:');
const server = await startServer(db, 0);
const port = (server.address() as AddressInfo).port;
const host = `127.0.0.1:${port}`;
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

function send(method: string, path: string, origin: string | string[] | undefined, body: string, requestHost = host): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | string[]> = { host: requestHost, 'content-type': 'text/plain' };
    if (origin !== undefined) headers.origin = origin;
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let response = '';
      res.on('data', (chunk) => { response += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: response }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('untrusted or malformed browser origins cannot enable AI', async () => {
  const payload = JSON.stringify({ key: 'ai_enabled', value: 'true' });
  for (const origin of ['https://untrusted.example', 'null', `http://127.0.0.1:${port === 1 ? 2 : port - 1}`,
    'not an origin', '', `http://${host}/path`, `http://user@${host}`, [`http://${host}`, 'https://untrusted.example']]) {
    const res = await send('POST', '/api/settings', origin, payload);
    assert.equal(res.status, 403, String(origin));
    assert.equal(res.body, 'forbidden origin');
    assert.equal(getSetting(db, 'ai_enabled'), '');
  }
});

test('same-origin browsers and clients without Origin can still change settings', async () => {
  let res = await send('POST', '/api/settings', `http://${host}`, JSON.stringify({ key: 'ai_enabled', value: 'true' }));
  assert.equal(res.status, 200);
  assert.equal(getSetting(db, 'ai_enabled'), 'true');
  res = await send('POST', '/api/settings', `http://localhost:${port}`, JSON.stringify({ allowAgentLaunch: true }), `localhost:${port}`);
  assert.equal(res.status, 200);
  assert.equal(getSetting(db, 'allow_agent_launch'), 'true');
  res = await send('POST', '/api/settings', undefined, JSON.stringify({ allowAgentLaunch: false }));
  assert.equal(res.status, 200);
  assert.equal(getSetting(db, 'allow_agent_launch'), 'false');
});

test('unsafe methods reject foreign origins before routing or parsing', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await send(method, '/api/fix/run', 'https://untrusted.example', '{');
    assert.equal(res.status, 403, method);
    assert.equal(res.body, 'forbidden origin');
  }
});
