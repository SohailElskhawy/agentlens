import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aider } from '../src/adapters/aider.ts';

test('aider adapter parses analytics jsonl logs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-aider-jsonl-'));

  try {
    const jsonlPath = join(tmp, 'analytics.jsonl');
    const lines = [
      JSON.stringify({
        timestamp: '2026-10-15T10:00:00.000Z',
        session_id: 'aider-sess-1',
        model: 'claude-3-5-sonnet',
        tokens_sent: 1500,
        tokens_received: 420,
        cached_tokens: 300,
        project_dir: '/work/my-app',
        tools_used: ['git_diff', 'file_editor'],
      }),
    ];
    writeFileSync(jsonlPath, lines.join('\n') + '\n');

    const result = aider.read(jsonlPath, { offset: 0, state: {} });
    assert.equal(result.errors, 0);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].id, 'aider-sess-1');
    assert.equal(result.sessions[0].cwd, '/work/my-app');

    assert.equal(result.events.length, 3); // 1 assistant + 2 tool calls
    const ev = result.events[0];
    assert.equal(ev.agent, 'aider');
    assert.equal(ev.model, 'claude-3-5-sonnet');
    assert.equal(ev.input, 1500);
    assert.equal(ev.output, 420);
    assert.equal(ev.cacheRead, 300);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('aider adapter parses .aider.chat.history.md files', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-aider-md-'));

  try {
    const mdPath = join(tmp, '.aider.chat.history.md');
    const content = [
      '# aider chat started at 2026-10-15 14:00:00',
      '',
      '#### /model gpt-4o',
      '',
      '> Please fix the bug in index.ts',
      '',
      'I will inspect index.ts and fix the issue.',
      '',
      'Tokens: 1,200 sent, 450 received. Cost: $0.015 message, $0.015 session.',
      '',
      '> Thanks! Now check the test suite.',
      '',
      'Tests are passing now.',
      '',
      'Tokens: 2,500 sent, 600 received. Cost: $0.025 message, $0.040 session.',
    ].join('\n');

    writeFileSync(mdPath, content);

    const result = aider.read(mdPath, { offset: 0, state: {} });
    assert.equal(result.errors, 0);
    assert.equal(result.sessions.length, 1);
    assert.ok(result.sessions[0].id.startsWith('aider-'));
    assert.equal(result.events.length, 2);

    const ev1 = result.events[0];
    assert.equal(ev1.agent, 'aider');
    assert.equal(ev1.model, 'gpt-4o');
    assert.equal(ev1.input, 1200);
    assert.equal(ev1.output, 450);

    const ev2 = result.events[1];
    assert.equal(ev2.input, 2500);
    assert.equal(ev2.output, 600);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
