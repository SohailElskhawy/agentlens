# agentlens M3 — Workflow Findings & Recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement deterministic workflow detectors that identify token-wasting patterns across all agents (retry loops, hot files, large tool outputs, runaway context growth, cache misses, repeated prompts, model misfit, agent handoffs, subagent bloat, quota pressure), generate prioritized actionable recommendations with confidence and savings estimates, and expose them via API and a dedicated Dashboard UI.

**Architecture:**
- Detectors in `src/analyze/` run deterministically against the normalized `events`, `sessions`, and `quota_snapshots` tables.
- Thresholds and constants are centralized in `src/analyze/constants.ts` with no magic numbers.
- `src/analyze/runner.ts` coordinates detector execution incrementally per session/project and upserts records into the `findings` table.
- `src/recommend.ts` synthesizes findings into prioritized `recommendations` with copyable actions, ranked by `estimated_tokens_week * confidence_weight`.
- REST endpoints (`/api/findings`, `/api/recommendations`, `/api/recommendations/:id/status`) and a rich UI page in `web/app.js` allow developers to inspect evidence, filter by project, and accept/dismiss recommendations.

**Tech Stack:** Node ≥ 22.18 running `.ts` directly (type stripping), `node:sqlite`, `node:http`, `node:test`, vendored uPlot; dev-only `typescript` for `tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-10-16-agentlens-design.md` (Milestone 3 & Section 5.2, 5.4).

## Global Constraints

- Node `>=22.18`, `"type": "module"`, `.ts` executed directly: **erasable TypeScript only**. No `enum`, `namespace`, or constructor parameter properties. Relative imports end in `.ts`. Type-only imports use `import type`.
- Zero runtime npm dependencies. Dev dependencies are only `typescript@5.9.3` and `@types/node@24.10.1`.
- Read-only toward agent data: never modify agent directories or files.
- Privacy-first: prompt and tool text are never stored — only SHA-256 hashes and lengths. Findings store structured metadata and IDs in `evidence`, never raw prompt text.
- Three distinct numbers strictly separated: `Tokens (measured)`, `API-equivalent cost (estimated)`, and `Quota used (reported by agent)`.
- UI labels, verbatim: `Tokens (measured)`, `API-equivalent cost (estimated)`, `Quota used (reported by agent)`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Zero-division and empty-session resilience.** Detectors running on empty sessions, sessions with zero tool calls, or zero duration must return empty findings without throwing. Pinned in Task 2 & Task 3.
2. **Incremental detector execution and idempotency.** Rerunning detectors across already-analyzed sessions must not duplicate findings or artificially inflate `est_tokens_week`. Pinned in Task 1 & Task 2.
3. **Evidence privacy.** Detector evidence JSON must never leak full prompt or tool output strings; it must reference event IDs, tool names, byte counts, and truncated hashes. Pinned in Task 2, 3, 4.
4. **Deterministic ranking and confidence scoring.** Recommendation ranking score must strictly follow `savings * confidence_weight` (high = 1.0, medium = 0.6, low = 0.3) with stable tie-breaking. Pinned in Task 5.
5. **UI state mutation safety.** Updating recommendation status (`accepted`, `dismissed`) via API must validate inputs and gracefully handle unknown IDs without database locking conflicts. Pinned in Task 5 & Task 6.

## File Structure

```
src/
  types.ts                  # Shared types (extended with Finding, Recommendation, Detector interfaces)
  db.ts                     # Database schema (findings, recommendations tables & queries)
  analyze/
    constants.ts            # Centralized detector thresholds and weights
    runner.ts               # Coordinates detector execution and findings persistence
    retry_loop.ts           # Detector: repeated identical tool calls and error retries
    hot_files.ts            # Detector: repeated reads of identical files
    large_tool_output.ts    # Detector: outlier massive tool outputs (logs, entire dumps)
    context_growth.ts       # Detector: runaway per-turn context accumulation
    cache_miss.ts           # Detector: cold cache resends after idle timeouts
    repeated_prompt.ts      # Detector: repeated prompt hashes across sessions
    model_fit.ts            # Detector: flagship models on trivial turns
    handoff.ts              # Detector: cross-agent switching on same project within 30m
    subagent_share.ts       # Detector: subagents with low return yield
    quota_pressure.ts       # Detector: quota exhaustion and near-misses (>80%)
  recommend.ts              # Maps findings to actionable recommendations with ranking
  server.ts                 # API routes: /api/findings, /api/recommendations, status update
test/
  findings-db.test.ts       # Database CRUD and indexes for findings and recommendations
  detectors-repetition.test.ts # Tests for retry_loop, hot_files, large_tool_output
  detectors-context.test.ts    # Tests for context_growth, cache_miss, repeated_prompt
  detectors-agents.test.ts     # Tests for model_fit, handoff, subagent_share, quota_pressure
  recommend.test.ts         # Tests for recommendation generation, ranking, and status lifecycle
  api-findings.test.ts      # Tests for HTTP API endpoints
web/
  app.js                    # UI page: Findings & Recommendations
  index.html                # Navigation link for Findings & Recommendations
```

