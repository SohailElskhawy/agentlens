import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.ts';
import { ingest } from '../src/ingest.ts';
import { hash } from '../src/util.ts';
import { cline } from '../src/adapters/cline.ts';
import { tmp } from './helpers.ts';

const TASK_ID = '20260101090000-00001';
const MODEL = 'fixture-model';
const T0 = 1767225000000;
const T1 = 1767225001000;
const T2 = 1767225002000;
const T3 = 1767225003000;
const T4 = 1767225004000;

// Each sentinel is raw user/assistant/message text that must never reach the DB.
const uid = Math.random().toString(36).slice(2);
const PROMPT = `SENTINEL-PROMPT-${uid}-do-not-store`;
const REPLY = `SENTINEL-REPLY-${uid}-do-not-store`;
const UI_TEXT = `SENTINEL-UI-TEXT-${uid}-do-not-store`;
const ERR_TEXT = `SENTINEL-ERR-TEXT-${uid}-do-not-store`;
const TASK_TEXT = `SENTINEL-TASK-TEXT-${uid}-do-not-store`;

const globalStorage = (home: string) => join(home, '.config/Code/User/globalStorage');
const taskDir = (home: string) => join(globalStorage(home), 'saoudrizwan.claude-dev/tasks', TASK_ID);

interface FixtureOptions { cwd: string }
function writeFixture(home: string, o: FixtureOptions) {
  const dir = taskDir(home);
  mkdirSync(dir, { recursive: true });
  // api_conversation_history.json: one JSON.parse-per-file MessageParam array (synthetic only)
  writeFileSync(join(dir, 'api_conversation_history.json'), JSON.stringify([
    { role: 'user', content: PROMPT },
    { role: 'assistant', content: [{ type: 'text', text: REPLY }] },
  ]));
  // ui_messages.json: usage rows are per-request deltas (tokensIn uncached input; in+cache = full request input)
  writeFileSync(join(dir, 'ui_messages.json'), JSON.stringify([
    { ts: T1, type: 'say', say: 'api_req_started', text: JSON.stringify({ tokensIn: 10, tokensOut: 20, cacheWrites: 0, cacheReads: 90, cost: 0.001 }) },
    { ts: T2, type: 'say', say: 'api_req_started', text: JSON.stringify({ tokensIn: 5, tokensOut: 7, cacheWrites: 2, cacheReads: 80 }) },
    { ts: T3, type: 'ask', ask: 'api_req_failed', text: UI_TEXT },
    { ts: T4, type: 'say', say: 'error', text: ERR_TEXT },
  ]));
  // Cumulative HistoryItem counters (9999/8888/...) must be ignored in favor of per-request sums.
  mkdirSync(join(globalStorage(home), 'saoudrizwan.claude-dev/state'), { recursive: true });
  writeFileSync(join(globalStorage(home), 'saoudrizwan.claude-dev/state/taskHistory.json'), JSON.stringify([
    { id: '20251229-other-task', ts: 1, task: 'unrelated' },
    {
      id: TASK_ID, ts: T0, task: TASK_TEXT, tokensIn: 9999, tokensOut: 8888, cacheWrites: 7777,
      cacheReads: 6666, totalCost: 9.99, cwdOnTaskInitialization: o.cwd, modelId: MODEL,
    },
  ]));
  return dir;
}

const assistantEvents = (db: DB) => db.prepare("SELECT * FROM events WHERE agent = 'cline' AND kind = 'assistant' ORDER BY ts").all() as any[];

