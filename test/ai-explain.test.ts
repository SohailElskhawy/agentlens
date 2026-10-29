import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSetting, upsertEvents, upsertProject, upsertSessions } from '../src/db.ts';
import { prepareExplanation, explainAnomaly } from '../src/ai/explain.ts';

const now = new Date(2026, 9, 22, 12).getTime();
function seeded() {
  const db = openDb(':memory:');
  const pid = upsertProject(db, '/private/project', 'project');
  upsertSessions(db, [{ id: 's', agent: 'claude', projectId: pid, cwd: '/private/project' }]);
  for (let d = 0; d <= 7; d++) {
    const date = new Date(2026, 9, 20 - d, 18);
    upsertEvents(db, [{ id: `e${d}`, sessionId: 's', agent: 'claude', ts: date.getTime(), kind: 'assistant', input: d ? 400_000 : 1_500_000 }]);
  }
  return db;
}
test('historical spike preview is stable, structured and requires exact consent', async () => {
  const db = seeded();
  const p = prepareExplanation(db, '2026-10-20', 'project', { now });
  assert.equal(p.status, 'ready');
  if (p.status !== 'ready') return;
  assert.deepEqual(p, prepareExplanation(db, '2026-10-20', 'project', { now: now + 1000 }));
  assert.ok(p.preview.prompt.length <= 12000);
  assert.ok(!p.preview.prompt.includes('/private/project'));
  let calls = 0;
  const runner = async () => { calls++; return { ok: true, text: JSON.stringify({ explanation: 'A spike is visible.' }) }; };
  assert.equal((await explainAnomaly(db, '2026-10-20', 'project', { now, runner })).status, 'error');
  setSetting(db, 'ai_enabled', 'true');
  assert.equal((await explainAnomaly(db, '2026-10-20', 'project', { now, runner, confirm: 'stale' })).status, 'confirmation_required');
  const ok = await explainAnomaly(db, '2026-10-20', 'project', { now, runner, confirm: p.preview.confirmationHash });
  assert.equal(ok.status, 'ok');
  assert.equal((await explainAnomaly(db, '2026-10-20', 'project', { now, runner })).status, 'ok');
  assert.equal(calls, 1);
  db.close();
});
test('invalid, future and non-spike dates are rejected', () => {
  const db = seeded();
  for (const date of ['2026-02-30', '2026-10-23', '2026-10-19', 'bad']) {
    assert.equal(prepareExplanation(db, date, 'project', { now }).status, 'error', date);
  }
  assert.equal(prepareExplanation(db, '2026-10-20', 'missing', { now }).status, 'error');
  db.close();
});

test('selection preserves project and agent identity and rejects ambiguous names', () => {
  const db = seeded();
  const pid = (db.prepare("SELECT id FROM projects WHERE name = 'project'").get() as { id: number }).id;
  upsertSessions(db, [{ id: 'other', agent: 'codex', projectId: pid, cwd: '/secret' }]);
  for (let d = 0; d <= 7; d++) upsertEvents(db, [{ id: `codex${d}`, sessionId: 'other', agent: 'codex', ts: new Date(2026, 9, 20 - d, 18).getTime(), kind: 'assistant', input: d ? 400_000 : 1_500_000 }]);
  assert.equal(prepareExplanation(db, '2026-10-20', 'project', { now }).status, 'error');
  const selected = prepareExplanation(db, '2026-10-20', String(pid), { now, agent: 'codex' });
  assert.equal(selected.status, 'ready');
  if (selected.status === 'ready') assert.match(selected.preview.prompt, /"agent":"codex"/);
  assert.equal(prepareExplanation(db, '2026-10-20', String(pid), { now, agent: 'missing' }).status, 'error');
  db.close();
});
test('cap, malformed output and runner failures are clean and do not cache', async () => {
  const db = seeded(); setSetting(db, 'ai_enabled', 'true');
  const p = prepareExplanation(db, '2026-10-20', 'project', { now });
  assert.equal(p.status, 'ready'); if (p.status !== 'ready') return;
  let calls = 0;
  const runner = async () => { calls++; return { ok: true, text: 'private invalid output' }; };
  setSetting(db, 'ai_max_calls_per_day', '0');
  let r = await explainAnomaly(db, '2026-10-20', 'project', { now, runner, confirm: p.preview.confirmationHash });
  assert.equal(r.status === 'error' && r.code, 'AI_DAILY_LIMIT'); assert.equal(calls, 0);
  setSetting(db, 'ai_max_calls_per_day', '20');
  r = await explainAnomaly(db, '2026-10-20', 'project', { now, runner, confirm: p.preview.confirmationHash });
  assert.equal(r.status === 'error' && r.code, 'AI_INVALID_OUTPUT'); assert.ok(!JSON.stringify(r).includes('private'));
  r = await explainAnomaly(db, '2026-10-20', 'project', { now, runner: async () => { throw Error('secret'); }, confirm: p.preview.confirmationHash });
  assert.equal(r.status === 'error' && r.code, 'AI_RUN_FAILED');
  assert.equal((db.prepare('SELECT count(*) AS n FROM ai_notes').get() as { n: number }).n, 0);
  db.close();
});

