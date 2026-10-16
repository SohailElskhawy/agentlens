import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { getCuratedCatalog } from './catalog.ts';
import { getPlatformPaths } from './paths.ts';

export interface DiscoveredCandidate {
  id: string; // e.g. "github:owner/repo"
  name: string;
  fullName: string;
  description: string;
  url: string;
  stars: number;
  topics: string[];
  suggestedKind: 'mcp' | 'skill' | 'plugin' | 'tool';
  relevanceRule?: string;
  discoveredAt: number;
}

export interface DiscoverOptions {
  query?: string;
  token?: string;
  dryRun?: boolean;
  limit?: number;
  home?: string;
}

export function validateSearchQuery(query: string): boolean {
  if (!query || typeof query !== 'string') return false;
  const trimmed = query.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return false;

  // Reject paths, credentials, tokens, URLs, environment files
  const forbidden = [
    '/',
    '\\',
    '.env',
    'bearer',
    'ghp_',
    'github_pat_',
    'sk-',
    'secret',
    'password',
    'api_key',
    'apikey',
    'http:',
    'https:',
  ];
  const lower = trimmed.toLowerCase();
  for (const f of forbidden) {
    if (lower.includes(f)) return false;
  }

  // Safe keyword characters only (alphanumerics, space, hyphen, underscore)
  return /^[a-zA-Z0-9_\-\s]+$/.test(trimmed);
}

function classifyKind(name: string, desc: string, topics: string[]): 'mcp' | 'skill' | 'plugin' | 'tool' {
  const all = `${name} ${desc} ${topics.join(' ')}`.toLowerCase();
  if (all.includes('mcp') || all.includes('modelcontextprotocol')) return 'mcp';
  if (all.includes('skill')) return 'skill';
  if (all.includes('plugin')) return 'plugin';
  return 'tool';
}

function inferRelevanceRule(name: string, desc: string, topics: string[]): string | undefined {
  const all = `${name} ${desc} ${topics.join(' ')}`.toLowerCase();
  if (all.includes('cache') || all.includes('caching')) return 'cache_miss';
  if (all.includes('token') || all.includes('cost') || all.includes('quota')) return 'quota_pressure';
  if (all.includes('schema') || all.includes('overhead')) return 'instruction_bloat';
  if (all.includes('search') || all.includes('pack') || all.includes('context')) return 'hot_files';
  if (all.includes('test') || all.includes('retry') || all.includes('audit')) return 'retry_loop';
  return undefined;
}

export function getCandidatesFilePath(customHome?: string): string {
  return getPlatformPaths(customHome).candidatesPath;
}

export function loadDiscoveredCandidates(customHome?: string): DiscoveredCandidate[] {
  const file = getCandidatesFilePath(customHome);
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveDiscoveredCandidates(candidates: DiscoveredCandidate[], customHome?: string): void {
  const file = getCandidatesFilePath(customHome);
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(candidates, null, 2), 'utf8');
  renameSync(tmp, file);
}

export async function discoverGitHubCandidates(options: DiscoverOptions = {}): Promise<{
  candidates: DiscoveredCandidate[];
  source: string;
  rateLimitRemaining?: number;
}> {
  const rawQuery = (typeof options.query === 'string' ? options.query.trim() : '') || 'modelcontextprotocol server';
  if (!validateSearchQuery(rawQuery)) {
    throw new Error(`Invalid or disallowed search query: "${rawQuery}". Query must be generic alphanumeric keywords under 60 characters with no paths or tokens.`);
  }

  const limit = Math.min(30, Math.max(1, options.limit || 10));
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(rawQuery)}&sort=stars&order=desc&per_page=${limit}`;

  const headers: Record<string, string> = {
    'User-Agent': 'agentlens',
    'Accept': 'application/vnd.github.v3+json',
  };

  const token = options.token || process.env.GITHUB_TOKEN;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, { headers });
  const remainingHeader = res.headers.get('x-ratelimit-remaining');
  const rateLimitRemaining = remainingHeader ? Number.parseInt(remainingHeader, 10) : undefined;

  if (res.status === 403 || res.status === 429) {
    throw new Error(
      `GitHub API rate limit exceeded (remaining: ${rateLimitRemaining ?? 0}). Set GITHUB_TOKEN environment variable for 5,000 requests/hour.`
    );
  }

  if (!res.ok) {
    throw new Error(`GitHub API search failed with HTTP ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as any;
  const items = Array.isArray(data.items) ? data.items : [];

  const curated = getCuratedCatalog();
  const curatedUrls = new Set(
    curated.map((c) => c.url.trim().toLowerCase().replace(/\/+$/, ''))
  );

  const candidates: DiscoveredCandidate[] = items
    .map((it: any): DiscoveredCandidate => {
      const name = it.name || '';
      const desc = it.description || '';
      const topics: string[] = Array.isArray(it.topics) ? it.topics : [];
      const itemUrl = it.html_url || `https://github.com/${it.full_name || name}`;

      return {
        id: `github:${it.full_name || it.name}`,
        name,
        fullName: it.full_name || name,
        description: desc,
        url: itemUrl,
        stars: it.stargazers_count || 0,
        topics,
        suggestedKind: classifyKind(name, desc, topics),
        relevanceRule: inferRelevanceRule(name, desc, topics),
        discoveredAt: Date.now(),
      };
    })
    .filter((c: DiscoveredCandidate) => {
      const normUrl = c.url.trim().toLowerCase().replace(/\/+$/, '');
      const altUrl = `https://github.com/${c.fullName.toLowerCase()}`.replace(/\/+$/, '');
      return !curatedUrls.has(normUrl) && !curatedUrls.has(altUrl);
    });

  if (!options.dryRun && candidates.length > 0) {
    const existing = loadDiscoveredCandidates(options.home);
    const existingMap = new Map(existing.map((c) => [c.id, c]));
    for (const c of candidates) {
      existingMap.set(c.id, c);
    }
    const merged = Array.from(existingMap.values());
    merged.sort((a, b) => b.stars - a.stars);
    saveDiscoveredCandidates(merged, options.home);
  }

  return {
    candidates,
    source: `GitHub Search (q="${rawQuery}")`,
    rateLimitRemaining,
  };
}
