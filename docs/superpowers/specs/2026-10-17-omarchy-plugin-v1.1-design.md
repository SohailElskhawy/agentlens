# Omarchy Quattro Plugin v1.1 (`agentlens.bar-widget`) — Design Specification

**Date:** 2026-10-17  
**Status:** Draft for User Review  
**Plugin ID:** `agentlens.bar-widget`  
**Version:** `1.1.0`

---

## 1. Overview & Goals

Build on the v1.0 `agentlens.bar-widget` plugin to turn it from a passive status viewer into an interactive, multi-tab workflow cockpit inside Omarchy Quattro:

1. **Multi-Tab Panel (`Overview` · `Fix & Optimize` · `Trends & Budgets`) with Vim Ergonomics:**
   - **Overview Tab:** Multi-agent 5h/7d quota meters enhanced with **linear clock-pace tick marks** (`elapsedPct` vs `usedPct`), a **Cross-Agent Switch Advisor** when one agent is constrained (`>= 80%`) while another has headroom (`<= 50%`), **Live In-Flight Waste Alert** banner, and Today's Activity KPIs.
   - **Fix & Optimize Tab:** Interactive carousel across the **Top 5 Open Recommendations** (`[` / `]` or `<` / `>` buttons) with **Copy Fix Prompt (`c`)**, **Accept & Track 14d (`a`)** (`POST /api/recommendations/:id/accept`), plus a **1-Click Workspace Hygiene** card (`GET /api/optimize` preview & `POST /api/optimize` apply for `.claudeignore`/`.agentignore` and instruction trimming).
   - **Trends & Budgets Tab:** 7-day daily token bar chart (`daily7d`), top models breakdown (`topModels` with input/output/cache split), and **Per-Project Weekly Budget** progress bars (`projectBudgets`).
2. **Live In-Flight Waste Alert Banner & Bar Badge:**
   - Detect waste findings from active sessions in the last 30 minutes (`retry_loop`, `context_runaway`, `large_tool_dump`, `repetitive_reads`, etc.).
   - Surface a compact `⚠ N` indicator in the top-bar pill when an active alert is present, and display a high-visibility **Active Session Alert** card at the top of the panel.
3. **Keyboard & Mouse Ergonomics:**
   - **Vim Keys in `Panel.qml`:** `h`/`l` (or `1`/`2`/`3`) switch tabs, `j`/`k` scroll content, `[`/`]` cycle recommendations, `c` copy fix prompt, `a` accept recommendation, `r` refresh telemetry, `Esc` close panel.
   - **Mouse Shortcuts on `BarWidget.qml`:** Left-click toggles the panel; Middle-click cycles pill display mode (`full` ↔ `compact` ↔ `cost`); Right-click opens the web dashboard (`http://127.0.0.1:4711`).

---

## 2. Enriched `summary.json` Data Contract (`src/summary.ts`)