---

### Task 1: Database Schema & Core Types for Findings and Recommendations

**Files:**
- Modify: `src/types.ts`
- Modify: `src/db.ts`
- Create: `src/analyze/constants.ts`
- Test: `test/findings-db.test.ts`

**Interfaces:**
- Consumes: `DB` from `src/db.ts`.
- Produces:
  - `Finding`: `{ id: string; rule: string; projectId: number | null; sessionId: string | null; evidence: any; confidence: 'high' | 'medium' | 'low'; confidenceReason: string; estTokensWeek: number; firstSeen: number; lastSeen: number }`
  - `Recommendation`: `{ id: string; findingRule: string; projectId: number | null; action: 'add' | 'remove' | 'replace' | 'improve'; title: string; body: string; catalogRef?: string; status: 'open' | 'accepted' | 'measuring' | 'verified' | 'no_effect' | 'regressed' | 'dismissed'; acceptedAt?: number; result?: any; score?: number }`
  - `upsertFindings(db: DB, findings: Finding[]): void`
  - `getFindings(db: DB, filter?: { projectId?: number; rule?: string }): Finding[]`
  - `upsertRecommendations(db: DB, recs: Recommendation[]): void`
  - `getRecommendations(db: DB, filter?: { projectId?: number; status?: string }): Recommendation[]`
  - `updateRecommendationStatus(db: DB, id: string, status: string): boolean`

- [ ] **Step 1: Write the failing test**

`test/findings-db.test.ts`:
Verify schema creation, upserting findings with conflict updates, retrieving findings by project, upserting recommendations, and updating recommendation status.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/findings-db.test.ts`
Expected: FAIL (missing tables and helper functions).

- [ ] **Step 3: Implement types, constants, and schema**

1. In `src/types.ts`, define `Finding`, `Recommendation`, `ConfidenceLevel`, and `ActionType`.
2. In `src/analyze/constants.ts`, define constants:
   - `RETRY_LOOP_THRESHOLD = 3`
   - `HOT_FILE_READ_THRESHOLD = 3`
   - `LARGE_TOOL_OUTPUT_BYTES = 50_000`
   - `CONTEXT_GROWTH_THRESHOLD = 100_000`
   - `CACHE_TTL_MS = 300_000` (5 minutes)
   - `HANDOFF_WINDOW_MS = 1_800_000` (30 minutes)
   - `CONFIDENCE_WEIGHTS = { high: 1.0, medium: 0.6, low: 0.3 }`
3. In `src/db.ts`, add `findings` and `recommendations` tables to `SCHEMA`, plus `upsertFindings`, `getFindings`, `upsertRecommendations`, `getRecommendations`, `updateRecommendationStatus`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/findings-db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/db.ts src/analyze/constants.ts test/findings-db.test.ts
git commit -m "feat: add schema and queries for findings and recommendations"
```

---

### Task 2: Repetition & Tool Outlier Detectors (`retry_loop`, `hot_files`, `large_tool_output`)

**Files:**
- Create: `src/analyze/retry_loop.ts`
- Create: `src/analyze/hot_files.ts`
- Create: `src/analyze/large_tool_output.ts`
- Create: `src/analyze/runner.ts`
- Test: `test/detectors-repetition.test.ts`

**Interfaces:**
- Detector signature: `(db: DB, sessionId?: string, projectId?: number) => Finding[]`
- `retry_loop`: Identifies sequences where the same `(tool, args_hash)` is called ≥ 3 times in a session or an error is immediately followed by an identical retry. Estimates wasted tokens = repeat turn tokens.
- `hot_files`: Identifies files read ≥ 3 times within a session or across sessions in the same project. Estimates wasted tokens = repeat read tokens.
- `large_tool_output`: Identifies tool execution events where `result_bytes > 50_000` (50KB). Estimates wasted tokens = `(result_bytes - 10_000) / 4`.

