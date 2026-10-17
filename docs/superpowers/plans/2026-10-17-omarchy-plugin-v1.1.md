# Antigravity Native Telemetry & Omarchy Plugin v1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable native Antigravity token & tool-call ingestion from `~/.gemini/antigravity-cli/brain/*/transcript.jsonl` (eliminating the false `ccusage` warning when native transcripts exist), and upgrade `agentlens.bar-widget` to v1.1 with a 3-tab Vim-navigable panel (`Overview` · `Fix & Optimize` · `Trends & Budgets`), linear clock-pace tick marks on quota bars, active agent breakdown (including Antigravity), live 30m waste alerts, and interactive Fix/Optimize actions.

**Architecture:**
1. `src/adapters/antigravity.ts` discovers and incrementally parses `<antigravity-dir>/brain/*/.system_generated/logs/transcript.jsonl` (`USER_INPUT`, `PLANNER_RESPONSE` token counters, `tool_calls`, and `GENERIC` tool outputs) alongside `conversation_summaries.db`. `src/health.ts` and `web/app.js` suppress the `ccusage` notice whenever Antigravity token events are already ingested natively.
2. `writeSummary()` in `src/summary.ts` enriches `summary.json` with `byAgentToday`, `recommendations` (Top 5), `liveAlerts` (30m window), `daily7d`, `topModels`, and `projectList` (with `path` and weekly budgets).
3. `plugins/omarchy/agentlens.bar-widget/{manifest.json,Model.js,BarWidget.qml,Panel.qml}` implements v1.1.0: pace tick marks (`elapsedPct` vs `usedPct`), Cross-Agent Switch Advisor, Active Agents Today (Antigravity + Claude + Codex), Live Waste Alert badge & banner, Top 5 Recommendations carousel with Accept (`POST /api/recommendations/:id/accept`) + 1-Click Workspace Hygiene (`GET`/`POST /api/optimize`), 7d Trends/Models/Budgets tab, middle/right-click bar gestures, and Vim keys (`h`/`l`, `j`/`k`, `[`/`]`, `c`, `a`, `r`).

**Tech Stack:** TypeScript (Node.js >= 22.18, `node:sqlite`, `node:test`), QtQuick / QML (`Quickshell`, `Quickshell.Io`, `qs.Commons`, `qs.Ui`).

**Spec:** `docs/superpowers/specs/2026-10-17-omarchy-plugin-v1.1-design.md`

---

### Task 1: Native Antigravity Transcript Ingestion & `ccusage` Warning Fix

**Files:**
- Modify: `src/adapters/antigravity.ts`
- Modify: `src/prices.json`
- Modify: `src/health.ts`
- Modify: `web/app.js`
- Modify: `test/antigravity.test.ts`
- Modify: `test/antigravity-ccusage-notice.test.ts`

- [ ] **Step 1: Write failing tests in `test/antigravity.test.ts` and `test/antigravity-ccusage-notice.test.ts`**

Add tests verifying:
1. `antigravity.discover(root)` discovers both `conversation_summaries.db` and `antigravity-cli/brain/<conv-id>/.system_generated/logs/transcript.jsonl`.
2. `antigravity.read(transcriptPath, cursor)` parses `USER_INPUT`, `PLANNER_RESPONSE` (`input_tokens`, `output_tokens`, `cache_read_tokens`, `thinking`, `tool_calls`), and `GENERIC` tool result lines into `NormalizedEvent[]` with model read from `settings.json` (or default fallback), and supports incremental byte-offset cursors.
3. `checkHealth(db, () => null)` does NOT emit the `"ccusage binary not found"` warning when Antigravity already has ingested token events in `events`, while still emitting it if Antigravity sessions exist with 0 events.

- [ ] **Step 2: Run tests to verify failure (RED)**

Run: `node --no-warnings=ExperimentalWarning --test test/antigravity.test.ts test/antigravity-ccusage-notice.test.ts`

- [ ] **Step 3: Implement native transcript discovery & parsing in `src/adapters/antigravity.ts`, update `src/prices.json`, `src/health.ts`, and `web/app.js`**

- In `src/adapters/antigravity.ts`:
  - Discover `antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl` and `antigravity/brain/*/.system_generated/logs/transcript.jsonl`.
  - When `path.endsWith('.jsonl')`, parse `transcript.jsonl` via `readLines(path, cursor.offset, ...)`:
    - Extract `conversationId` from parent directories (`.../brain/<conversationId>/.system_generated/logs/transcript.jsonl`).
    - Read default model from `<antigravity-dir>/settings.json` (`model` field, fallback `'Gemini 4 Argon (High)'`).
    - Map `USER_INPUT` -> `kind: 'user'`, `PLANNER_RESPONSE` -> `kind: 'assistant'` (`input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`) + `kind: 'tool_call'` for each item in `tool_calls`, and `GENERIC` -> `kind: 'tool_result'` (`resultBytes`, `isError`, `textHash`, `textLen`).
    - Infer `cwd` from tool call arguments (`Cwd`, `AbsolutePath`, `TargetFile`) if present and emit session `{ id: conversationId, agent: 'antigravity', cwd }`.
- In `src/prices.json`:
  - Add pricing entries for `"Gemini 4 Argon (High)"`, `"Gemini 4 Argon"`, and `"gemini-3.8-flash-high"`.
- In `src/health.ts` & `web/app.js`:
  - Only warn about missing `ccusage` for Antigravity when Antigravity has 0 ingested events (`!events.some(e => e.agent === 'antigravity' && e.events > 0)`).

