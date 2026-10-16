# agentlens M6 — Catalog, Discovery & Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Curated Catalog (`catalog.yaml`), opt-in GitHub Discovery engine (`agentlens discover`), Catalog & Discovery Web Dashboard view, release-ready documentation (`README.md`, `LICENSE`), and final end-to-end release verification.

**Architecture:**
- `src/catalog.ts`: Loads and validates the curated catalog (`catalog.json` / `catalog.yaml`) containing vetted AI agent tools, MCPs, plugins, and skills mapped to waste detector rules. Enriches recommendations and report tool picks.
- `src/discover.ts`: Implements opt-in, privacy-preserving GitHub repository discovery using generic search queries (never leaking user code, prompts, or paths) with optional `GITHUB_TOKEN` support and local candidate persistence.
- `src/server.ts` & `src/cli.ts`: Exposes `agentlens discover [--query <terms>] [--json] [--dry-run]` and REST endpoints `GET /api/catalog`, `GET /api/candidates`, `POST /api/discover`.
- `web/app.js`: Adds a "Catalog & Discovery" navigation link and page to browse vetted tools by problem category, view potential savings, and explore candidate tools.
- `README.md` & `LICENSE`: Comprehensive public-facing open-source documentation and MIT license.

**Tech Stack:** Node.js (>= 22.18, type-stripping, zero runtime npm dependencies), TypeScript, SQLite (`node:sqlite`), Vanilla JS/CSS for dashboard.

**Spec:** `docs/superpowers/specs/2026-10-16-agentlens-design.md`

## Global Constraints
- Node.js >= 22.18 runtime; zero external runtime npm dependencies (`package.json` dependencies must remain empty).
- Privacy-first: Discovery queries MUST use only generic keyword terms; never transmit user prompt text, file paths, project names, or usage metrics over the network.
- Discovery must be strictly opt-in; no automatic external HTTP calls during ordinary ingestion, audit, or report generation.
- Read-only on agent directories and configurations; only agentlens data directory (`~/.local/share/agentlens/`) is writable.
- Distinguish measured token savings from estimated catalog potential.
- MIT License.

## Review Focus
1. **Network Isolation**: Ordinary runs (`agentlens status`, `agentlens serve`, `agentlens report`, `agentlens audit`) must make zero external network requests. Only explicit `agentlens discover` or UI "Discover Tools" trigger external requests.
2. **GitHub API Rate Limit Resilience**: `discover` must handle unauthenticated rate limit errors (HTTP 403 / 429) gracefully with clear instructions to provide `GITHUB_TOKEN` without throwing uncaught exceptions.
3. **Safe Search Query Filtering**: Ensure user-specified search terms are sanitized and generic defaults are safe.
4. **Catalog Schema Validation**: Corrupted or missing `catalog.yaml`/`catalog.json` must fail gracefully to built-in fallbacks without crashing server or recommendation generation.
5. **Zero Dependency Integrity**: Ensure all YAML/JSON loading and discovery helpers rely strictly on Node 22 built-in APIs (`node:fs`, `node:path`, `fetch`, etc.).

---

### Task 1: Curated Catalog Model & Loader (`catalog.json`, `catalog.yaml`, `src/catalog.ts`)

**Files:**
- Create: `catalog.json`
- Create: `catalog.yaml`
- Create: `src/catalog.ts`
- Modify: `src/types.ts`
- Modify: `src/recommend.ts`
- Modify: `src/report.ts`
- Test: `test/catalog.test.ts`

**Interfaces:**
```typescript
export interface CatalogItem {
  id: string;
  name: string;
  kind: 'mcp' | 'skill' | 'plugin' | 'tool';
  description: string;
  url: string;
  targetRules: string[];
  estSavingsPct: number;
  recommendedAction: ActionType;
  installCommand?: string;
  configSnippet?: string;
  safeToSuggest: boolean;
}

export function getCuratedCatalog(): CatalogItem[];
export function findCatalogItemsForRule(rule: string): CatalogItem[];
```

- [ ] **Step 1: Write the failing test**

