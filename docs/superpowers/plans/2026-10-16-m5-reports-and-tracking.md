# agentlens M5 — Reports & Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement automated Weekly Usage Reports (Spec 5.5) and Recommendation Improvement Tracking with quality guardrails (Spec 5.6), integrated into the CLI (`agentlens report`, `agentlens track`, `agentlens accept`), REST API (`/api/reports`, `/api/tracking`), background daemon schedule, and Dashboard UI.

**Architecture:**
- `src/track.ts`: Evaluates accepted recommendations by measuring targeted metrics (tokens/turn, cache ratio, error loops, fixed tokens) in the 14 days before vs 14 days after `accepted_at`, checking 3 quality guardrails (correction rate, tool error rate, turns/session), requiring ≥ 5 sessions per side, and setting status to `measuring` -> `verified` / `no_effect` / `regressed`.
- `src/report.ts`: Aggregates weekly metrics (Monday to Sunday ISO week), generates all 6 spec-defined sections (week-over-week trends, quota near-misses, top wasting patterns, recommendation status changes, tool picks, and top three actions), and renders both Markdown and standalone dark/light HTML to `~/.local/share/agentlens/reports/YYYY-Www.{md,html}`.
- `src/report-scheduler.ts`: Checks on startup and hourly in `serve` for Monday 09:00 trigger, generates missed reports, and triggers desktop `notify-send` if installed.
- REST API endpoints (`/api/reports`, `/api/reports/:week`, `/api/tracking`) and CLI commands (`agentlens report`, `agentlens track`, `agentlens accept`).
- Dashboard UI: New "Reports" page (`#reports`) and enhanced "Recommendations" page (`#recommendations`) with a "Tracked Improvements" section.

**Tech Stack:** Node ≥ 22.18, TypeScript (type-stripping only, zero npm runtime deps), SQLite (`node:sqlite`).

**Spec:** `docs/superpowers/specs/2026-10-16-agentlens-design.md` (Sections 5.5, 5.6, 7)

## Global Constraints

- Zero npm runtime dependencies.
- Read-only on agent data; only write to `~/.local/share/agentlens/`.
- Privacy-first: reports and tracking metrics contain only aggregated numbers, counts, hashes, and tool names; no raw prompts or code.
- Strict three-number separation: `Tokens (measured)`, `API-equivalent cost (estimated)`, `Quota used (reported by agent)`.
- Quality guardrails: correction rate, tool error rate, and turns/session must not worsen by > 10%.
- Sample size threshold: minimum 5 sessions before AND 5 sessions after `accepted_at` before declaring `verified`, `no_effect`, or `regressed`.

## Review Focus

1. **Date/Time Boundary Accuracy:** ISO week math across year boundaries (e.g. W52/W01) and timezone transitions must align Monday 00:00:00 to Sunday 23:59:59 consistently.
2. **Insufficient Data Handling:** Recommendations with fewer than 5 sessions before or after must remain in `measuring` state with clear "insufficient data" progress reporting.
3. **Guardrail Protection:** Even if token usage decreases, if tool errors or user correction rates increase by > 10%, a recommendation must not be marked `verified`.
4. **Idempotent Report Generation:** Generating a weekly report multiple times must overwrite the file cleanly without corrupting state or duplicating entries.
5. **Headless Linux Safety:** When running as a daemon or on a headless server without DBus or X11, desktop notification attempts (`notify-send`) must fail silently without throwing or blocking.

---

### Task 1: Improvement Tracking Engine (`src/track.ts`, `test/track.test.ts`)

**Files:**
- Create: `src/track.ts`
- Modify: `src/types.ts`
- Modify: `src/db.ts`
- Test: `test/track.test.ts`

