import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb, upsertProject } from '../src/db.ts';
import { startServer } from '../src/server.ts';
import * as optimize from '../src/optimize.ts';

const base = mkdtempSync(join(tmpdir(), 'agentlens-optimize-api-'));
const root = join(base, 'project space');
const other = join(base, 'other');
mkdirSync(root); mkdirSync(other);
writeFileSync(join(root, 'CLAUDE.md'), 'Project instructions\n');
writeFileSync(join(other, 'CLAUDE.md'), 'Other instructions\n');
const db = openDb(':memory:');
const id = upsertProject(db, root, 'project');
const server = await startServer(db, 0);
const port = (server.address() as AddressInfo).port;
after(() => { server.close(); db.close(); rmSync(base, { recursive: true, force: true }); });

function send(path: string, method = 'GET', host = `127.0.0.1:${port}`): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, method, headers: { host } }, res => {
      let body = ''; res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    }).on('error', reject).end();
  });
}

test('preview requires a positive safe registered project ID', async () => {
  for (const query of ['', '?project=', '?project=0', '?project=-1', '?project=1.5', '?project=abc', '?project=9007199254740992']) {
    assert.equal((await send(`/api/optimize${query}`)).status, 400, query);
  }
  assert.equal((await send('/api/optimize?project=999999')).status, 404);
});

test('preview uses only the registered root and makes no database or filesystem writes', async () => {
  const beforeFiles = readdirSync(root).map(name => [name, readFileSync(join(root, name), 'utf8')]);
  const beforeOther = readdirSync(other).map(name => [name, readFileSync(join(other, name), 'utf8')]);
  const changes = db.prepare('SELECT total_changes() AS n').get() as { n: number };
  const response = await send(`/api/optimize?project=${id}&projectRoot=${encodeURIComponent(other)}`);
  assert.equal(response.status, 200, response.body);
  const preview = JSON.parse(response.body);
  assert.equal(preview.projectId, id); assert.equal(preview.projectRoot, root); assert.equal(preview.applied, false);
  assert.ok(preview.ignoreFiles.length);
  assert.equal(preview.cliShell, process.platform === 'win32' ? 'PowerShell' : 'POSIX shell');
  assert.ok(preview.cliCommand.includes('--apply'));
  assert.deepEqual(readdirSync(root).map(name => [name, readFileSync(join(root, name), 'utf8')]), beforeFiles);
  assert.deepEqual(readdirSync(other).map(name => [name, readFileSync(join(other, name), 'utf8')]), beforeOther);
  assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes.n);
});

test('preview rejects unsafe workspace targets and browser writes and honors host guard', async () => {
  symlinkSync(join(other, 'CLAUDE.md'), join(root, '.claudeignore'));
  assert.equal((await send(`/api/optimize?project=${id}`)).status, 500);
  rmSync(join(root, '.claudeignore'));
  assert.equal((await send('/api/optimize', 'POST')).status, 404);
  assert.equal((await send(`/api/optimize?project=${id}`, 'GET', 'evil.example')).status, 403);
});

test('CLI command safely quotes hostile path for both supported shells', () => {
  const build = (optimize as unknown as { optimizeCliCommand: (path: string, platform: string) => { command: string; shell: string } | null }).optimizeCliCommand;
  const path = `/tmp/a space'$(touch bad)\`echo bad\"`;
  const posix = build(path, 'linux');
  assert.equal(posix?.shell, 'POSIX shell');
  const result = spawnSync('/bin/sh', ['-c', `set -- ${posix!.command}; printf '%s\\n' "$#" "$4"`], { cwd: base, encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stdout, `5\n${path}\n`);
  assert.equal(readdirSync(base).includes('bad'), false);
  const windows = build(path, 'win32');
  assert.equal(windows?.shell, 'PowerShell');
  assert.equal(windows?.command, `agentlens optimize --project '${path.replace(/'/g, "''")}' --apply`);
  assert.equal(build('/tmp/bad\npath', 'linux'), null);
  assert.equal(build('C:\\path\u2019name', 'win32'), null);
  for (const q of ['\u2018', '\u2019', '\u201a', '\u201b']) assert.equal(build(`C:\\a${q}b`, 'win32'), null, q);
});
