import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { insertQuotas, openDb, upsertEvents, upsertProject, upsertSessions } from '../src/db.ts';
import { tmp } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const { CLAUDE_CONFIG_DIR: _c, CODEX_HOME: _x, ...baseEnv } = process.env;
const run = (args: string[], env: Record<string, string>) =>
  execFileSync(process.execPath, ['--no-warnings', CLI, ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8' });

test('agentlens status prints project usage, estimated cost, and active quota', () => {
  const dataDir = tmp();
  const dbPath = join(dataDir, 'agentlens.db');
  const db = openDb(dbPath);

  const pId = upsertProject(db, '/work/demo-project', 'demo-project');
  upsertSessions(db, [{ id: 's1', agent: 'claude', cwd: '/work/demo-project', projectId: pId }]);

  const now = Date.now();
  upsertEvents(db, [
    {
      id: 'e1',
      agent: 'claude',
      sessionId: 's1',
      ts: now,
      kind: 'assistant',
      model: 'claude-opus-5-5',
      input: 5000,
      output: 1000,
      cacheRead: 20000,
      cacheWrite: 500,
    },
  ]);

  insertQuotas(db, [
    {
      agent: 'claude',
      ts: now,
      window: '5h',
      usedPct: 45.0,
      resetsAt: now + 3600_000,
      source: 'claude-statusline',
    },
    {
      agent: 'codex',
      ts: now,
      window: '5h',
      usedPct: 20.0,
      resetsAt: now + 7200_000,
      source: 'codex-log',
    },
  ]);

  db.close();

  const out = run(['status', '--project', '/work/demo-project'], { AGENTLENS_DATA_DIR: dataDir });
  assert.match(out, /demo-project/);
  assert.match(out, /Tokens \(measured\)/);
  assert.match(out, /API-equivalent cost \(estimated\)/);
  assert.match(out, /Quota used \(reported by agent\)/);
  assert.match(out, /Claude 5h: 45%/);
  assert.match(out, /Codex 5h: 20%/);
});
