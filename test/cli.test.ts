import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, put, jsonl, cAssistant } from './helpers.ts';
import { openDb, upsertProject, upsertSessions, upsertEvents, upsertRecommendations } from '../src/db.ts';
import type { NormalizedEvent, Recommendation, SessionInfo } from '../src/types.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const { CLAUDE_CONFIG_DIR: _c, CODEX_HOME: _x, ...baseEnv } = process.env;
const run = (args: string[], env: Record<string, string>) =>
  execFileSync(process.execPath, ['--no-warnings', CLI, ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8', stdio: 'pipe' });

test('ingest reads a home directory into the data dir', () => {
  const home = tmp();
  const data = tmp();
  put(join(home, '.claude/projects/-p/s1.jsonl'), jsonl(cAssistant({ msg: 'm1' })));
  const out = run(['ingest'], { AGENTLENS_SOURCE_HOME: home, AGENTLENS_DATA_DIR: data });
  assert.match(out, /1\/1 files read, 1 events, 0 bad lines/);
  assert.ok(existsSync(join(data, 'agentlens.db')));
});

test('install-service writes a user unit that runs this checkout', () => {
  const cfg = tmp();
  const out = run(['install-service'], { XDG_CONFIG_HOME: cfg });
  const unit = readFileSync(join(cfg, 'systemd/user/agentlens.service'), 'utf8');
  assert.ok(unit.includes(`"${CLI}" serve`), unit);
  assert.match(unit, /^Nice=10$/m);
  assert.match(unit, /^MemoryMax=200M$/m);
  assert.match(out, /systemctl --user enable --now agentlens/);
});

test('serve answers on the port it reports', async () => {
  const child = spawn(process.execPath, ['--no-warnings', CLI, 'serve'], {
    env: { ...baseEnv, AGENTLENS_SOURCE_HOME: tmp(), AGENTLENS_DATA_DIR: tmp(), AGENTLENS_PORT: '0' },
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', (d) => { const m = /http:\/\/127\.0\.0\.1:\d+/.exec(String(d)); if (m) resolve(m[0]); });
      child.on('exit', (code) => reject(new Error(`serve exited ${code}`)));
    });
    const r = await fetch(`${url}/api/health`);
    assert.equal(r.status, 200);
  } finally {
    child.kill();
  }
});

test('serve ingests on start and picks up new log files via the watcher', async () => {
  const home = tmp();
  put(join(home, '.claude/projects/-p/s1.jsonl'), jsonl(cAssistant({ msg: 'm1' })));
  const child = spawn(process.execPath, ['--no-warnings', CLI, 'serve'], {
    env: { ...baseEnv, AGENTLENS_SOURCE_HOME: home, AGENTLENS_DATA_DIR: tmp(), AGENTLENS_PORT: '0' },
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', (d) => { const m = /http:\/\/127\.0\.0\.1:\d+/.exec(String(d)); if (m) resolve(m[0]); });
      child.on('exit', (code) => reject(new Error(`serve exited ${code}`)));
    });
    const events = async () => {
      const h = (await (await fetch(`${url}/api/health`)).json()) as { events: { agent: string; events: number }[] };
      return h.events.find((e) => e.agent === 'claude')?.events ?? 0;
    };
    const until = async (n: number) => {
      for (let i = 0; i < 100; i++) {
        if ((await events()) === n) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(await events(), n);
    };
    await until(1); // initial ingest
    put(join(home, '.claude/projects/-p/s2.jsonl'), jsonl(cAssistant({ msg: 'm2', session: 's2' })));
    await until(2); // the 60s poll cannot explain this within 10s; only the watcher can
  } finally {
    child.kill();
  }
});

test('serve exits non-zero with a clear message when the port is taken', async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const port = (blocker.address() as AddressInfo).port;
  const child = spawn(process.execPath, ['--no-warnings', CLI, 'serve'], {
    env: { ...baseEnv, AGENTLENS_SOURCE_HOME: tmp(), AGENTLENS_DATA_DIR: tmp(), AGENTLENS_PORT: String(port) },
  });
  try {
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    assert.notEqual(code, 0);
    assert.match(stderr, new RegExp(`agentlens: cannot listen on 127\\.0\\.0\\.1:${port}: .*EADDRINUSE`));
  } finally {
    child.kill();
    blocker.close();
  }
});

test('unknown command prints help and fails', () => {
  assert.throws(() => run(['bogus'], {}), /Usage: agentlens/);
});

test('track prints normalized before/after token metrics from results', () => {
  const data = tmp();
  const db = openDb(join(data, 'agentlens.db'));
  const acceptedAt = Date.now() - 3_600_000;
  const projId = upsertProject(db, '/test/proj', 'test-proj');
  upsertRecommendations(db, [{
    id: 'rec_cli', findingRule: 'subagent_share', projectId: projId, action: 'improve',
    title: 'Cut subagent tokens', body: 'Reduce tokens', status: 'accepted', acceptedAt,
  }]);
  for (let i = 0; i < 5; i++) {
    const before = { id: `s_b${i}`, agent: 'claude' as const, projectId: projId, cwd: '/test/proj' };
    const after = { id: `s_a${i}`, agent: 'claude' as const, projectId: projId, cwd: '/test/proj' };
    upsertSessions(db, [before, after]);
    upsertEvents(db, [
      { id: `e_cli_b${i}_u`, agent: 'claude', sessionId: before.id, ts: acceptedAt - (i + 1) * 600_000, kind: 'user', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      { id: `e_cli_b${i}_a`, agent: 'claude', sessionId: before.id, ts: acceptedAt - (i + 1) * 600_000 + 10_000, kind: 'assistant', input: 1_000, output: 2_000, cacheRead: 3_000, cacheWrite: 4_000 },
      { id: `e_cli_a${i}_u`, agent: 'claude', sessionId: after.id, ts: acceptedAt + (i + 1) * 60_000, kind: 'user', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      { id: `e_cli_a${i}_a`, agent: 'claude', sessionId: after.id, ts: acceptedAt + (i + 1) * 60_000 + 10_000, kind: 'assistant', input: 1_000, output: 0, cacheRead: 0, cacheWrite: 9_000 },
    ]);
  }
  db.close();

  const out = run(['track'], { AGENTLENS_DATA_DIR: data });
  assert.match(out, /Tokens\/session \(incl\. cache writes\): 10,000 -> 10,000/);
  assert.match(out, /Tokens per 1k output: 5,000 -> n\/a/);
});