`writeSummary()` in [`src/summary.ts`](file:///home/sohail/sohal-dev/token-analyzer/src/summary.ts) remains backwards-compatible with v1.0 and adds five structured fields:

```typescript
export interface SummaryRecommendation {
  id: string;
  rule: string;
  title: string;
  action: string;
  priorityScore: number;
  estTokensSavedWeek: number;
  projectId: string | null;
  projectName: string | null;
  prompt: string;
}

export interface SummaryLiveAlert {
  id: string;
  rule: string;
  severity: string;
  title: string;
  detail: string;
  projectName: string | null;
  wastedTokens: number;
  detectedAt: number;
}

export interface SummaryDailyBucket {
  day: string;      // YYYY-MM-DD (local)
  tokens: number;
  cost: number;
}

export interface SummaryModelRow {
  model: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cost: number;
}

export interface SummaryProjectBudget {
  projectId: string;
  name: string;
  path: string;
  tokensToday: number;
  costToday: number;
  weeklyTokenBudget: number | null;
  weeklyTokensUsed: number;
  budgetUsedPct: number | null;
}
```

Added to `SummaryData`:
- `recommendations?: SummaryRecommendation[]` — Top 5 open recommendations ordered by `priority_score DESC` (`topRecommendation` remains set to `recommendations[0] ?? null`).
- `liveAlerts?: SummaryLiveAlert[]` — Up to 3 findings from sessions active within the last 30 minutes (`COALESCE(s.ended_at, s.started_at) >= now - 1_800_000`), ordered by `wasted_tokens DESC`.
- `daily7d?: SummaryDailyBucket[]` — Last 7 local calendar days (oldest to newest, ending today) with total tokens and estimated cost.
- `topModels?: SummaryModelRow[]` — Top 5 models over the last 7 days ranked by total tokens, with `inputTokens`, `outputTokens`, `cacheTokens`, and `cost`.
- `projectList?: SummaryProjectBudget[]` — Top 5 active projects enriched with their filesystem `path` and weekly budget progress (`weeklyTokenBudget`, `weeklyTokensUsed`, `budgetUsedPct`).

---

## 3. Pure JS Model Additions (`plugins/omarchy/agentlens.bar-widget/Model.js`)

`Model.parseSummaryJson(rawText, nowMs)` computes:
- **Linear Pace Metadata on `agentQuotas`:**
  - `usedPct5h`, `reset5h`, `elapsedPct5h`, `paceDelta5h` (`usedPct5h - elapsedPct5h`), where `elapsedPct5h = clamp(Math.round((1 - remainingMs / (5 * 3600 * 1000)) * 100), 0, 100)` when `resetsAt > nowMs`.
  - `usedPct7d`, `reset7d`, `elapsedPct7d`, `paceDelta7d` (`usedPct7d - elapsedPct7d`), where `elapsedPct7d = clamp(Math.round((1 - remainingMs / (7 * 86400 * 1000)) * 100), 0, 100)` when `resetsAt > nowMs`.
- **Cross-Agent Switch Advisor (`switchAdvice`):**
  - When an agent has `usedPct5h >= 80` and another agent has `usedPct5h >= 0 && usedPct5h <= 50`, produces `{ fromAgent, fromPct, toAgent, toPct, message: "Claude 5h at 100% — switch to Codex (12% used)" }`.
- **Live Alerts (`liveAlerts`):**
  - Parsed array of recent findings (`liveAlerts.length > 0` appends `· ⚠ N` to the full bar pill or triggers `warning` severity if currently `normal`).
- **Recommendations List (`recommendations`):**
  - Up to 5 recommendations (falling back to `[topRecommendation]` if only `topRecommendation` is present).
- **7-Day Daily Bars (`daily7d`) & Top Models (`topModels`) & Project Budgets (`projectList`):**
  - Normalized with `barRatio` (`0..1` relative to max day / max model) for instant QML rendering.
- **Interactive Loopback API Helpers (`Model.js`):**
  - `acceptRecommendation(recId, baseUrl, callback)` — `POST /api/recommendations/<id>/accept`
  - `previewWorkspaceOptimize(projectPath, baseUrl, callback)` — `GET /api/optimize?project=<encodeURIComponent(projectPath)>`
  - `applyWorkspaceOptimize(projectPath, baseUrl, callback)` — `POST /api/optimize` with `{"project": projectPath}`

---

## 4. UI & UX Architecture (`BarWidget.qml` & `Panel.qml`)

### 4.1 `BarWidget.qml`
- Supports `pillMode` property (`"full"` | `"compact"` | `"cost"`), configurable via `manifest.json` `barWidget.schema` (`pillMode`) or cycled live via **Middle-click**.
- **Right-click** opens `http://127.0.0.1:4711` via `xdg-open`.
- Displays `⚠ N` badge in the pill when `state.liveAlerts.length > 0`.

### 4.2 `Panel.qml` (3-Tab Cockpit + Vim Keybindings)
- **Top Navigation Strip:** 3 pill tabs (`1 Overview`, `2 Fix & Optimize`, `3 Trends & Budgets`) switchable via click, `h`/`l`, or `1`/`2`/`3`.
- **Tab 0 — `Overview`:**
  1. **Live In-Flight Waste Alert Card** (visible when `state.liveAlerts.length > 0`): Urgent border card showing the active rule, wasted tokens, and project name.
  2. **Cross-Agent Switch Advisor Banner** (visible when `state.switchAdvice !== null`): Highlights which agent has spare 5h headroom.
  3. **Quota Windows with Pace Tick Marks:** Each 5h and 7d bar renders a vertical pace marker tick at `elapsedPct%` and a right-aligned pace label (`+18% vs clock` or `on pace`).
  4. **Today's Activity KPIs:** Tokens Today, API Cost Today, Burn Velocity (`/h`).
- **Tab 1 — `Fix & Optimize`:**
  1. **Recommendations Carousel (`1 / N`):** `<` / `>` navigation buttons (`[` / `]` keys), rule badge, priority & `+X/wk` savings badge, full action guidance, **Copy Fix Prompt (`c`)** button, and **Accept & Track (`a`)** button (`POST /api/recommendations/:id/accept` with inline `"✓ Accepted (tracking 14d)"` confirmation).
  2. **1-Click Workspace Hygiene (`/api/optimize`):** Project selector chip (defaults to top active project with a valid `path`), **"Preview Hygiene"** / **"Apply Hygiene Fixes"** button showing `.claudeignore`/`.agentignore` additions, instruction line trims, and estimated tokens saved.
- **Tab 2 — `Trends & Budgets`:**
  1. **Tokens by Day (7d):** 7 rows with day label, proportional horizontal bar, token count, and cost (today bolded).
  2. **Top Models (7d):** Up to 5 models with proportional bar, total tokens, cost, and `in / out / cache` breakdown subtitle.
  3. **Project Weekly Budgets & Activity:** Top projects with today's tokens/cost and weekly budget progress bar when a budget is configured.

---

## 5. Testing Strategy

1. **`test/statusline.test.ts`:** Verify `writeSummary()` populates `recommendations` (up to 5), `liveAlerts` (filtered to recent 30m sessions), `daily7d` (7 buckets), `topModels` (with input/output/cache split), and `projectList` (with `path` and weekly budget fields).
2. **`test/omarchy-plugin-model.test.ts`:** Verify `Model.parseSummaryJson` computes `elapsedPct5h`/`paceDelta5h`, `switchAdvice`, `liveAlerts`, `recommendations`, `daily7d` `barRatio`, `topModels` `barRatio`, and `formatBarLabel` with `pillMode` (`"full"`, `"compact"`, `"cost"`) and live alert badge (`⚠ N`).
3. **Live Shell Verification:** Re-install via `agentlens plugin install --enable`, validate with `omarchy plugin validate`, and verify live IPC status via `omarchy-shell agentlens.bar-widget status`.