**Interfaces:**
```typescript
export interface MetricBaseline {
  sessionCount: number;
  totalTokens: number;
  avgTokensPerSession: number;
  avgTokensPerTurn: number;
  toolErrorRate: number;     // error tool calls / total tool calls
  correctionRate: number;    // user messages with undo/wrong/revert / total user messages
  avgTurnsPerSession: number;
}

export interface TrackingResult {
  rule: string;
  acceptedAt: number;
  windowDays: number;
  sampleBefore: number;
  sampleAfter: number;
  metricName: string;
  baselineVal: number;
  currentVal: number;
  deltaPct: number;
  guardrails: {
    toolErrorRateDelta: number;
    correctionRateDelta: number;
    turnsPerSessionDelta: number;
    passed: boolean;
  };
  verdict: 'insufficient_data' | 'verified' | 'no_effect' | 'regressed';
}
```

- [ ] **Step 1: Write the failing test**

`test/track.test.ts`:
1. Create memory DB with sessions and events before and after a recommendation is accepted.
2. Verify `evaluateRecommendations`:
   - Case A: < 5 sessions -> returns `insufficient_data` and keeps status `measuring`.
   - Case B: ≥ 5 sessions with > 10% token reduction and healthy guardrails -> transitions to `verified`.
   - Case C: ≥ 5 sessions with no significant change (± 5%) -> transitions to `no_effect`.
   - Case D: ≥ 5 sessions with token reduction but tool error rate regression > +10% -> transitions to `regressed`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/track.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/track.ts`**

1. Define baseline calculation from sessions and events within `[acceptedAt - windowMs, acceptedAt)` and `[acceptedAt, min(now, acceptedAt + windowMs)]`.
2. Compute targeted metric according to `findingRule`:
   - `context_growth` / `instruction_bloat` -> `avgTokensPerTurn`
   - `retry_loop` / `hot_files` -> tool calls per session
   - `cache_miss` -> uncached token ratio
   - default -> `avgTokensPerSession`
3. Compute guardrails (tool error rate, user correction rate, turns per session). A guardrail passes if `currentVal <= baselineVal * 1.10`.
4. Verdict determination:
   - If `sampleBefore < 5 || sampleAfter < 5`: verdict = `insufficient_data`, status = `measuring`.
   - If not `guardrails.passed`: verdict = `regressed`, status = `regressed`.
   - If `deltaPct <= -10%`: verdict = `verified`, status = `verified`.
   - If `deltaPct >= +10%`: verdict = `regressed`, status = `regressed`.
   - Otherwise: verdict = `no_effect`, status = `no_effect`.
5. Persist updated status and `result` in `recommendations` table.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/track.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/db.ts src/track.ts test/track.test.ts
git commit -m "feat: add recommendation improvement tracking engine with quality guardrails"
```

---

### Task 2: Weekly Report Generator (`src/report.ts`, `test/report.test.ts`)

**Files:**
- Create: `src/report.ts`
- Test: `test/report.test.ts`

**Interfaces:**
```typescript
export interface WeeklyReportData {
  week: string; // e.g. "2026-W42"
  generatedAt: number;
  startDate: string;
  endDate: string;
  summary: {
    totalTokens: number;
    tokensDeltaPct: number;
    totalCost: number;
    costDeltaPct: number;
    activeSessions: number;
    sessionsDeltaPct: number;
  };
  byAgent: Array<{
    agent: string;
    tokens: number;
    cost: number;
    sessions: number;
    deltaPct: number;
  }>;
  byProject: Array<{
    name: string;
    tokens: number;
    cost: number;
    sessions: number;
    deltaPct: number;
  }>;
  quotaInsights: {
    fiveHourPeakPct: number;
    sevenDayPeakPct: number;
    limitHits: number;
    topConsumers: Array<{ sessionId: string; agent: string; tokens: number }>;
  };
  topWastePatterns: Array<{
    rule: string;
    count: number;
    estTokensWeek: number;
    description: string;
  }>;
  recommendations: {
    newOpen: number;
    accepted: number;
    verified: number;
    regressed: number;
  };
  topActions: Array<{
    title: string;
    action: string;
    actionSnippet?: string;
    estSavingsTokens: number;
  }>;
}

export function generateWeeklyReport(db: DB, weekStr?: string, home?: string): {
  data: WeeklyReportData;
  markdown: string;
  html: string;
  filePathMd: string;
  filePathHtml: string;
};
```