- [ ] **Step 1: Write the failing test**

`test/detectors-repetition.test.ts`:
Create synthetic session events:
1. 3 identical Bash or ReadFile calls in a session -> triggers `retry_loop` finding with high confidence.
2. 3 reads of the same file path -> triggers `hot_files` finding with repeat token savings.
3. Tool result with 120,000 bytes -> triggers `large_tool_output` finding.
4. Empty or normal single tool calls -> 0 findings.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/detectors-repetition.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement detectors and runner**

Implement `retry_loop.ts`, `hot_files.ts`, `large_tool_output.ts`, and `runner.ts`. Runner coordinates detectors, collects findings, and stores them in DB.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/detectors-repetition.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analyze/retry_loop.ts src/analyze/hot_files.ts src/analyze/large_tool_output.ts src/analyze/runner.ts test/detectors-repetition.test.ts
git commit -m "feat: add retry_loop, hot_files, and large_tool_output detectors"
```

---

### Task 3: Context & Cache Detectors (`context_growth`, `cache_miss`, `repeated_prompt`)

**Files:**
- Create: `src/analyze/context_growth.ts`
- Create: `src/analyze/cache_miss.ts`
- Create: `src/analyze/repeated_prompt.ts`
- Modify: `src/analyze/runner.ts`
- Test: `test/detectors-context.test.ts`

**Interfaces:**
- `context_growth`: Detects sessions where turn input tokens accumulate above 100,000 without compaction, or where context doubles every turn without prune. Estimates savings = tokens above reset baseline.
- `cache_miss`: Detects sessions with Claude/Codex turns where time gap between turns > 5 min, resulting in 0% `cache_read` and full re-ingestion of cached prompt. Estimates savings = `input * (1 - cache_read_discount)`.
- `repeated_prompt`: Detects identical user `text_hash` occurring across ≥ 3 distinct sessions in a 7-day window. Suggests custom skill or slash command.

- [ ] **Step 1: Write the failing test**

`test/detectors-context.test.ts`:
1. Session accumulating from 20k -> 80k -> 160k input tokens without compact -> triggers `context_growth`.
2. Session with 15-minute idle pause between turns causing cache write followed by 0 cache read -> triggers `cache_miss`.
3. 3 sessions starting with identical user prompt text_hash -> triggers `repeated_prompt`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/detectors-context.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement context & cache detectors**

Implement `context_growth.ts`, `cache_miss.ts`, `repeated_prompt.ts`, and register them in `runner.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/detectors-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analyze/context_growth.ts src/analyze/cache_miss.ts src/analyze/repeated_prompt.ts src/analyze/runner.ts test/detectors-context.test.ts
git commit -m "feat: add context_growth, cache_miss, and repeated_prompt detectors"
```

---

### Task 4: Agent Behavior Detectors (`model_fit`, `handoff`, `subagent_share`, `quota_pressure`)

**Files:**
- Create: `src/analyze/model_fit.ts`
- Create: `src/analyze/handoff.ts`
- Create: `src/analyze/subagent_share.ts`
- Create: `src/analyze/quota_pressure.ts`
- Modify: `src/analyze/runner.ts`
- Test: `test/detectors-agents.test.ts`

**Interfaces:**
- `model_fit`: Detects expensive tier models (e.g. `claude-3-opus`, `o3-mini`, `gpt-4o`) invoked for single-turn, low-output (< 100 tokens), simple queries where a lighter model (Sonnet / Haiku / Flash) would suffice.
- `handoff`: Detects when a developer switches from one agent (e.g. Claude Code) to another (e.g. Codex) in the same project within 30 minutes, incurring redundant cold-start repository scanning.
- `subagent_share`: Detects child/subagent sessions whose token consumption exceeded 50,000 tokens while returning < 500 tokens of output to the parent session.
- `quota_pressure`: Detects quota snapshots exceeding 80% or 100% limit hits within the last 7 days and attributes top consuming sessions in that window.

- [ ] **Step 1: Write the failing test**

`test/detectors-agents.test.ts`:
1. Single-turn session using Opus with 30 output tokens -> triggers `model_fit`.
2. Session on project A in Claude Code followed 10 minutes later by session on project A in Codex -> triggers `handoff`.
3. Subagent session consuming 80k input and 200 output -> triggers `subagent_share`.
4. Quota snapshot at 95% -> triggers `quota_pressure` attributing active sessions.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/detectors-agents.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement agent behavior detectors**

Implement `model_fit.ts`, `handoff.ts`, `subagent_share.ts`, `quota_pressure.ts`, and register them in `runner.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/detectors-agents.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analyze/model_fit.ts src/analyze/handoff.ts src/analyze/subagent_share.ts src/analyze/quota_pressure.ts src/analyze/runner.ts test/detectors-agents.test.ts
git commit -m "feat: add model_fit, handoff, subagent_share, and quota_pressure detectors"
```

---

### Task 5: Recommendations Engine & HTTP API Endpoints

**Files:**
- Create: `src/recommend.ts`
- Modify: `src/server.ts`
- Modify: `src/ingest.ts`
- Test: `test/recommend.test.ts`
- Test: `test/api-findings.test.ts`

**Interfaces:**
- `generateRecommendations(findings: Finding[]): Recommendation[]`:
  - Synthesizes findings into actionable recommendations.
  - Generates copyable commands (e.g. `/compact`, subagent rules, `.claudeignore` patterns, model overrides).
  - Assigns priority score: `score = estTokensWeek * CONFIDENCE_WEIGHTS[confidence]`.
- Server API routes:
  - `GET /api/findings`: returns `{ findings: Finding[], totalEstWeeklySavings: number }` with optional `?project=` and `?rule=` filters.
  - `GET /api/recommendations`: returns `{ recommendations: Recommendation[] }` sorted by `score DESC`.
  - `POST /api/recommendations/:id/status`: body `{ status: 'accepted' | 'dismissed' }`, returns `{ ok: true }`.
- Background ingest hook: In `src/ingest.ts`, after ingesting files, invoke `runDetectors(db)` and `upsertRecommendations(db, generateRecommendations(getFindings(db)))`.

- [ ] **Step 1: Write the failing tests**

`test/recommend.test.ts`:
Test mapping findings into recommendations, calculating weighted scores, and ranking highest impact recommendations first.

`test/api-findings.test.ts`:
Test HTTP endpoints `GET /api/findings`, `GET /api/recommendations`, and `POST /api/recommendations/:id/status`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --no-warnings=ExperimentalWarning --test test/recommend.test.ts test/api-findings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement recommendation engine and API endpoints**

Implement `src/recommend.ts`, add API routes to `src/server.ts`, and trigger detector run in `src/ingest.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --no-warnings=ExperimentalWarning --test test/recommend.test.ts test/api-findings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recommend.ts src/server.ts src/ingest.ts test/recommend.test.ts test/api-findings.test.ts
git commit -m "feat: recommendations engine and findings API endpoints"
```

---

### Task 6: Dashboard UI: Findings & Recommendations Page

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/style.css`

