import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { put, tmp } from './helpers.ts';
import { failBody } from '../src/server.ts';

// An async route callback returns the onEnd promise to readBody; a rejected one
// (e.g. handler throws synchronously inside an async fn) must not crash the
// process as an unhandledRejection. The isolated child process proves survival
// end to end: server + closed DB + real POST over real HTTP.
const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

test('async route callback rejection on closed DB: process survives, fixed JSON error reaches client', () => {
  const script = put(`${tmp()}/async-callback-child.mjs`, `
    import { pathToFileURL } from 'node:url';
    const src = process.argv[2];
    const { openDb } = await import(pathToFileURL(src + '/db.ts'));
    const { startServer } = await import(pathToFileURL(src + '/server.ts'));
    const { request } = await import('node:http');
    const db = openDb(':memory:');
    db.close();
    const server = await startServer(db, 0);
    const port = server.address().port;
    const body = await new Promise((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path: '/api/ai/recommendations', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      r.on('error', reject);
      r.end('{}');
    });
    console.log('RESULT ' + JSON.stringify(body));
    process.exit(0); // server keeps the loop alive; survival is evidenced above
  `);
  const r = spawnSync(process.execPath, [script, srcDir], { encoding: 'utf8' });
  const outLine = (r.stdout.split('\n').find((l) => l.startsWith('RESULT ')) ?? '').slice('RESULT '.length);
  assert.equal(r.status, 0, `child crashed: status=${r.status}\nstderr: ${r.stderr.slice(0, 2000)}`);
  const parsed = (() => { try { return JSON.parse(outLine); } catch { return undefined; } })();
  assert.notEqual(parsed, undefined, `no RESULT line, stdout: ${r.stdout.slice(0, 2000)}`);
  assert.equal(parsed.status, 500, JSON.stringify(parsed));
  const err = JSON.parse(parsed.body);
  assert.deepEqual(Object.keys(err), ['error'], parsed.body);
  assert.equal(typeof err.error, 'string');
  assert.ok(err.error.length > 0 && err.error.length < 200, `unbounded error body: ${parsed.body}`);
});

test('failBody guard: no send after response ended, destroyed response, or dead client', () => {
  const writes: unknown[] = [];
  const fake = (writableEnded: boolean, destroyed: boolean) =>
    ({ writableEnded, destroyed, writeHead: (...a: unknown[]) => writes.push(['head', a]), end: (b: unknown) => writes.push(['end', b]) }) as unknown as ServerResponse;
  failBody(fake(true, false), new Error('late'));
  failBody(fake(false, true), new Error('late'));
  assert.deepEqual(writes, []);
});
