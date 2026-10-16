import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gemini } from '../src/adapters/gemini.ts';

test('gemini adapter discovers and reads jsonl session logs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-gemini-test-'));

  try {
    const sessionsDir = join(tmp, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    const logFile = join(sessionsDir, 'session-abc.jsonl');
    const lines = [
      JSON.stringify({
        sessionId: 'gem-sess-1',
        timestamp: 1730000000000,
        model: 'gemini-2.5-flash',
        inputTokens: 500,
        outputTokens: 120,
        cacheReadTokens: 100,
        thinkingTokens: 40,
        cwd: '/path/to/my-project',
        tools: [{ name: 'read_file', args: { file: 'main.ts' } }],
      }),
      JSON.stringify({
        sessionId: 'gem-sess-1',
        timestamp: 1730000005000,
        model: 'gemini-2.5-flash',
        inputTokens: 800,
        outputTokens: 250,
        cacheReadTokens: 400,
      }),
    ];
    writeFileSync(logFile, lines.join('\n') + '\n');

    const discovered = gemini.discover(tmp);
    assert.ok(discovered.includes(logFile));

    const result = gemini.read(logFile, { offset: 0, state: {} });
    assert.equal(result.errors, 0);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].id, 'gem-sess-1');
    assert.equal(result.sessions[0].cwd, '/path/to/my-project');

    // 2 assistant events + 1 tool call event = 3 events
    assert.equal(result.events.length, 3);
    const ev1 = result.events[0];
    assert.equal(ev1.agent, 'gemini');
    assert.equal(ev1.input, 500);
    assert.equal(ev1.output, 120);
    assert.equal(ev1.cacheRead, 100);
    assert.equal(ev1.reasoning, 40);

    const toolEv = result.events[1];
    assert.equal(toolEv.kind, 'tool_call');
    assert.equal(toolEv.tool, 'read_file');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('gemini adapter reads json session files', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-gemini-json-'));

  try {
    const chatsDir = join(tmp, 'chats');
    mkdirSync(chatsDir, { recursive: true });

    const jsonFile = join(chatsDir, 'chat-xyz.json');
    const data = [
      {
        sessionId: 'gem-chat-2',
        timestamp: '2026-10-15T12:00:00Z',
        model: 'gemini-2.5-pro',
        promptTokens: 1200,
        candidateTokens: 300,
        tokens: { cached: 500 },
        projectPath: '/path/to/repo',
        tools: ['search_code'],
      },
    ];
    writeFileSync(jsonFile, JSON.stringify(data));

    const result = gemini.read(jsonFile, { offset: 0, state: {} });
    assert.equal(result.errors, 0);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].id, 'gem-chat-2');
    assert.equal(result.sessions[0].cwd, '/path/to/repo');
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].model, 'gemini-2.5-pro');
    assert.equal(result.events[0].input, 1200);
    assert.equal(result.events[0].output, 300);
    assert.equal(result.events[0].cacheRead, 500);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
