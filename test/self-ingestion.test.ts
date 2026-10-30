import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openDb, getCursor, upsertSessions, upsertProject, upsertEvents, upsertFindings, upsertRecommendations, getRecommendations } from '../src/db.ts';
import { claude } from '../src/adapters/claude.ts';
import { ADAPTERS, ingest } from '../src/ingest.ts';
import { runDetectors } from '../src/analyze/runner.ts';
import { runAudit } from '../src/audit/runner.ts';
import { isAnalystCwd, isTempProject } from '../src/temp-project.ts';
import { generateRecommendations } from '../src/recommend.ts';
import { tmp, put, jsonl, cAssistant } from './helpers.ts';
import type { Adapter, Finding } from '../src/types.ts';

test('every adapter boundary excludes analyst sessions across mixed incremental batches', async () => {
  for (const base of ADAPTERS) {
    const home = tmp();
    const file = put(join(home, 'data'), 'x');
    const db = openDb(':memory:');
    let batch = 0;
    const adapter: Adapter = { ...base, root: () => home, discover: () => [file], read: (_path, cursor) => {
      batch++;
      const sessions = batch === 1 ? [
        { id: 'bad', agent: base.agent, cwd: join(tmpdir(), 'agentlens-ai-abc', 'child') },
        { id: 'legacy', agent: base.agent, cwd: join(tmpdir(), 'agentlens-ai') },
        { id: 'good', agent: base.agent, cwd: '/home/user/tmp/agentlens-ai-project' },
      ] : [];
      return { sessions, events: ['bad', 'legacy', 'good', 'old'].map((id) => ({ id: `${id}-${batch}`, agent: base.agent, sessionId: id, ts: 1, kind: 'user' as const })), quotas: [], cursor: { offset: cursor.offset + 1, state: {} }, errors: 0, skipped: 0 };
    } };
    upsertSessions(db, [{ id: 'old', agent: base.agent, cwd: join(tmpdir(), 'agentlens-ai-previous'), projectId: null }]);
    await ingest(db, home, [adapter]);
    appendFileSync(file, 'x');
    await ingest(db, home, [adapter]);
    assert.deepEqual((db.prepare('SELECT id FROM events ORDER BY id').all() as { id: string }[]).map((r) => r.id), ['good-1', 'good-2'], base.agent);
    assert.equal(getCursor(db, file)?.offset, 2);
    assert.deepEqual((db.prepare('SELECT id FROM sessions ORDER BY id').all() as { id: string }[]).map((r) => r.id), ['good', 'old']);
  }
});

test('Claude mixed actual log excludes analyst and continues incremental reads', async () => {
  const home = tmp();
  const file = put(join(home, '.claude/projects/-test/mixed.jsonl'), jsonl(
    cAssistant({ msg: 'bad', session: 'bad', cwd: '/tmp/agentlens-ai-abc/sub' }),
    cAssistant({ msg: 'good', session: 'good', cwd: '/home/user/agentlens-ai-project' }),
  ));
  const db = openDb(':memory:');
  await ingest(db, home, [claude]);
  const record = cAssistant({ msg: 'bad2', session: 'bad' });
  delete (record as { cwd?: string }).cwd;
  appendFileSync(file, jsonl(record));
  await ingest(db, home, [claude]);
  assert.deepEqual((db.prepare('SELECT session_id FROM events').all() as { session_id: string }[]).map((r) => r.session_id), ['good']);
});

test('refresh excludes temp project findings and open recommendations while keeping history', () => {
  const db = openDb(':memory:');
  const temp = upsertProject(db, join(tmpdir(), 'fixture'), 'fixture');
  const real = upsertProject(db, '/home/user/tmp/agentlens-ai-work', 'work');
  const now = Date.now();
  for (const [id, projectId] of [['temp', temp], ['real', real]] as const) {
    upsertSessions(db, [{ id, agent: 'claude', projectId }]);
    upsertEvents(db, [{ id, agent: 'claude', sessionId: id, ts: now, kind: 'assistant', model: 'claude-opus-4', input: 100, output: 10 }]);
  }
  const finding: Finding = { id: 'historic', rule: 'model_fit', projectId: temp, sessionId: 'temp', evidence: {}, confidence: 'high', confidenceReason: '', estTokensWeek: 100, firstSeen: now, lastSeen: now };
  upsertFindings(db, [finding]);
  const rec = generateRecommendations([finding])[0];
  upsertRecommendations(db, [rec, { ...rec, id: 'accepted', status: 'accepted', acceptedAt: now }]);
  const found = runDetectors(db, { now, gitReader: () => [] });
  assert.ok(found.some((f) => f.projectId === real));
  assert.ok(found.every((f) => f.projectId !== temp && f.sessionId !== 'temp'));
  runAudit(db, tmp());
  assert.ok(!getRecommendations(db).some((r) => r.id === rec.id));
  assert.ok(getRecommendations(db).some((r) => r.id === 'accepted' && r.status === 'accepted'));
});

