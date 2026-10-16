import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, upsertRecommendations } from '../src/db.ts';
import { startServer } from '../src/server.ts';
import type { Recommendation } from '../src/types.ts';

test('Reports and Tracking API endpoints work correctly', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-api-report-test-'));
  const origHome = process.env.AGENTLENS_SOURCE_HOME;
  process.env.AGENTLENS_SOURCE_HOME = tmp;

  const db = openDb(':memory:');
  const rec: Recommendation = {
    id: 'r_test_1',
    findingRule: 'context_growth',
    projectId: null,
    action: 'improve',
    title: 'Compact context',
    body: 'Run /compact',
    status: 'open',
    score: 90,
  };
  upsertRecommendations(db, [rec]);

  const server = await startServer(db, 0);
  const addr = server.address() as any;
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. GET /api/reports when empty
    const listRes1 = await fetch(`${base}/api/reports`);
    assert.equal(listRes1.status, 200);
    const listData1 = (await listRes1.json()) as any;
    assert.ok(Array.isArray(listData1.reports));

    // 2. POST /api/reports/generate
    const genRes = await fetch(`${base}/api/reports/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week: '2026-W42' }),
    });
    assert.equal(genRes.status, 200);
    const genData = (await genRes.json()) as any;
    assert.equal(genData.ok, true);
    assert.equal(genData.week, '2026-W42');

    // 3. GET /api/reports now contains 2026-W42
    const listRes2 = await fetch(`${base}/api/reports`);
    const listData2 = (await listRes2.json()) as any;
    assert.ok(listData2.reports.some((r: any) => r.week === '2026-W42'));

    // Modify the saved file on disk with a custom marker
    const savedMd = join(tmp, '.local/share/agentlens/reports/2026-W42.md');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(savedMd, '# Custom Historical Report Marker');

    // 4. GET /api/reports/2026-W42
    const repRes = await fetch(`${base}/api/reports/2026-W42`);
    assert.equal(repRes.status, 200);
    const repData = (await repRes.json()) as any;
    assert.equal(repData.data.week, '2026-W42');
    assert.ok(repData.data.summary != null, 'Report data must include summary');
    assert.equal(typeof repData.data.summary.totalTokens, 'number');
    assert.ok(repData.markdown.includes('# Custom Historical Report Marker'));
    assert.ok(repData.html.length > 0);

    // 5. POST /api/recommendations/:id/accept
    const accRes = await fetch(`${base}/api/recommendations/r_test_1/accept`, {
      method: 'POST',
    });
    assert.equal(accRes.status, 200);
    const accData = (await accRes.json()) as any;
    assert.equal(accData.ok, true);
    assert.equal(accData.status, 'accepted');
    assert.ok(accData.acceptedAt > 0);

    // 6. GET /api/tracking
    const trackRes = await fetch(`${base}/api/tracking`);
    assert.equal(trackRes.status, 200);
    const trackData = (await trackRes.json()) as any;
    assert.ok(Array.isArray(trackData.items));
    assert.ok(trackData.items.some((i: any) => i.id === 'r_test_1'));
  } finally {
    server.close();
    if (origHome) process.env.AGENTLENS_SOURCE_HOME = origHome;
    else delete process.env.AGENTLENS_SOURCE_HOME;
    rmSync(tmp, { recursive: true, force: true });
  }
});
