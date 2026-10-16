import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { startServer } from '../src/server.ts';
import { saveDiscoveredCandidates } from '../src/discover.ts';

test('Catalog and Discovery API endpoints work correctly', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-api-discover-test-'));
  const origHome = process.env.AGENTLENS_SOURCE_HOME;
  process.env.AGENTLENS_SOURCE_HOME = tmp;

  const db = openDb(':memory:');
  const server = await startServer(db, 0);
  const addr = server.address() as any;
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. GET /api/catalog
    const catRes = await fetch(`${base}/api/catalog`);
    assert.equal(catRes.status, 200);
    const catData = (await catRes.json()) as any;
    assert.ok(Array.isArray(catData.catalog));
    assert.ok(catData.catalog.length >= 8);
    assert.ok(catData.catalog.some((i: any) => i.id === 'serena'));

    // 2. GET /api/candidates when empty
    const candRes1 = await fetch(`${base}/api/candidates`);
    assert.equal(candRes1.status, 200);
    const candData1 = (await candRes1.json()) as any;
    assert.ok(Array.isArray(candData1.candidates));
    assert.equal(candData1.candidates.length, 0);

    // Save a candidate to disk
    saveDiscoveredCandidates(
      [
        {
          id: 'github:foo/bar',
          name: 'bar',
          fullName: 'foo/bar',
          description: 'A mock tool',
          url: 'https://github.com/foo/bar',
          stars: 42,
          topics: ['mcp'],
          suggestedKind: 'mcp',
          discoveredAt: 1_700_000_000_000,
        },
      ],
      tmp
    );

    // 3. GET /api/candidates now returns the saved candidate
    const candRes2 = await fetch(`${base}/api/candidates`);
    assert.equal(candRes2.status, 200);
    const candData2 = (await candRes2.json()) as any;
    assert.equal(candData2.candidates.length, 1);
    assert.equal(candData2.candidates[0].id, 'github:foo/bar');

    // 4. POST /api/discover with mock fetch
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: any, opts: any) => {
        if (String(url).includes('api.github.com/search/repositories')) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              items: [
                {
                  id: 99,
                  name: 'live-tool',
                  full_name: 'test/live-tool',
                  description: 'Discovered tool',
                  html_url: 'https://github.com/test/live-tool',
                  stargazers_count: 88,
                  topics: ['mcp'],
                },
              ],
            }),
            { status: 200, headers: { 'x-ratelimit-remaining': '40' } }
          );
        }
        return origFetch(url, opts);
      }) as any;

      const discRes = await fetch(`${base}/api/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'mcp' }),
      });
      assert.equal(discRes.status, 200);
      const discData = (await discRes.json()) as any;
      assert.equal(discData.ok, true);
      assert.equal(discData.candidates.length, 1);
      assert.equal(discData.candidates[0].name, 'live-tool');

      // 5. POST /api/discover with payload > 16 KB returns 413
      const largePayload = JSON.stringify({ query: 'mcp', padding: 'x'.repeat(20_000) });
      const largeRes = await fetch(`${base}/api/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: largePayload,
      });
      assert.equal(largeRes.status, 413);
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    server.close();
    if (origHome) process.env.AGENTLENS_SOURCE_HOME = origHome;
    else delete process.env.AGENTLENS_SOURCE_HOME;
    rmSync(tmp, { recursive: true, force: true });
  }
});
