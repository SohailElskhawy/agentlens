import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cursor } from '../src/adapters/cursor.ts';

test('cursor adapter discovers and reads state.vscdb', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-cursor-test-'));

  try {
    const dbDir = join(tmp, 'User/globalStorage');
    mkdirSync(dbDir, { recursive: true });

    const dbPath = join(dbDir, 'state.vscdb');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');

    const composerData = {
      allComposers: [
        {
          composerId: 'cursor-comp-1',
          name: 'Fix auth bug',
          createdAt: 1730000000000,
          lastUpdatedAt: 1730000010000,
          workspaceUri: 'file:///home/user/my-project',
          conversation: [
            {
              bubbleId: 'user-bubble-1',
              type: 'user',
              text: 'Can you refactor this method?',
            },
            {
              bubbleId: 'ai-bubble-1',
              type: 'ai',
              modelType: 'claude-3-5-sonnet',
              createdAt: 1730000005000,
              tokenCount: {
                inputTokens: 1800,
                outputTokens: 450,
                cacheReadTokens: 600,
              },
            },
          ],
        },
      ],
    };

    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'composer.composerData',
      JSON.stringify(composerData)
    );
    db.close();

    const result = cursor.read(dbPath, { offset: 0, state: {} });
    assert.equal(result.errors, 0);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].id, 'cursor-comp-1');
    assert.equal(result.sessions[0].cwd, '/home/user/my-project');

    assert.equal(result.events.length, 1);
    const ev = result.events[0];
    assert.equal(ev.agent, 'cursor');
    assert.equal(ev.sessionId, 'cursor-comp-1');
    assert.equal(ev.model, 'claude-3-5-sonnet');
    assert.equal(ev.input, 1800);
    assert.equal(ev.output, 450);
    assert.equal(ev.cacheRead, 600);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
