import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { antigravity } from '../src/adapters/antigravity.ts';
import { tmp } from './helpers.ts';

function createSummaryDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      workspace_uris TEXT NOT NULL,
      last_modified_time DATETIME NOT NULL,
      parent_conversation_id TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}

test('antigravity root and discover locate conversation_summaries.db', () => {
  const home = tmp();
  const root = antigravity.root(home);
  assert.equal(root, join(home, '.gemini'));
  assert.deepEqual(antigravity.discover(root), []);

  const cliDb = join(root, 'antigravity-cli/conversation_summaries.db');
  createSummaryDb(cliDb).close();
  assert.deepEqual(antigravity.discover(root), [cliDb]);
});

test('antigravity read parses sessions and maps workspace_uris to cwd', () => {
  const home = tmp();
  const root = antigravity.root(home);
  const cliDb = join(root, 'antigravity-cli/conversation_summaries.db');
  const db = createSummaryDb(cliDb);

  db.prepare(`INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, last_modified_time, parent_conversation_id)
    VALUES (?, ?, ?, ?, ?)`).run(
    'conv-1',
    'Feature Implementation',
    JSON.stringify(['file:///home/user/projects/my-web-app']),
    '2026-10-15 12:00:00+00:00',
    '',
  );

  db.close();

  // Test with fallback when ccusage is unavailable or returns empty
  const r = antigravity.read(cliDb, { offset: 0, state: {} });
  assert.equal(r.errors, 0);
  assert.equal(r.sessions.length, 1);
  assert.equal(r.sessions[0].id, 'conv-1');
  assert.equal(r.sessions[0].cwd, '/home/user/projects/my-web-app');
  assert.equal(r.sessions[0].agent, 'antigravity');
});

test('antigravity maps ccusage session tokens into normalized events', () => {
  const home = tmp();
  const root = antigravity.root(home);
  const cliDb = join(root, 'antigravity-cli/conversation_summaries.db');
  const db = createSummaryDb(cliDb);

  db.prepare(`INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, last_modified_time, parent_conversation_id)
    VALUES (?, ?, ?, ?, ?)`).run(
    'conv-tokens',
    'Token Task',
    JSON.stringify(['file:///home/user/repo']),
    '2026-10-15 14:00:00+00:00',
    '',
  );
  db.close();

  // Mock ccusage session json provider
  const mockCcusageData = {
    sessions: [
      {
        sessionId: 'conv-tokens',
        firstActivity: '2026-10-15T14:00:00.000Z',
        lastActivity: '2026-10-15T14:05:00.000Z',
        inputTokens: 10000,
        outputTokens: 500,
        cacheReadTokens: 40000,
        cacheCreationTokens: 1000,
        modelsUsed: ['gemini-3.8-flash-high'],
        totalTokens: 51500,
      },
    ],
  };

  const r = antigravity.read(cliDb, { offset: 0, state: {} }, () => mockCcusageData);
  assert.equal(r.sessions.length, 1);
  assert.equal(r.events.length, 1);
  const ev = r.events[0];
  assert.equal(ev.sessionId, 'conv-tokens');
  assert.equal(ev.agent, 'antigravity');
  assert.equal(ev.model, 'gemini-3.8-flash-high');
  assert.equal(ev.input, 10000);
  assert.equal(ev.output, 500);
  assert.equal(ev.cacheRead, 40000);
  assert.equal(ev.cacheWrite, 1000);
});
