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

test('antigravity natively discovers and parses brain/*/transcript.jsonl without ccusage', async () => {
  const { writeFileSync } = await import('node:fs');
  const home = tmp();
  const root = antigravity.root(home);
  const cliDir = join(root, 'antigravity-cli');
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(join(cliDir, 'settings.json'), JSON.stringify({ model: 'Gemini 4 Argon (High)' }));

  const convId = 'ae1c3906-f015-4126-8f58-1d61db946ae2';
  const logDir = join(cliDir, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(logDir, { recursive: true });
  const transcriptPath = join(logDir, 'transcript.jsonl');

  const lines = [
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-10-17T11:00:00Z',
      content: 'Please inspect the project',
    }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-10-17T11:00:05Z',
      input_tokens: 12500,
      cache_read_tokens: 48000,
      output_tokens: 620,
      thinking: 'Let us inspect the directory first.',
      tool_calls: [
        { name: 'run_command', args: { Cwd: '/home/user/my-project', CommandLine: 'ls -la' } },
      ],
    }),
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-10-17T11:00:06Z',
      content: 'total 12\ndrwxr-xr-x 2 user user 4096 Oct 17 11:00 .',
    }),
  ];
  writeFileSync(transcriptPath, lines.join('\n') + '\n');

  const discovered = antigravity.discover(root);
  assert.ok(discovered.includes(transcriptPath));

  const res = antigravity.read(transcriptPath, { offset: 0, state: {} });
  assert.equal(res.errors, 0);
  assert.equal(res.sessions.length, 1);
  assert.equal(res.sessions[0].id, convId);
  assert.equal(res.sessions[0].cwd, '/home/user/my-project');

  const assistantEv = res.events.find((e) => e.kind === 'assistant');
  assert.ok(assistantEv);
  assert.equal(assistantEv.sessionId, convId);
  assert.equal(assistantEv.model, 'Gemini 4 Argon (High)');
  assert.equal(assistantEv.input, 12500);
  assert.equal(assistantEv.cacheRead, 48000);
  assert.equal(assistantEv.output, 620);
  assert.ok((assistantEv.reasoning ?? 0) > 0);

  const toolCallEv = res.events.find((e) => e.kind === 'tool_call');
  assert.ok(toolCallEv);
  assert.equal(toolCallEv.tool, 'run_command');

  const toolResultEv = res.events.find((e) => e.kind === 'tool_result');
  assert.ok(toolResultEv);
  assert.ok((toolResultEv.resultBytes ?? 0) > 0);
});