**Interfaces:**
- Navigation: Add `Recommendations` nav tab linking to `#/recommendations`.
- Summary Cards:
  - "Potential Weekly Savings" (e.g. `~14.2M tokens` / `~32% of 5h quota`)
  - "Active Recommendations" (count of open recommendations)
  - "Flagged Findings" (count of detected patterns)
- Recommendations Section:
  - Cards sorted by impact score.
  - Badges: Action (`ADD`, `REMOVE`, `REPLACE`, `IMPROVE`), Confidence (`High`, `Medium`, `Low`).
  - Clear rationale and copyable action button/snippet.
  - Status toggle buttons: `Accept`, `Dismiss`.
- Findings Drill-Down Section:
  - Table of all findings with Rule, Project, Sessions affected, Confidence reason, and estimated token waste.
  - Respects global project filter (`#f-project`).

- [ ] **Step 1: Add HTML navigation and styles**

In `web/index.html`, add `<a href="#/recommendations">Recommendations</a>` to the nav bar.
In `web/style.css`, add styling for recommendation cards, action badges, and copy snippets.

- [ ] **Step 2: Implement recommendationsPage in `web/app.js`**

Implement route `#/recommendations`, fetch `/api/recommendations` and `/api/findings`, and render summary cards, recommendation cards, and findings table. Add click handlers for Accept and Dismiss buttons.

- [ ] **Step 3: Verify syntax and live rendering**

Run: `node --check web/app.js && npm run typecheck && npm test`
Verify that `node src/cli.ts ingest` detects real findings on the user's data and prints clean status.

- [ ] **Step 4: Commit**

```bash
git add web/index.html web/app.js web/style.css
git commit -m "feat: add Findings & Recommendations page to dashboard"
```
