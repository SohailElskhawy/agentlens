import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { startServer } from '../src/server.ts';

const server = await startServer(openDb(':memory:'), 0);
const port = (server.address() as AddressInfo).port;
after(() => server.close());

function post(path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode!, body: data }));
    }).on('error', reject).end(body);
  });
}

// Multi-piece raw sender: separate TCP writes with gaps force the server to see
// independent chunks, so a multi-byte UTF-8 char can be split across a chunk boundary.
function rawPost(path: string, pieces: Buffer[]): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let raw = Buffer.alloc(0);
    sock.on('data', (d) => (raw = Buffer.concat([raw, d])));
    sock.on('error', reject);
    sock.on('close', () => {
      const s = raw.toString('latin1');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(s);
      const i = s.indexOf('\r\n\r\n');
      resolve({ status: m ? Number(m[1]) : 0, body: dechunk(i >= 0 ? s.slice(i + 4) : '') });
    });
    const total = pieces.reduce((a, p) => a + p.length, 0);
    sock.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${total}\r\nConnection: close\r\n\r\n`);
    let idx = 0;
    const writeNext = () => {
      if (idx >= pieces.length) return sock.end();
      sock.write(pieces[idx++], () => setTimeout(writeNext, 30));
    };
    writeNext();
  });
}

function dechunk(body: string): string {
  if (!/^[0-9a-f]+\r\n/.test(body)) return body;
  let out = '';
  let i = 0;
  while (i < body.length) {
    const j = body.indexOf('\r\n', i);
    if (j < 0) break;
    const len = parseInt(body.slice(i, j), 16);
    if (!len) break;
    out += body.slice(j + 2, j + 2 + len);
    i = j + 2 + len + 2;
  }
  return out;
}

test('413 counts UTF-8 bytes, not UTF-16 code units (settings with multibyte payload)', async () => {
  // 5000 emoji = 20 000 body bytes but ~10 007 UTF-16 units; the old per-route
  // reader counted units and would have accepted this oversized body.
  const value = '😀'.repeat(5000);
  const r = await post('/api/settings', JSON.stringify({ key: 'note', value }));
  assert.equal(r.status, 413);
  assert.equal(JSON.parse(r.body).error, 'payload too large');
  assert.equal(await post('/api/settings', JSON.stringify({ key: 'note', value: 'x' })).then((x) => x.status), 200, 'server still serves after draining');
});

test('413 applies consistently to representative execution route (/api/fix/prompt)', async () => {
  const r = await post('/api/fix/prompt', JSON.stringify({ agent: '😀'.repeat(5000) }));
  assert.equal(r.status, 413);
});

test('413 applies consistently to AI route (/api/ai/diagnose)', async () => {
  const r = await post('/api/ai/diagnose', JSON.stringify({ sessionId: '😀'.repeat(5000) }));
  assert.equal(r.status, 413);
  assert.equal(JSON.parse(r.body).error, 'payload too large');
});

test('413 is sent exactly once and the connection finishes', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await post('/api/ai/recommendations', JSON.stringify({ x: '😀'.repeat(5000) }));
    assert.equal(r.status, 413);
    assert.match(r.body, /payload too large/);
    assert.doesNotMatch(r.body, /payload too large.*payload too large/s);
  }
});

test('body split across chunks decodes once: multibyte char survives (settings)', async () => {
  // "😀" is F0 9F 98 80: split after the second byte so the old per-chunk decode scatters U+FFFD.
  const head = Buffer.from(`{"key":"split","value":"${'a'.repeat(500)}\xF0\x9F`, 'latin1');
  const tail = Buffer.from('\x98\x80"}', 'latin1');
  const r = await rawPost('/api/settings', [head, tail]);
  assert.equal(r.status, 200, r.body);
  const out = JSON.parse(r.body) as { settings: Record<string, string> };
  // helper decodes the raw socket as latin1; compare the same encoding both sides.
  // Replacement chars (from a double decode) would NOT match this.
  assert.equal(out.settings.split, Buffer.from(`${'a'.repeat(500)}😀`).toString('latin1'));
});

test('abort mid-request: no crash, no unhandled rejection, server keeps serving', async () => {
  const seen: string[] = [];
  const onUncaught = (e: Error) => { seen.push(`uncaught:${e.message}`); };
  const onRejection = (e: unknown) => { seen.push(`rejection:${String(e)}`); };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  try {
    // Declare a body larger than we send, then destroy: the server request stream
    // must be torn down without an unhandled error event or leaked buffers.
    const sock = net.connect(port, '127.0.0.1');
    await new Promise<void>((res, rej) => { sock.on('connect', res); sock.on('error', rej); });
    sock.write(`POST /api/settings HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"key":"ab`);
    await new Promise((r) => setTimeout(r, 50));
    sock.destroy();
    await new Promise((r) => setTimeout(r, 100));
    const r = await post('/api/settings', JSON.stringify({ key: 'note', value: 'still-alive' }));
    assert.equal(r.status, 200);
    assert.deepEqual(seen, []);
  } finally {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
  }
});

test('undersized requests keep working after cap (contract spot checks)', async () => {
  const diag = await post('/api/ai/diagnose', JSON.stringify({ sessionId: 'x' }));
  assert.equal(diag.status, 404); // unknown session, deterministic; no agent spawned
  const settings = await post('/api/settings', JSON.stringify({ key: 'note', value: '👋' }));
  assert.equal(settings.status, 200);
  assert.equal((JSON.parse(settings.body) as { settings: Record<string, string> }).settings.note, '👋');
});