- [ ] **Step 4: Run tests to verify pass (GREEN) & commit**

Run: `node --no-warnings=ExperimentalWarning --test test/antigravity.test.ts test/antigravity-ccusage-notice.test.ts`

---

### Task 2: Enrich `writeSummary()` in `src/summary.ts` for v1.1 Telemetry

**Files:**
- Modify: `src/summary.ts`
- Modify: `test/statusline.test.ts`

- [ ] **Step 1: Write failing test in `test/statusline.test.ts`**

Add test `writeSummary includes v1.1 fields: byAgentToday, recommendations, liveAlerts, daily7d, topModels, and projectList`:
- Seed today's events across `claude` and `antigravity`, a recent finding (`lastSeen = now - 5 * 60_000`), multiple open recommendations, and a project with a weekly budget (`setProjectBudget`).
- Assert `summary.json` contains:
  - `byAgentToday` array with `antigravity` and `claude` entries (`tokens`, `cost`, `sessions`)
  - `recommendations` array (up to 5) with pre-generated `prompt`
  - `liveAlerts` array containing the recent finding
  - `daily7d` array with 7 calendar day buckets
  - `topModels` array with `inputTokens`, `outputTokens`, `cacheTokens`, `cost`
  - `projectList` array with `path`, `weeklyTokenBudget`, `weeklyTokensUsed`, `budgetUsedPct`

- [ ] **Step 2: Run test to verify failure (RED)**

Run: `node --no-warnings=ExperimentalWarning --test test/statusline.test.ts`

- [ ] **Step 3: Implement v1.1 fields in `src/summary.ts`**

Update `SummaryData` and `writeSummary(db, summaryPath)` to compute and serialize `byAgentToday`, `recommendations`, `liveAlerts`, `daily7d`, `topModels`, and `projectList`.

- [ ] **Step 4: Run test to verify pass (GREEN) & commit**

Run: `node --no-warnings=ExperimentalWarning --test test/statusline.test.ts`

---

### Task 3: Upgrade `Model.js`, `manifest.json`, `BarWidget.qml`, and `Panel.qml` to v1.1

**Files:**
- Modify: `plugins/omarchy/agentlens.bar-widget/manifest.json`
- Modify: `plugins/omarchy/agentlens.bar-widget/Model.js`
- Modify: `plugins/omarchy/agentlens.bar-widget/BarWidget.qml`
- Modify: `plugins/omarchy/agentlens.bar-widget/Panel.qml`
- Modify: `plugins/omarchy/agentlens.bar-widget/README.md`
- Modify: `test/omarchy-plugin-model.test.ts`

- [ ] **Step 1: Write failing tests in `test/omarchy-plugin-model.test.ts`**

Add tests verifying:
1. `Model.parseSummaryJson` computes `elapsedPct5h`, `paceDelta5h`, `elapsedPct7d`, `paceDelta7d` on `agentQuotas`, and computes `switchAdvice` when one agent's 5h quota is `>= 80%` and another's is `<= 50%`.
2. `Model.parseSummaryJson` parses `liveAlerts`, `recommendations` (with fallback to `[topRecommendation]`), `byAgentToday`, `daily7d` (with `barRatio`), `topModels` (with `barRatio`), and `projectList`.
3. `Model.formatBarLabel(state, pillMode)` formats `"full"`, `"compact"`, and `"cost"` modes and appends `· ⚠ N` when `liveAlerts` are active.

- [ ] **Step 2: Run test to verify failure (RED)**

Run: `node --no-warnings=ExperimentalWarning --test test/omarchy-plugin-model.test.ts`

- [ ] **Step 3: Implement v1.1 in `Model.js`, `manifest.json`, `BarWidget.qml`, `Panel.qml`, and `README.md`**

1. Update `manifest.json` to `version: "1.1.0"` and add `barWidget.defaults` + `barWidget.schema` (`pillMode`: `"full"` | `"compact"` | `"cost"`).
2. Update `Model.js` with pace math, `switchAdvice`, `liveAlerts`, `byAgentToday`, `recommendations`, `daily7d`, `topModels`, `projectList`, `cyclePillMode`, `acceptRecommendation`, `previewWorkspaceOptimize`, and `applyWorkspaceOptimize`.
3. Update `BarWidget.qml` with middle-click `pillMode` cycling, right-click dashboard launch, and `pillMode`-aware label binding.
4. Update `Panel.qml` with the 3-tab cockpit (`1 Overview`, `2 Fix & Optimize`, `3 Trends & Budgets`), Vim keys (`h`/`l`/`1`/`2`/`3`, `j`/`k`, `[`/`]`, `c`, `a`, `r`), pace tick marks on 5h/7d bars, Active Agents Today section (highlighting Antigravity, Claude, Codex), Live Waste Alert banner, Cross-Agent Switch Advisor, Top 5 Recommendations carousel + Accept button + 1-Click Workspace Hygiene card, and 7d Daily/Models/Budgets charts.

- [ ] **Step 4: Run test suite, re-ingest live data, reinstall plugin, and verify live shell**

Run:
1. `npm test && npm run typecheck`
2. `node --no-warnings=ExperimentalWarning src/cli.ts ingest`
3. `systemctl --user restart agentlens.service`
4. `node --no-warnings=ExperimentalWarning src/cli.ts plugin install --enable`
5. `omarchy-shell agentlens.bar-widget status`
