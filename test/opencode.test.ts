import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { opencode } from '../src/adapters/opencode.ts';
import { tmp } from './helpers.ts';

function createOpencodeDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      directory TEXT NOT NULL,
      parent_id TEXT,
      title TEXT NOT NULL,
      time_created INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  return db;
}

test('opencode root and discover locate opencode.db', () => {
  const home = tmp();
  const dbDir = join(home, '.local/share/opencode');
  assert.equal(opencode.root(home), dbDir);
  assert.deepEqual(opencode.discover(dbDir), []);

  const dbPath = join(dbDir, 'opencode.db');
  createOpencodeDb(dbPath).close();
  assert.deepEqual(opencode.discover(dbDir), [dbPath]);
});

test('opencode read extracts sessions, messages with tokens, and tools', () => {
  const dbPath = join(tmp(), 'opencode.db');
  const db = createOpencodeDb(dbPath);

  db.prepare(`INSERT INTO session (id, project_id, directory, parent_id, title, time_created)
    VALUES (?, ?, ?, ?, ?, ?)`).run('ses_1', 'p1', '/work/my-app', null, 'Initial Session', 1000);

  const userMsgData = JSON.stringify({
    role: 'user',
    path: { cwd: '/work/my-app' },
    time: { created: 1010 },
  });
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?)`).run('msg_u1', 'ses_1', 1010, 1010, userMsgData);

  const userTextPart = JSON.stringify({
    type: 'text',
    text: 'please build this feature',
  });
  db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?)`).run('prt_u1', 'msg_u1', 'ses_1', 1011, 1011, userTextPart);

  const asstMsgData = JSON.stringify({
    role: 'assistant',
    modelID: 'claude-sonnet-4-6',
    path: { cwd: '/work/my-app' },
    tokens: {
      input: 1200,
      output: 80,
      reasoning: 20,
      cache: { read: 5000, write: 300 },
    },
    time: { created: 1020, completed: 1025 },
  });
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?)`).run('msg_a1', 'ses_1', 1020, 1025, asstMsgData);

  const toolPart = JSON.stringify({
    type: 'tool',
    tool: 'bash',
    state: {
      status: 'completed',
      input: { command: 'git status' },
      output: 'On branch master\nnothing to commit',
      metadata: { exit: 0 },
    },
  });
  db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?)`).run('prt_t1', 'msg_a1', 'ses_1', 1022, 1023, toolPart);

  db.close();

  const r1 = opencode.read(dbPath, { offset: 0, state: {} });
  assert.equal(r1.errors, 0);
  assert.equal(r1.sessions.length, 1);
  assert.equal(r1.sessions[0].id, 'ses_1');
  assert.equal(r1.sessions[0].cwd, '/work/my-app');

  const asstEvent = r1.events.find((e) => e.kind === 'assistant');
  assert.ok(asstEvent);
  assert.equal(asstEvent.agent, 'opencode');
  assert.equal(asstEvent.model, 'claude-sonnet-4-6');
  assert.equal(asstEvent.input, 1200);
  assert.equal(asstEvent.output, 80);
  assert.equal(asstEvent.reasoning, 20);
  assert.equal(asstEvent.cacheRead, 5000);
  assert.equal(asstEvent.cacheWrite, 300);

  const toolCall = r1.events.find((e) => e.kind === 'tool_call');
  const toolResult = r1.events.find((e) => e.kind === 'tool_result');
  assert.ok(toolCall);
  assert.ok(toolResult);
  assert.equal(toolCall.tool, 'bash');
  assert.equal(toolResult.id, `${toolCall.id}:result`);
  assert.equal(toolResult.isError, false);
  assert.ok(toolResult.resultBytes! > 0);

  // Incremental: reading with previous cursor reads nothing new
  const r2 = opencode.read(dbPath, r1.cursor);
  assert.equal(r2.events.length, 0);
});

test('opencode read handles missing token blocks and corrupted json rows gracefully', () => {
  const dbPath = join(tmp(), 'opencode_corrupt.db');
  const db = createOpencodeDb(dbPath);

  db.prepare(`INSERT INTO session (id, project_id, directory, parent_id, title, time_created)
    VALUES (?, ?, ?, ?, ?, ?)`).run('ses_c', null, '/work/test', null, 'Corrupt test', 100);

  // Row without tokens
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?)`).run('msg_no_tok', 'ses_c', 110, 110, JSON.stringify({ role: 'assistant' }));

  // Row with bad json
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?)`).run('msg_bad', 'ses_c', 120, 120, '{bad json');

  // Good row
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?)`).run('msg_good', 'ses_c', 130, 130, JSON.stringify({
    role: 'assistant',
    modelID: 'gpt-4o',
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 130 },
  }));

  db.close();

  const r = opencode.read(dbPath, { offset: 0, state: {} });
  assert.equal(r.errors, 1, 'bad json row counted as error');
  assert.ok(r.events.some((e) => e.id === 'opencode:msg_good'));
});
