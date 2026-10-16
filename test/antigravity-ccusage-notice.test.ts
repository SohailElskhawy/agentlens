import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, upsertSessions } from '../src/db.ts';
import { checkHealth } from '../src/health.ts';
import { antigravity } from '../src/adapters/antigravity.ts';

test('antigravity adapter degrades gracefully when ccusage is missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-anti-missing-'));

  try {
    const dbPath = join(tmp, 'conversation_summaries.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        workspace_uris TEXT,
        last_modified_time TEXT,
        parent_conversation_id TEXT
      )
    `);
    db.prepare(`
      INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)
    `).run('conv-1', 'My Session', JSON.stringify(['file:///home/user/proj']), '2026-10-15T12:00:00Z', null);
    db.close();

    // Pass runner that returns null (ccusage not installed)
    const result = antigravity.read(dbPath, { offset: 0, state: {} }, () => null);
    assert.equal(result.errors, 0);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].id, 'conv-1');
    assert.equal(result.sessions[0].agent, 'antigravity');
    // Events empty because ccusage is missing
    assert.equal(result.events.length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkHealth flags warning and explains zero tokens when antigravity exists without ccusage', () => {
  const db = openDb(':memory:');
  upsertSessions(db, [{ id: 'sess-anti-1', agent: 'antigravity', cwd: '/my/proj', projectId: null }]);

  const report = checkHealth(db, () => null);
  assert.equal(report.ccusageAvailable, false);
  assert.equal(report.status, 'warning');
  assert.ok(report.warnings.some((w) => w.includes('ccusage binary not found') && w.includes('Antigravity')));
});