`test/catalog.test.ts`:
1. Verify `getCuratedCatalog()` loads at least 10 vetted entries covering all major waste rules (`hot_files`, `context_growth`, `retry_loop`, `instruction_bloat`, `cache_miss`, `large_tool_output`, `model_fit`).
2. Verify `findCatalogItemsForRule('hot_files')` returns relevant items (e.g. repomix/files-to-prompt or targeted file readers).
3. Verify recommendation generation enriches recommendation with `catalogRef` and `actionSnippet` when a matching catalog item exists.
4. Verify weekly report Section 5 dynamically incorporates tool picks matching current waste patterns.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/catalog.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `catalog.json`, `catalog.yaml`, and `src/catalog.ts`**

1. Create `catalog.json` with vetted, high-quality open-source tools:
   - `mcp-tokens`: Schema token counter (for `instruction_bloat` / `mcp`).
   - `serena`: Semantic code navigation MCP (for `hot_files` / repetitive reads).
   - `context7`: Current library docs fetcher (for `retry_loop` / hallucinated APIs).
   - `repomix`: Codebase packing tool (for `large_tool_output` / `hot_files`).
   - `superpowers`: Structured skills framework (for `repeated_prompt` / workflow consistency).
   - `ccusage`: Usage and quota tracker (for `quota_pressure`).
   - And others matching key workflow waste patterns.
2. Create matching human-readable `catalog.yaml`.
3. Implement `src/catalog.ts` with embedded fallback and cached file loader.
4. Hook up `findCatalogItemsForRule` in `src/recommend.ts` to enrich recommendations.
5. In `src/report.ts`, enrich Section 5 with dynamic tool picks matching top waste patterns.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add catalog.json catalog.yaml src/catalog.ts src/types.ts src/recommend.ts src/report.ts test/catalog.test.ts
git commit -m "feat: implement curated catalog and recommendation enrichment"
```

---

### Task 2: Opt-In GitHub Discovery Engine (`src/discover.ts`)

**Files:**
- Create: `src/discover.ts`
- Test: `test/discover.test.ts`

**Interfaces:**
```typescript
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
}

export async function discoverGitHubCandidates(options?: DiscoverOptions): Promise<{
  candidates: DiscoveredCandidate[];
  source: string;
  rateLimitRemaining?: number;
}>;

export function loadDiscoveredCandidates(home?: string): DiscoveredCandidate[];
export function saveDiscoveredCandidates(candidates: DiscoveredCandidate[], home?: string): void;
```

- [ ] **Step 1: Write the failing test**

`test/discover.test.ts`:
1. Verify `discoverGitHubCandidates` rejects queries containing potential private data (paths like `/home/`, prompt markers, or URLs).
2. Verify candidate parsing accurately identifies tool kind (`mcp`, `skill`, etc.) from repository topics and descriptions.
3. Verify mocked GitHub API rate-limit 403/429 produces structured descriptive error without unhandled promise rejections.
4. Verify candidate persistence saves and loads cleanly from `~/.local/share/agentlens/discovery_candidates.json`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/discover.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/discover.ts`**

1. Define curated generic search queries for agent tools:
   - `"modelcontextprotocol server"`
   - `"claude code tool OR skill"`
   - `"ai agent workflow optimizer"`
2. Implement privacy validator: reject any custom query containing `/`, `\`, `.env`, tokens, or text > 60 chars.
3. Fetch GitHub Search API with standard `User-Agent: agentlens` and optional `Authorization: Bearer <GITHUB_TOKEN>`.
4. Parse items, map topics to candidate kinds (`mcp`, `skill`, `plugin`, `tool`), deduplicate against `catalog.json`.
5. Implement `loadDiscoveredCandidates` and `saveDiscoveredCandidates` with atomic write.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/discover.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/discover.ts test/discover.test.ts
git commit -m "feat: implement opt-in GitHub discovery engine with privacy protection"
```

---

### Task 3: REST API & CLI Integration (`src/server.ts`, `src/cli.ts`)

**Files:**
- Modify: `src/server.ts`
- Modify: `src/cli.ts`
- Test: `test/api-discover.test.ts`

**Endpoints & CLI:**
- CLI: `agentlens discover [--query <terms>] [--dry-run] [--json] [--token <tok>]`
- CLI: `agentlens catalog [--json] [--rule <rule>]`
- GET `/api/catalog` -> `{ catalog: CatalogItem[] }`
- GET `/api/candidates` -> `{ candidates: DiscoveredCandidate[] }`
- POST `/api/discover` -> `{ candidates: DiscoveredCandidate[], count: number }`

