import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertProject, upsertAuditItems } from '../src/db.ts';
import { startServer } from '../src/server.ts';
import type { AuditItem } from '../src/types.ts';

test('GET /api/audit returns audit items and summary metrics', async () => {
  const db = openDb(':memory:');
  const projId = upsertProject(db, '/work/demo-repo', 'demo-repo');

  const items: AuditItem[] = [
    {
      id: 'inst:1',
      agent: 'claude',
      projectId: projId,
      kind: 'instruction',
      name: 'CLAUDE.md',
      sourcePath: '/work/demo-repo/CLAUDE.md',
      tokens: 1500,
      invocations30d: 0,
      lastInvoked: null,
      status: 'active',
      details: {},
      updatedAt: 1000,
    },
    {
      id: 'mcp:1',
      agent: 'claude',
      projectId: null,
      kind: 'mcp',
      name: 'unused_tool',
      sourcePath: '/home/user/.claude.json',
      tokens: 200,
      invocations30d: 0,
      lastInvoked: null,
      status: 'unused',
      details: {},
      updatedAt: 1000,
    },
    {
      id: 'skill:1',
      agent: 'codex',
      projectId: projId,
      kind: 'skill',
      name: 'active_skill',
      sourcePath: '/work/demo-repo/.codex/skills/test/SKILL.md',
      tokens: 100,
      invocations30d: 5,
      lastInvoked: 2000,
      status: 'active',
      details: {},
      updatedAt: 1000,
    },
    {
      id: 'skill:2',
      agent: 'claude',
      projectId: null,
      kind: 'skill',
      name: 'dup_skill',
      sourcePath: '/home/user/.claude/skills/dup/SKILL.md',
      tokens: 100,
      invocations30d: 0,
      lastInvoked: null,
      status: 'duplicate',
      details: {},
      updatedAt: 1000,
    },
  ];

  upsertAuditItems(db, items);

  const server = await startServer(db, 0);
  const addr = server.address() as any;
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Query all
    const res = await fetch(`${base}/api/audit`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as any;
    assert.equal(data.items.length, 4);
    assert.equal(data.summary.totalItems, 4);
    assert.equal(data.summary.unusedCount, 1);
    assert.equal(data.summary.duplicateCount, 1);
    assert.equal(data.summary.totalFixedTokens, 1500);

    // 2. Query filtered by project
    const projRes = await fetch(`${base}/api/audit?project=${projId}`);
    assert.equal(projRes.status, 200);
    const projData = (await projRes.json()) as any;
    assert.equal(projData.items.length, 2);
    assert.equal(projData.summary.totalItems, 2);

    // 3. Query filtered by status
    const unusedRes = await fetch(`${base}/api/audit?status=unused`);
    assert.equal(unusedRes.status, 200);
    const unusedData = (await unusedRes.json()) as any;
    assert.equal(unusedData.items.length, 1);
    assert.equal(unusedData.items[0].name, 'unused_tool');
  } finally {
    server.close();
  }
});