- [ ] **Step 1: Write the failing test**

`test/report.test.ts`:
1. Ingest fixture sessions and events for two consecutive weeks.
2. Call `generateWeeklyReport(db, weekStr, tmpHome)`.
3. Assert:
   - Week string format `YYYY-Www`.
   - Data summary calculates week-over-week deltas correctly.
   - Markdown includes all 6 required sections with headers.
   - HTML is valid, self-contained, and contains styles.
   - Files are written to `<home>/.local/share/agentlens/reports/`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/report.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/report.ts`**

1. Implement ISO week helper `getIsoWeekBounds(weekStr?: string): { week: string; startTs: number; endTs: number; prevStartTs: number; prevEndTs: number }`.
2. Query database for:
   - Current week vs previous week tokens, costs, and sessions (by agent and by project).
   - Quota snapshots within current week (peak %, limit hits).
   - Findings in current week grouped by rule with total `estTokensWeek`.
   - Recommendations status counts and top 3 actions ranked by `score`.
3. Format Markdown output adhering to GitHub-flavored markdown with summary tables and code snippets.
4. Format HTML output with clean inline CSS adopting agentlens theme (light and dark mode supported via `prefers-color-scheme`).
5. Ensure report directory `~/.local/share/agentlens/reports/` exists and write files atomically.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/report.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/report.ts test/report.test.ts
git commit -m "feat: implement weekly usage report generator with markdown and html renderers"
```

---

### Task 3: Scheduled Automation & Daemon Hookup (`src/report-scheduler.ts`, `src/ingest.ts`, `src/cli.ts`)

**Files:**
- Create: `src/report-scheduler.ts`
- Modify: `src/ingest.ts`
- Modify: `src/cli.ts`
- Test: `test/report-scheduler.test.ts`

**Interfaces:**
```typescript
export function checkWeeklyReportSchedule(db: DB, home: string, now?: number): { generated: boolean; week?: string; path?: string };
export function sendDesktopNotification(title: string, body: string): boolean;
```

- [ ] **Step 1: Write the failing test**

`test/report-scheduler.test.ts`:
1. Verify report schedule triggers if current time is past Monday 09:00 and previous week's report is missing.
2. Verify report schedule does not re-generate if report already exists for the week.
3. Verify `sendDesktopNotification` handles missing `notify-send` gracefully without throwing.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/report-scheduler.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/report-scheduler.ts` and integrate with ingest loop**

1. Implement `checkWeeklyReportSchedule`:
   - Checks if previous closed ISO week report exists in `~/.local/share/agentlens/reports/`.
   - If missing and current time >= Monday 09:00 local time, generates the report.
   - Calls `sendDesktopNotification` with summary if generated.
2. Implement `sendDesktopNotification`:
   - Uses `child_process.spawn('notify-send', ...)` detached with stdio ignored, catching errors silently.
3. In `src/ingest.ts` / `src/cli.ts`:
   - Trigger `evaluateRecommendations(db)` and `checkWeeklyReportSchedule(db, home)` periodically during the serve watcher cycle.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/report-scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/report-scheduler.ts src/ingest.ts test/report-scheduler.test.ts
git commit -m "feat: add weekly report scheduler and background tracking evaluation"
```

---

### Task 4: REST API & CLI Commands (`src/server.ts`, `src/cli.ts`, `test/api-report.test.ts`)

**Files:**
- Modify: `src/server.ts`
- Modify: `src/cli.ts`
- Test: `test/api-report.test.ts`