- [ ] **Step 1: Write the failing test**

`test/api-discover.test.ts`:
1. Test `GET /api/catalog` returns curated items with status 200.
2. Test `GET /api/candidates` returns candidate list.
3. Test `agentlens catalog` prints formatted ASCII table of curated tools.
4. Test `agentlens discover --dry-run` displays search plan without writing to disk.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/api-discover.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement API handlers and CLI commands**

1. In `src/server.ts`:
   - Add `/api/catalog` endpoint returning `getCuratedCatalog()`.
   - Add `/api/candidates` endpoint returning `loadDiscoveredCandidates()`.
   - Add `POST /api/discover` endpoint triggering discovery and persisting candidates.
2. In `src/cli.ts`:
   - Add `catalog` command with tabular output and `--json` support.
   - Add `discover` command with `--dry-run`, `--query`, `--token`, `--json`, and rate limit notices.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/api-discover.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/cli.ts test/api-discover.test.ts
git commit -m "feat: add catalog and discovery CLI commands and REST endpoints"
```

---

### Task 4: Web Dashboard Catalog & Discovery Page (`web/index.html`, `web/style.css`, `web/app.js`)

**Files:**
- Modify: `web/index.html`
- Modify: `web/style.css`
- Modify: `web/app.js`

**Features:**
- Add "Catalog" to navigation bar.
- Curated Catalog tab:
  - Filter by tool kind (`all`, `mcp`, `skill`, `plugin`, `tool`) and waste rule.
  - Cards displaying name, kind badge, description, potential savings %, target waste rules, and copyable install command.
- Discovery Candidates tab:
  - Discovered GitHub tools with stars, topics, and links.
  - "Discover New Tools" button triggering `POST /api/discover` with loading indicator.
  - Clear notice explaining privacy preservation and opt-in nature.

- [ ] **Step 1: Implement UI changes**

1. In `web/index.html`: add `<a href="#/catalog">Catalog</a>` to `<nav>`.
2. In `web/style.css`: add styles for catalog grid, candidate items, and discovery action bar.
3. In `web/app.js`: implement `catalogPage()` route with tabs for "Curated Tools" and "Discovered Candidates".

- [ ] **Step 2: Syntax and verification**

1. Verify JS syntax: `node --check web/app.js`.
2. Run full test suite: `npm test && npm run typecheck`.

- [ ] **Step 3: Commit**

```bash
git add web/index.html web/style.css web/app.js
git commit -m "feat: add Catalog and Tool Discovery page to web dashboard"
```

---

### Task 5: Documentation, Licensing & Release Packaging (`README.md`, `LICENSE`, `package.json`)

**Files:**
- Create: `LICENSE` (MIT)
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Create MIT License**
  Create `LICENSE` with standard MIT terms (2026, agentlens authors).

- [ ] **Step 2: Write comprehensive `README.md`**
  Cover:
  - Title, badges, and high-level description.
  - Key capabilities (Token Tracking, Quota Guard, Workflow Findings, Config Audit, Weekly Reports, Tracked Improvements, Curated Catalog & Discovery).
  - Supported agents (Claude Code, Codex, Antigravity, OpenCode).
  - Architecture diagram (Mermaid) showing log adapters, SQLite, analysis engine, daemon, and UI.
  - Quick Start guide (`git clone`, `npm start` / `bin/agentlens serve`).
  - Full CLI command reference table.
  - Claude Statusline integration guide.
  - Systemd background service setup (`agentlens install-service`).
  - Privacy & Security guarantees (strictly local, read-only on agent files, SHA-256 hashes only, 127.0.0.1 loopback bind).

- [ ] **Step 3: Commit**

```bash
git add LICENSE README.md package.json
git commit -m "docs: add MIT license, complete architecture documentation, and release README"
```

---

### Task 6: Milestone 6 Verification & Senior Code Review

- [ ] **Step 1: End-to-end test and validation**
  Run full test suite across all 6 milestones:
  `npm test && npm run typecheck && node --check web/app.js`

- [ ] **Step 2: Dispatch Senior Code Review subagent**
  Generate diff package and dispatch Senior Code Review subagent to verify Milestone 6 against spec and plan.
  Address all review findings before declaring final completion.