test('real adapter formats exclude analyst sessions and retain normal sessions', async () => {
  const home = tmp();
  const bad = '/tmp/agentlens-ai-real/sub';
  const good = '/home/user/project';
  const stamp = '2026-10-15T10:00:00.000Z';
  const fixtures: Array<{ agent: string; files: string[] }> = [];
  const codexFiles = ['bad', 'good'].map((id, i) => put(join(home, `codex/rollout-${id}.jsonl`), jsonl(
    { timestamp: stamp, type: 'session_meta', payload: { cwd: i ? good : bad } },
    { timestamp: stamp, type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
  )));
  fixtures.push({ agent: 'codex', files: codexFiles });
  fixtures.push({ agent: 'gemini', files: [put(join(home, 'gemini.jsonl'), jsonl(
    { sessionId: 'bad', cwd: bad, inputTokens: 1 }, { sessionId: 'good', cwd: good, inputTokens: 1 },
  ))] });
  fixtures.push({ agent: 'aider', files: [put(join(home, 'aider.jsonl'), jsonl(
    { session_id: 'bad', cwd: bad, tokens_sent: 1 }, { session_id: 'good', cwd: good, tokens_sent: 1 },
  ))] });
  fixtures.push({ agent: 'antigravity', files: ['bad', 'good'].map((id, i) => put(join(home, `antigravity/brain/${id}/.system_generated/logs/transcript.jsonl`), jsonl(
    { type: 'PLANNER_RESPONSE', step_index: 1, input_tokens: 1, tool_calls: [{ name: 'run', args: { Cwd: i ? good : bad } }] },
  ))) });
  const cursorPath = join(home, 'cursor.db');
  const cursorDb = new DatabaseSync(cursorPath);
  cursorDb.exec('CREATE TABLE ItemTable (key TEXT, value TEXT)');
  cursorDb.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('composer', JSON.stringify({ allComposers: [
    { id: 'bad', projectPath: bad, messages: [{ role: 'assistant', id: 'b' }] },
    { id: 'good', projectPath: good, messages: [{ role: 'assistant', id: 'g' }] },
  ] }));
  cursorDb.close();
  fixtures.push({ agent: 'cursor', files: [cursorPath] });
  const opencodePath = join(home, 'opencode.db');
  const source = new DatabaseSync(opencodePath);
  source.exec('CREATE TABLE session (id TEXT, directory TEXT, parent_id TEXT); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
  for (const [id, cwd] of [['bad', bad], ['good', good]]) {
    source.prepare('INSERT INTO session VALUES (?, ?, NULL)').run(id, cwd);
    source.prepare('INSERT INTO message VALUES (?, ?, 1, ?)').run(id, id, JSON.stringify({ role: 'assistant' }));
  }
  source.close();
  fixtures.push({ agent: 'opencode', files: [opencodePath] });
  for (const { agent, files } of fixtures) {
    const base = ADAPTERS.find((a) => a.agent === agent)!;
    const adapter: Adapter = { ...base, root: () => home, discover: () => files };
    const db = openDb(':memory:');
    await ingest(db, home, [adapter]);
    const sessions = db.prepare('SELECT cwd FROM sessions').all() as { cwd: string }[];
    assert.deepEqual(sessions.map((s) => s.cwd), [good], agent);
    assert.ok((db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n > 0, agent);
    assert.equal((db.prepare('SELECT count(*) AS n FROM projects').get() as { n: number }).n, 1, agent);
  }
});

test('a known analyst session remains excluded in another adapter file', async () => {
  const home = tmp();
  const meta = put(join(home, 'meta.jsonl'), jsonl({ sessionId: 'shared', cwd: '/tmp/agentlens-ai-one', inputTokens: 1 }));
  const later = put(join(home, 'later.jsonl'), jsonl({ sessionId: 'shared', inputTokens: 1 }));
  const gemini = ADAPTERS.find((a) => a.agent === 'gemini')!;
  const adapter: Adapter = { ...gemini, root: () => home, discover: () => [meta, later] };
  const db = openDb(':memory:');
  await ingest(db, home, [adapter]);
  assert.equal((db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n, 0);
  assert.ok(getCursor(db, later));
});

test('temporary path matching respects directory boundaries', () => {
  assert.equal(isTempProject(join(tmpdir(), 'work')), true);
  assert.equal(isTempProject('/tmp/work'), true);
  assert.equal(isTempProject('/tmp-work/project'), false);
  assert.equal(isTempProject('/home/user/tmp/work'), false);
  assert.equal(isAnalystCwd('/home/user/agentlens-ai-work'), false);
  assert.equal(isAnalystCwd(join(tmpdir(), 'agentlens-ai-other', 'child')), true);
  assert.equal(isAnalystCwd(join(tmpdir(), 'agentlens-aiish')), false);
});

test('audit skips temporary project configurations and detector does not inspect their git history', () => {
  const home = tmp();
  const project = join(home, 'project');
  put(join(project, 'CLAUDE.md'), '# instructions\n' + 'x'.repeat(25000));
  const db = openDb(':memory:');
  const projectId = upsertProject(db, project, 'temporary');
  const inspected: string[] = [];
  runDetectors(db, { gitReader: (root) => { inspected.push(root); return []; } });
  assert.deepEqual(inspected, []);
  const audit = runAudit(db, join(home, 'home'));
  assert.ok(audit.items.every((item) => item.projectId !== projectId));
  assert.ok(audit.findings.every((finding) => finding.projectId !== projectId));
  assert.ok(audit.trimmings.every((trim) => trim.filePath !== join(project, 'CLAUDE.md')));
});
