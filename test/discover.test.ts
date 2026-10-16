import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverGitHubCandidates,
  loadDiscoveredCandidates,
  saveDiscoveredCandidates,
  validateSearchQuery,
  type DiscoveredCandidate,
} from '../src/discover.ts';

test('validateSearchQuery blocks queries with potential private file paths or sensitive tokens', () => {
  assert.equal(validateSearchQuery('mcp server postgres'), true);
  assert.equal(validateSearchQuery('claude code skills'), true);
  assert.equal(validateSearchQuery('token tracker'), true);
  assert.equal(validateSearchQuery('token optimizer'), true);

  // Private path / credential leak
  assert.equal(validateSearchQuery('/home/user/project'), false);
  assert.equal(validateSearchQuery('C:\\Users\\dev'), false);
  assert.equal(validateSearchQuery('.env'), false);
  assert.equal(validateSearchQuery('bearer secret_token_123'), false);
  assert.equal(validateSearchQuery('sk-proj-1234567890abcdef'), false);
  assert.equal(validateSearchQuery('api_key 123'), false);
  assert.equal(validateSearchQuery('a'.repeat(80)), false); // Length > 60 cap
});

test('saveDiscoveredCandidates and loadDiscoveredCandidates round-trip cleanly and atomically', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-discover-test-'));
  try {
    const candidate: DiscoveredCandidate = {
      id: 'github:example/mcp-sample',
      name: 'mcp-sample',
      fullName: 'example/mcp-sample',
      description: 'A sample MCP server',
      url: 'https://github.com/example/mcp-sample',
      stars: 120,
      topics: ['mcp', 'modelcontextprotocol'],
      suggestedKind: 'mcp',
      relevanceRule: 'instruction_bloat',
      discoveredAt: 1_700_000_000_000,
    };

    saveDiscoveredCandidates([candidate], tmp);
    const loaded = loadDiscoveredCandidates(tmp);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 'github:example/mcp-sample');
    assert.equal(loaded[0].stars, 120);
    assert.equal(loaded[0].suggestedKind, 'mcp');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('discoverGitHubCandidates handles mock GitHub Search response and categorizes kinds', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('api.github.com/search/repositories')) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            items: [
              {
                id: 12345,
                name: 'fast-mcp-db',
                full_name: 'acme/fast-mcp-db',
                description: 'Fast Database MCP server for agents',
                html_url: 'https://github.com/acme/fast-mcp-db',
                stargazers_count: 350,
                topics: ['mcp-server', 'database'],
              },
            ],
          }),
          { status: 200, headers: { 'x-ratelimit-remaining': '55' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    }) as any;

    const res = await discoverGitHubCandidates({ query: 'mcp database', dryRun: true });
    assert.equal(res.candidates.length, 1);
    assert.equal(res.candidates[0].suggestedKind, 'mcp');
    assert.equal(res.candidates[0].stars, 350);
    assert.equal(res.rateLimitRemaining, 55);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('discoverGitHubCandidates handles rate limit 403 gracefully without throwing uncaught', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ message: 'API rate limit exceeded for ip' }),
        { status: 403, headers: { 'x-ratelimit-remaining': '0' } }
      );
    }) as any;

    await assert.rejects(
      async () => {
        await discoverGitHubCandidates({ query: 'mcp' });
      },
      /rate limit/i
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('discoverGitHubCandidates deduplicates against curated catalog entries', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          total_count: 2,
          items: [
            {
              id: 1,
              name: 'serena',
              full_name: 'orai-sh/serena',
              description: 'Already in curated catalog',
              html_url: 'https://github.com/orai-sh/serena',
              stargazers_count: 500,
              topics: ['mcp'],
            },
            {
              id: 2,
              name: 'brand-new-tool',
              full_name: 'acme/brand-new-tool',
              description: 'A new unvetted tool',
              html_url: 'https://github.com/acme/brand-new-tool',
              stargazers_count: 100,
              topics: ['mcp'],
            },
          ],
        }),
        { status: 200, headers: { 'x-ratelimit-remaining': '30' } }
      );
    }) as any;

    const res = await discoverGitHubCandidates({ dryRun: true });
    // serena is in catalog.json, so it must be filtered out! Only brand-new-tool remains
    assert.equal(res.candidates.length, 1);
    assert.equal(res.candidates[0].fullName, 'acme/brand-new-tool');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('discoverGitHubCandidates handles non-string query safely without TypeError', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 });
    }) as any;

    const res = await discoverGitHubCandidates({ query: 123 as any, dryRun: true });
    assert.ok(Array.isArray(res.candidates));
  } finally {
    globalThis.fetch = origFetch;
  }
});
