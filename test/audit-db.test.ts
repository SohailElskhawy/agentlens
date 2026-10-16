import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertProject, upsertAuditItems, getAuditItems } from '../src/db.ts';
import type { AuditItem } from '../src/types.ts';

test('upsertAuditItems and getAuditItems persist, update, and filter audit inventory', () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/work/test-repo', 'test-repo');

  const item1: AuditItem = {
    id: 'inst:claude:global:claude_md',
    agent: 'claude',
    projectId: null,
    kind: 'instruction',
    name: 'CLAUDE.md',
    sourcePath: '/home/user/.claude/CLAUDE.md',
    tokens: 1250,
    invocations30d: 0,
    lastInvoked: null,
    status: 'active',
    details: { chars: 5000 },
    updatedAt: 1000,
  };

  const item2: AuditItem = {
    id: `mcp:codex:proj:${projId}:serena`,
    agent: 'codex',
    projectId: projId,
    kind: 'mcp',
    name: 'serena',
    sourcePath: '/home/user/.codex/config.toml',
    tokens: 450,
    invocations30d: 14,
    lastInvoked: 2500,
    status: 'active',
    details: { command: 'start-mcp-server' },
    updatedAt: 1000,
  };

  const item3: AuditItem = {
    id: 'skill:opencode:global:old_skill',
    agent: 'opencode',
    projectId: null,
    kind: 'skill',
    name: 'old_skill',
    sourcePath: '/home/user/.config/opencode/skills/old_skill/SKILL.md',
    tokens: 300,
    invocations30d: 0,
    lastInvoked: null,
    status: 'unused',
    details: {},
    updatedAt: 1000,
  };

  upsertAuditItems(db, [item1, item2, item3]);

  // Retrieve all
  const all = getAuditItems(db);
  assert.equal(all.length, 3);

  // Filter by project
  const projItems = getAuditItems(db, { projectId: projId });
  assert.equal(projItems.length, 1);
  assert.equal(projItems[0].name, 'serena');
  assert.deepEqual(projItems[0].details, { command: 'start-mcp-server' });

  // Filter by kind
  const instructions = getAuditItems(db, { kind: 'instruction' });
  assert.equal(instructions.length, 1);
  assert.equal(instructions[0].id, 'inst:claude:global:claude_md');

  // Filter by status
  const unused = getAuditItems(db, { status: 'unused' });
  assert.equal(unused.length, 1);
  assert.equal(unused[0].name, 'old_skill');

  // On conflict: update tokens, invocations, and status
  const item2Updated: AuditItem = {
    ...item2,
    tokens: 500,
    invocations30d: 20,
    lastInvoked: 3500,
    status: 'active',
    updatedAt: 2000,
  };

  upsertAuditItems(db, [item2Updated]);
  const afterUpdate = getAuditItems(db, { projectId: projId });
  assert.equal(afterUpdate.length, 1);
  assert.equal(afterUpdate[0].tokens, 500);
  assert.equal(afterUpdate[0].invocations30d, 20);
  assert.equal(afterUpdate[0].lastInvoked, 3500);
  assert.equal(afterUpdate[0].updatedAt, 2000);
});
