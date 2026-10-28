import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.ts';
import { startServer } from '../src/server.ts';
import { tmp } from './helpers.ts';

test('AI settings round-trip and invalid values are rejected without mutation', async () => {
  const db = openDb(':memory:');
  const server = await startServer(db, 0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (payload: unknown) => fetch(`${url}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  try {
    const initial = await (await fetch(`${url}/api/ai/status`)).json() as { enabled: boolean; agent: string; maxCallsPerDay: number };
    assert.deepEqual([initial.enabled, initial.agent, initial.maxCallsPerDay], [false, 'auto', 20]);
    for (const [key, value] of Object.entries({ ai_enabled: 'true', ai_agent: 'gemini', ai_model: 'model-1', ai_max_calls_per_day: '4' })) {
      assert.equal((await post({ key, value })).status, 200);
    }
    const before = await (await fetch(`${url}/api/settings`)).json();
    for (const [key, value] of [['ai_enabled', 'yes'], ['ai_agent', 'unknown'], ['ai_model', 'bad\nmodel'],
      ['ai_max_calls_per_day', '-1'], ['ai_max_calls_per_day', '2.5'], ['ai_max_calls_per_day', 4], ['ai_unknown', 'x']]) {
      assert.equal((await post({ key, value })).status, 400, String(key));
      assert.deepEqual(await (await fetch(`${url}/api/settings`)).json(), before);
    }
    const status = await (await fetch(`${url}/api/ai/status`)).json() as { enabled: boolean; agent: string; model: string; maxCallsPerDay: number };
    assert.deepEqual([status.enabled, status.agent, status.model, status.maxCallsPerDay], [true, 'gemini', 'model-1', 4]);
    assert.equal((await post({ key: 'custom_setting', value: 'untouched' })).status, 200);
    assert.equal((await post({ allowAgentLaunch: true })).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test('CLI enables, reports and disables AI using isolated data directories', () => {
  const env = { ...process.env, AGENTLENS_DATA_DIR: tmp(), AGENTLENS_STATE_DIR: tmp(), AGENTLENS_SOURCE_HOME: tmp() };
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (...args: string[]) => execFileSync(process.execPath, ['--no-warnings', cli, 'ai', ...args], { env, encoding: 'utf8', stdio: 'pipe' });
  assert.equal(JSON.parse(run('status', '--json')).enabled, false);
  run('enable');
  assert.equal(JSON.parse(run('status', '--json')).enabled, true);
  run('disable');
  assert.equal(JSON.parse(run('status', '--json')).enabled, false);
  assert.equal(JSON.parse(run('--json')).enabled, false);
  assert.throws(() => run('unexpected'));
});