test('cline adapter discovers the task and extracts per-request accounting from the evidence-verified path', () => {
  const home = tmp();
  try {
    writeFixture(home, { cwd: '/tmp/agentlens-fixture-workspace' });
    const apiPath = join(taskDir(home), 'api_conversation_history.json');

    assert.deepEqual(cline.discover(cline.root(home)), [apiPath]);

    const result = cline.read(apiPath, { offset: 0, state: {} });
    assert.equal(result.errors, 0);

    const usage = result.events.filter((e) => e.kind === 'assistant');
    assert.equal(usage.length, 2);
    assert.deepEqual(
      usage.map((e) => ({
        ts: e.ts, input: e.input, output: e.output, cacheRead: e.cacheRead, cacheWrite: e.cacheWrite, model: e.model,
      })),
      [
        { ts: T1, input: 10, output: 20, cacheRead: 90, cacheWrite: 0, model: MODEL },
        { ts: T2, input: 5, output: 7, cacheRead: 80, cacheWrite: 2, model: MODEL },
      ],
    );
    const flagged = result.events.filter((e) => e.isError);
    assert.equal(flagged.length, 2, 'api_req_failed and say error rows are flagged as errors');
    // Cumulative HistoryItem counters must not leak in (no double counting).
    assert.ok(!result.events.some((e) => e.input === 9999 || e.output === 8888));

    const s = result.sessions[0];
    assert.equal(s.id, hash(TASK_ID), 'the stored session id is the hashed task id');
    assert.equal(s.agent, 'cline');
    assert.equal(s.cwd, '/tmp/agentlens-fixture-workspace');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cline ingest records no raw conversation text, only hashed ids, metadata and flags', async () => {
  const home = tmp();
  try {
    writeFixture(home, { cwd: '/tmp/agentlens-cline-fixture-project' });
    const db = openDb(':memory:');
    await ingest(db, home, [cline]);

    let corpus = '';
    for (const table of ['events', 'sessions', 'projects', 'cursors', 'findings']) {
      for (const row of db.prepare(`SELECT * FROM ${table}`).all() as any[]) corpus += JSON.stringify(row) + '\n';
    }
    for (const raw of [PROMPT, REPLY, UI_TEXT, ERR_TEXT, TASK_TEXT]) {
      assert.ok(!corpus.includes(raw), `no raw text "${raw}" stored`);
    }
    assert.ok(corpus.includes(hash(TASK_ID)), 'the hashed session id is present');
    const usage = assistantEvents(db);
    assert.deepEqual(usage.map((e) => e.input), [10, 5], 'token counts recorded, per-request deltas only');
    const flagged = (db.prepare("SELECT * FROM events WHERE agent = 'cline' AND is_error = 1").all() as any[]);
    assert.equal(flagged.length, 2, 'both error rows flagged');
    const project = db.prepare(`SELECT p.root, p.name FROM sessions s JOIN projects p ON p.id = s.project_id`).get() as any;
    assert.deepEqual({ ...project }, { root: '/tmp/agentlens-cline-fixture-project', name: 'agentlens-cline-fixture-project' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an agentlens-ai-* cwd task is skipped by ingest', async () => {
  const home = tmp();
  try {
    writeFixture(home, { cwd: join(tmpdir(), `agentlens-ai-fixture-${uid}`, 'workspace') });
    const db = openDb(':memory:');
    const s = await ingest(db, home, [cline]);
    assert.equal(s.read, 1, 'the file still registers as read; the skip happens at upsert time');
    assert.equal(assistantEvents(db).length, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get()!.n, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a malformed ui_messages.json skips rows without throwing out of ingest', async () => {
  const home = tmp();
  try {
    writeFixture(home, { cwd: '/tmp/agentlens-fixture-workspace' });
    writeFileSync(join(taskDir(home), 'ui_messages.json'), '{"truncated: [1,');
    const db = openDb(':memory:');
    const s = await ingest(db, home, [cline]); // must not throw
    const r = cline.read(join(taskDir(home), 'api_conversation_history.json'), { offset: 0, state: {} });
    assert.ok(r.errors >= 1);
    assert.equal(r.events.length, 0);
    assert.equal(s.read, 1);
    const sessions = db.prepare('SELECT * FROM sessions').all() as any[];
    assert.equal(sessions.length, 1, 'the session is still recorded from taskHistory');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a malformed taskHistory.json still yields the session without metadata fields', () => {
  const home = tmp();
  try {
    writeFixture(home, { cwd: '/tmp/agentlens-fixture-workspace' });
    writeFileSync(join(globalStorage(home), 'saoudrizwan.claude-dev/state/taskHistory.json'), 'not json at all');
    const r = cline.read(join(taskDir(home), 'api_conversation_history.json'), { offset: 0, state: {} });
    const usage = r.events.filter((e) => e.kind === 'assistant');
    assert.equal(usage.length, 2, 'usage rows from ui_messages survive');
    assert.equal(usage.some((e) => e.model !== undefined), false, 'no model name when history is unreadable');
    assert.equal(r.errors >= 1, true, 'the corrupt history is counted, not thrown');
    const s = r.sessions[0];
    assert.equal(s.id, hash(TASK_ID));
    assert.equal(s.cwd, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('re-ingesting an unchanged cline task is idempotent (no duplicate rows)', async () => {
  const home = tmp();
  try {
    writeFixture(home, { cwd: '/tmp/agentlens-cline-fixture-project' });
    const db = openDb(':memory:');
    await ingest(db, home, [cline]);
    const s2 = await ingest(db, home, [cline]);
    assert.equal(s2.read, 0, 'an unchanged task is not re-read at all');
    assert.equal(assistantEvents(db).length, 2);
    const totals = db.prepare(`SELECT sum(input) AS input, sum(output) AS output, sum(cache_read) AS cacheRead FROM events WHERE agent = 'cline' AND kind = 'assistant'`).get() as any;
    assert.deepEqual({ ...totals }, { input: 15, output: 27, cacheRead: 170 });
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get()!.n, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