**Interfaces:**
- REST API:
  - `GET /api/reports`: list all generated reports `{ reports: Array<{ week: string; filePathMd: string; filePathHtml: string; generatedAt: number; totalTokens: number; totalCost: number }> }`.
  - `GET /api/reports/:week`: get report data and HTML `{ data, html, markdown }`.
  - `POST /api/reports/generate`: generate report on demand `{ ok: true, week, filePathMd, filePathHtml }`.
  - `GET /api/tracking`: list all measuring and evaluated recommendations with metrics and guardrails.
  - `POST /api/recommendations/:id/accept`: set status to `accepted` and initialize tracking.
- CLI:
  - `agentlens report [--week YYYY-Www] [--html] [--json] [--project <path>]`: prints or generates weekly report.
  - `agentlens track [--project <path>]`: prints terminal table of tracked improvements and verdicts.
  - `agentlens accept <id>`: marks a recommendation accepted.

- [ ] **Step 1: Write the failing test**

`test/api-report.test.ts`:
1. Start server with test DB.
2. Test `GET /api/reports` returns empty list, `POST /api/reports/generate` generates report, `GET /api/reports/:week` returns report.
3. Test `GET /api/tracking` returns tracking items.
4. Test `POST /api/recommendations/:id/accept` updates recommendation status.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/api-report.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement API endpoints and CLI commands**

1. In `src/server.ts`:
   - Add routes `/api/reports`, `/api/reports/:week`, `/api/reports/generate`, `/api/tracking`, and `/api/recommendations/:id/accept`.
2. In `src/cli.ts`:
   - Implement `agentlens report`: formats ANSI summary to stdout; supports `--html` (prints or opens path) and `--json`.
   - Implement `agentlens track`: prints ASCII table of recommendations, baseline vs current, delta %, and verdict.
   - Implement `agentlens accept <id>`: accepts recommendation and outputs confirmation.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/api-report.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/cli.ts test/api-report.test.ts
git commit -m "feat: add reports and tracking REST endpoints and CLI commands"
```

---

### Task 5: Dashboard UI: Reports Page & Tracked Improvements (`web/index.html`, `web/style.css`, `web/app.js`)

**Files:**
- Modify: `web/index.html`
- Modify: `web/style.css`
- Modify: `web/app.js`

- [ ] **Step 1: Implement Reports Page in `web/app.js` and `web/index.html`**

1. Add "Reports" link to navigation in `web/index.html`.
2. Implement `reportsPage()` in `web/app.js`:
   - Report selector dropdown (list of available weeks) + "Generate Report" button.
   - Summary tiles: Weekly Tokens, Weekly Estimated Cost, Active Sessions, Quota Peak.
   - Segmented view or iframe/HTML container to render report.
   - Tab / button to copy Markdown or download HTML.

- [ ] **Step 2: Implement Tracked Improvements in Recommendations Page**

1. On `recommendationsPage()`:
   - Add "Tracked Improvements" section at the top.
   - Display cards for recommendations with status `measuring`, `verified`, `no_effect`, or `regressed`.
   - Each card displays: Title, Target Metric, Baseline vs Current with Delta % badge (green for savings, red for regression), Guardrail status badges, Sample size progress (e.g. `Sessions: 8/5 before, 6/5 after`).
   - Open recommendations feature an "Accept & Track" button that calls `POST /api/recommendations/:id/accept` and transitions immediately.

- [ ] **Step 3: Verification**

1. Run syntax check: `node --check web/app.js`.
2. Run full test suite: `npm test && npm run typecheck`.
3. Test `agentlens report` and `agentlens track` on local database.

- [ ] **Step 4: Commit**

```bash
git add web/index.html web/style.css web/app.js
git commit -m "feat: add Reports page and Tracked Improvements view to web dashboard"
```

---

### Task 6: Milestone 5 Verification & Senior Code Review

- [x] **Step 1: End-to-end verification**

Run full test suite and verify all adapter, detector, audit, tracking, and report tests pass with zero warnings.

- [x] **Step 2: Dispatch Senior Code Review subagent**

Spawn a code review subagent to inspect the git diff against Milestone 5 plan and spec.
Resolve any identified issues. All findings addressed and verified in commit `14abeb7`.