test('CLI previews and rejects unconfirmed calls without launching an agent', async () => {
  const { spawnSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { tmp } = await import('./helpers.ts');
  const dir = tmp(); const db = openDb(join(dir, 'agentlens.db'));
  const pid = upsertProject(db, '/private/work', 'project');
  upsertSessions(db, [{ id: 'cli', agent: 'claude', projectId: pid, cwd: '/private/work' }]);
  const day = new Date(); day.setDate(day.getDate() - 1); day.setHours(12, 0, 0, 0);
  for (let d = 0; d <= 7; d++) { const date = new Date(day); date.setDate(date.getDate() - d); upsertEvents(db, [{ id: `cli${d}`, sessionId: 'cli', agent: 'claude', ts: date.getTime(), kind: 'assistant', input: d ? 400_000 : 1_500_000 }]); }
  setSetting(db, 'ai_enabled', 'true'); db.close();
  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', cli, 'explain', ...args], { encoding: 'utf8', env: { ...process.env, AGENTLENS_DATA_DIR: dir, AGENTLENS_STATE_DIR: dir, AGENTLENS_SOURCE_HOME: dir, PATH: '' } });
  const preview = run('anomaly', date, 'project', '--preview', '--json');
  assert.equal(preview.status, 0, preview.stderr);
  const p = JSON.parse(preview.stdout); assert.match(p.preview.confirmationHash, /^[a-f0-9]{64}$/);
  const missing = run('anomaly', date, 'project', '--json'); assert.notEqual(missing.status, 0); assert.equal(JSON.parse(missing.stdout).status, 'confirmation_required');
  assert.notEqual(run('anomaly', date, 'project', '--confirm', 'bad').status, 0);
  const check = openDb(join(dir, 'agentlens.db')); assert.equal((check.prepare('SELECT count(*) AS n FROM ai_calls').get() as { n: number }).n, 0); check.close();
});

test('today stops at now and changed spike data invalidates consent without changing detections', async () => {
  const db = seeded(); setSetting(db, 'ai_enabled', 'true');
  const before = prepareExplanation(db, '2026-10-20', 'project', { now });
  assert.equal(before.status, 'ready'); if (before.status !== 'ready') return;
  upsertEvents(db, [{ id: 'extra', sessionId: 's', agent: 'claude', ts: new Date(2026, 9, 20, 20).getTime(), kind: 'assistant', input: 100_000 }]);
  let calls = 0;
  const result = await explainAnomaly(db, '2026-10-20', 'project', { now, confirm: before.preview.confirmationHash, runner: async () => { calls++; return { ok: true, text: '{}' }; } });
  assert.equal(result.status, 'confirmation_required'); assert.equal(calls, 0);
  const today = new Date(2026, 9, 20, 12).getTime();
  assert.equal(prepareExplanation(db, '2026-10-20', 'project', { now: today }).status, 'error');
  db.close();
});
