# `agentlens.bar-widget` Omarchy Quattro Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, test, and install the `agentlens.bar-widget` Omarchy Quattro desktop plugin (`BarWidget.qml`, `Panel.qml`, `Model.js`, `manifest.json`), enrich `summary.json` with live cost/burn-rate/recommendation telemetry, and add `agentlens plugin` CLI lifecycle commands.

**Architecture:** `writeSummary()` in `src/summary.ts` atomically writes enriched telemetry (`costToday`, `burnRateTokensPerHour`, `activeSessions`, `topRecommendation`) to `~/.local/state/agentlens/summary.json`. In the Omarchy Quattro shell (`quickshell`), `BarWidget.qml` watches `summary.json` via `Quickshell.Io.FileView` + a 5-second reload timer, normalizes state through `Model.js`, renders a color-coded status pill (`WidgetButton`), and summons an anchored `KeyboardPanel` (`Panel.qml`) with multi-agent quota bars, daily telemetry cards, and one-click Fix Now prompt copy.

**Tech Stack:** TypeScript (Node.js >= 22.18, `node:sqlite`, `node:test`), QtQuick / QML (`Quickshell`, `Quickshell.Io`, `qs.Commons`, `qs.Ui`), Omarchy Quattro CLI (`omarchy plugin`, `omarchy-shell`).

**Spec:** `docs/superpowers/specs/2026-10-17-omarchy-plugin-design.md`

## Global Constraints

- Zero external npm runtime dependencies in `package.json`; use only Node.js built-ins.
- Plugin ID must be `"agentlens.bar-widget"` with `schemaVersion: 1` and `kinds: ["bar-widget"]`.
- `writeSummary()` and `formatStatusline()` must remain backward-compatible and complete in `< 10ms`.
- QML files must use real Omarchy Quattro `qs.Commons` (`Color`, `Style`, `Border`) and `qs.Ui` (`BarWidget`, `WidgetButton`, `Panel`, `KeyboardPanel`, `PanelKeyCatcher`, `PanelHero`, `PanelSectionHeader`, `PanelSeparator`, `BorderSurface`, `Button`) components so `omarchy plugin validate` and live shell loading succeed without errors.

## Review Focus

- Empty or missing `summary.json` (or malformed JSON string): `Model.parseSummaryJson("", Date.now())` must return `hasData: false`, `severity: "normal"`, `binding5hPct: -1`, and `Model.formatBarLabel` must return `"⚡ --"` without throwing.
- Quota window with expired `resetsAt` in the past (`resetsAt <= nowMs`): `Model.parseSummaryJson` must clamp the countdown to `"now"` rather than rendering negative minutes.
- Multi-agent tie-breaking when both `claude` and `codex` have 5h quotas: `Model.parseSummaryJson` must pick the higher `usedPct` as `binding5hPct`, and mark `severity: "danger"` when `binding5hPct >= 95` or when any 5h forecast has `willExhaustBeforeReset: true` within `<= 30` minutes.
- Database with open recommendations but no matching finding row: `writeSummary()` must still populate `topRecommendation` with `estTokensSavedWeek: 0` and a valid prompt from `generateFixPrompt()`.
- Non-Omarchy test environment (or custom `--dir` target): `installOmarchyPlugin({ targetDir, runShellCommands: false })` must copy and validate the plugin files cleanly without requiring the `omarchy-shell` daemon.

---

### Task 1: Enrich `writeSummary()` in `src/summary.ts`

**Files:**
- Modify: `src/summary.ts:9-28` and `src/summary.ts:119-180`
- Test: `test/statusline.test.ts`

**Interfaces:**
- Consumes: `generateFixPrompt(ctx: FixPromptContext): string` from `src/fix-prompts.ts`
- Produces:
  ```ts
  export interface SummaryRecommendation {
    id: string;
    rule: string;
    severity: 'high' | 'medium' | 'low';
    title: string;
    action: string;
    estTokensSavedWeek: number;
    projectId?: number;
    projectName: string;
    prompt: string;
  }

  export interface SummaryData {
    updatedAt: number;
    totals: {
      tokensToday: number;
      costToday: number;
      burnRateTokensPerHour: number;
      activeSessions: number;
    };
    projects: Record<string, ProjectSummary>;
    quotas: {
      claude?: { '5h'?: number; '7d'?: number };
      codex?: { '5h'?: number; '7d'?: number };
    };
    forecasts?: QuotaForecastResult[];
    statuslineForecast?: string;
    topRecommendation?: SummaryRecommendation | null;
  }
  ```

- [ ] **Step 1: Write the failing test in `test/statusline.test.ts`**

Append a test to `test/statusline.test.ts` that seeds today's events (with `model: 'claude-sonnet-4-6'`), a finding (`rule: 'hot_files'`, `estTokensWeek: 45000`), and an open recommendation (`score: 90`), calls `writeSummary(db, summaryPath)`, and asserts:
```ts
test('writeSummary includes costToday, burnRateTokensPerHour, activeSessions, and topRecommendation', () => {
  const dir = tmp();
  const summaryPath = join(dir, 'summary.json');
  const db = openDb(':memory:');
  const now = Date.now();

  const projId = upsertProject(db, '/work/alpha', 'alpha');
  upsertSessions(db, [{ id: 's-live', agent: 'claude', cwd: '/work/alpha', projectId: projId }]);
  upsertEvents(db, [
    {
      id: 'ev-1',
      agent: 'claude',
      sessionId: 's-live',
      ts: now - 5 * 60_000,
      kind: 'assistant',
      model: 'claude-sonnet-4-6',
      input: 10_000,
      output: 2_000,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.06,
    },
  ]);

  upsertFindings(db, [
    {
      id: 'f-1',
      rule: 'hot_files',
      projectId: projId,
      evidence: { file: 'src/db.ts' },
      confidence: 'high',
      estTokensWeek: 45000,
      firstSeen: now,
      lastSeen: now,
    },
  ]);
  upsertRecommendations(db, [
    {
      id: 'rec-1',
      findingRule: 'hot_files',
      projectId: projId,
      action: 'Document src/db.ts exports in CLAUDE.md',
      title: 'Hot file re-read: src/db.ts',
      body: 'Read 9 times across sessions',
      status: 'open',
      score: 95,
    },
  ]);

  writeSummary(db, summaryPath);
  const data = JSON.parse(readFileSync(summaryPath, 'utf8'));

  assert.equal(data.totals.tokensToday, 12_000);
  assert.ok(Math.abs(data.totals.costToday - 0.06) < 1e-6);
  assert.equal(data.totals.burnRateTokensPerHour, 12_000);
  assert.equal(data.totals.activeSessions, 1);
  assert.ok(data.topRecommendation);
  assert.equal(data.topRecommendation.id, 'rec-1');
  assert.equal(data.topRecommendation.rule, 'hot_files');
  assert.equal(data.topRecommendation.severity, 'high');
  assert.equal(data.topRecommendation.projectName, 'alpha');
  assert.equal(data.topRecommendation.estTokensSavedWeek, 45000);
  assert.match(data.topRecommendation.prompt, /src\/db\.ts/);
});
```
Also include a test case where a recommendation exists without a matching finding row (`estTokensSavedWeek` defaults to `0`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/statusline.test.ts`
Expected: FAIL (`data.totals.costToday` is `undefined`)

- [ ] **Step 3: Implement enriched `writeSummary()` in `src/summary.ts`**

Update `ProjectSummary`, `SummaryRecommendation`, `SummaryData`, and `writeSummary(db: DB, targetPath: string)` in `src/summary.ts`:
- Sum `coalesce(sum(e.cost), 0) AS cost` in the `startOfToday` query and accumulate `totalCostToday`.
- Query 60-minute token burn (`WHERE e.ts >= now - 3600_000`) for `burnRateTokensPerHour` and 15-minute active session count (`SELECT count(DISTINCT session_id) FROM events WHERE ts >= now - 900_000`) for `activeSessions`.
- Query the top open recommendation (`WHERE r.status = 'open' ORDER BY r.score DESC, r.id ASC LIMIT 1`), look up matching finding (`WHERE project_id IS ? AND rule = ? ORDER BY est_tokens_week DESC LIMIT 1`), map `score >= 80 ? 'high' : score >= 50 ? 'medium' : 'low'`, and build `prompt` via `generateFixPrompt()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/statusline.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/summary.ts test/statusline.test.ts
git commit -m "feat(summary): enrich summary.json with cost, burn velocity, and top recommendation"
```

---

### Task 2: Build `Model.js`, `manifest.json`, and SVG Assets for `agentlens.bar-widget`

**Files:**
- Create: `plugins/omarchy/agentlens.bar-widget/manifest.json`
- Create: `plugins/omarchy/agentlens.bar-widget/Model.js`
- Create: `plugins/omarchy/agentlens.bar-widget/assets/icon.svg`
- Test: `test/omarchy-plugin-model.test.ts`

**Interfaces:**
- Consumes: `SummaryData` JSON string from Task 1
- Produces (`plugins/omarchy/agentlens.bar-widget/Model.js`):
  - `formatTokens(n)` -> `string` (`"0"`, `"42.1k"`, `"193.1M"`)
  - `formatCost(usd)` -> `string` (`"$0.00"`, `"$0.06"`, `"$48.20"`)
  - `formatDurationMs(ms)` -> `string` (`"now"`, `"18m"`, `"1h 42m"`, `"2d 4h"`)
  - `parseSummaryJson(rawText, nowMs)` -> normalized state object
  - `formatBarLabel(state, options)` -> `string` (e.g. `"⚡ 68% (1h 42m) · 🔥 42.1k/h"` or `"⚡ --"`)
  - `formatTooltip(state)` -> `string`

- [ ] **Step 1: Write the failing test in `test/omarchy-plugin-model.test.ts`**

Create `test/omarchy-plugin-model.test.ts` covering:
1. Empty/invalid JSON returns `{ hasData: false, severity: 'normal', binding5hPct: -1 }` and `formatBarLabel` returns `"⚡ --"`.
2. Multi-agent `summary.json` with `claude` (`5h: 68%`) and `codex` (`5h: 96%`, expired `resetsAt <= nowMs`) selects `codex` `96%` as `binding5hPct`, clamps expired reset countdown to `"now"`, and sets `severity: 'danger'`.
3. Warning threshold (`80% <= binding5hPct < 95%`) and imminent exhaustion (`willExhaustBeforeReset: true` with `projectedExhaustionTs - nowMs <= 30 * 60_000` -> `severity: 'danger'`).
4. `formatBarLabel(state, { showCountdown: true, showBurnRate: true })` formats `"⚡ 68% (1h 42m) · 🔥 42.1k/h"` and omits burn rate when `burnRatePerHour === 0` or `showBurnRate === false`.
5. `manifest.json` conforms to Omarchy Quattro `schemaVersion: 1` (`id: "agentlens.bar-widget"`, `kinds: ["bar-widget"]`, `entryPoints.barWidget: "BarWidget.qml"`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/omarchy-plugin-model.test.ts`
Expected: FAIL (`Cannot find module '../plugins/omarchy/agentlens.bar-widget/Model.js'`)

- [ ] **Step 3: Create `manifest.json`, `assets/icon.svg`, and `Model.js`**

Write `plugins/omarchy/agentlens.bar-widget/manifest.json`, `plugins/omarchy/agentlens.bar-widget/assets/icon.svg`, and `plugins/omarchy/agentlens.bar-widget/Model.js` (using standard ES functions compatible with both QML `import "Model.js" as Model` and Node ESM import).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/omarchy-plugin-model.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/omarchy/agentlens.bar-widget/manifest.json plugins/omarchy/agentlens.bar-widget/Model.js plugins/omarchy/agentlens.bar-widget/assets/icon.svg test/omarchy-plugin-model.test.ts
git commit -m "feat(omarchy): add manifest.json, icon asset, and Model.js state parser"
```

---

### Task 3: Build `BarWidget.qml`, `Panel.qml`, `README.md`, and Update `OMARCHY_PLUGIN.md`

**Files:**
- Create: `plugins/omarchy/agentlens.bar-widget/BarWidget.qml`
- Create: `plugins/omarchy/agentlens.bar-widget/Panel.qml`
- Create: `plugins/omarchy/agentlens.bar-widget/README.md`
- Modify: `OMARCHY_PLUGIN.md`
- Test: `test/omarchy-plugin-model.test.ts`

**Interfaces:**
- Consumes: `Model.js` functions from Task 2, Omarchy shell `qs.Commons` and `qs.Ui` components
- Produces:
  - `BarWidget.qml`: `BarWidget` root with `moduleName: "agentlens.bar-widget"`, `FileView` watching `summary.json`, 5s `Timer`, `Loader` for `Panel.qml`, `IpcHandler` (`open`, `close`, `toggle`, `refresh`, `status`), and `WidgetButton`.
  - `Panel.qml`: `Panel` root with `KeyboardPanel`, `PanelKeyCatcher`, `Flickable`, `PanelHero`, `LIMITS & PACE` meters, `TODAY'S TELEMETRY` stat cards + top projects, `PRIORITY FIX` card with one-click clipboard copy (`wl-copy` / `xclip`), and footer buttons (`Open Dashboard`, `Refresh`).

- [ ] **Step 1: Add QML contract assertions to `test/omarchy-plugin-model.test.ts`**

Add a test verifying that `BarWidget.qml` and `Panel.qml` exist, import `qs.Commons` and `qs.Ui`, define `moduleName: "agentlens.bar-widget"`, expose the `IpcHandler` target `"agentlens.bar-widget"`, and do not reference non-existent pseudo-components (`BarButton`, `StatusBadge`, `StatBox`, `Divider`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/omarchy-plugin-model.test.ts`
Expected: FAIL (`BarWidget.qml` does not exist)

- [ ] **Step 3: Implement `BarWidget.qml`, `Panel.qml`, `README.md`, and sync `OMARCHY_PLUGIN.md`**

Create `plugins/omarchy/agentlens.bar-widget/BarWidget.qml`, `plugins/omarchy/agentlens.bar-widget/Panel.qml`, and `plugins/omarchy/agentlens.bar-widget/README.md`. Update `OMARCHY_PLUGIN.md` to reflect the real Omarchy Quattro QML implementation and `agentlens plugin` CLI workflow.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/omarchy-plugin-model.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/omarchy/agentlens.bar-widget/BarWidget.qml plugins/omarchy/agentlens.bar-widget/Panel.qml plugins/omarchy/agentlens.bar-widget/README.md OMARCHY_PLUGIN.md test/omarchy-plugin-model.test.ts
git commit -m "feat(omarchy): implement BarWidget.qml and Panel.qml for Omarchy Quattro"
```

---

### Task 4: Add `agentlens plugin` CLI Manager (`src/omarchy-plugin.ts`, `src/cli.ts`, `package.json`) and Verify Live in Omarchy

**Files:**
- Create: `src/omarchy-plugin.ts`
- Modify: `src/cli.ts`
- Modify: `package.json`
- Test: `test/omarchy-plugin-cli.test.ts`

**Interfaces:**
- Produces (`src/omarchy-plugin.ts`):
  ```ts
  export interface OmarchyPluginOptions {
    targetDir?: string; // defaults to ~/.config/omarchy/plugins
    shellConfigPath?: string; // defaults to ~/.config/omarchy/shell.json
    enable?: boolean;
    runShellCommands?: boolean;
  }

  export interface OmarchyPluginStatus {
    pluginId: string;
    sourceDir: string;
    installedDir: string;
    installed: boolean;
    manifestValid: boolean;
    enabledInShellConfig: boolean;
    omarchyCliAvailable: boolean;
  }

  export function getOmarchyPluginSourceDir(): string;
  export function getOmarchyPluginStatus(opts?: OmarchyPluginOptions): OmarchyPluginStatus;
  export function installOmarchyPlugin(opts?: OmarchyPluginOptions): OmarchyPluginStatus & { validationOutput?: string; enabled?: boolean };
  export function uninstallOmarchyPlugin(opts?: OmarchyPluginOptions): { removed: boolean; installedDir: string };
  ```
- CLI subcommands in `src/cli.ts`:
  - `agentlens plugin [install|status|uninstall] [--enable] [--dir <path>] [--json]`
- Include `"plugins"` in `package.json` `files` array so npm packages distribute the Omarchy plugin.

- [ ] **Step 1: Write the failing test in `test/omarchy-plugin-cli.test.ts`**

Create `test/omarchy-plugin-cli.test.ts` testing:
1. `installOmarchyPlugin({ targetDir, shellConfigPath, runShellCommands: false })` copies all plugin files (`manifest.json`, `BarWidget.qml`, `Panel.qml`, `Model.js`, `assets/icon.svg`, `README.md`) into `<targetDir>/agentlens.bar-widget` and reports `installed: true`, `manifestValid: true`.
2. `getOmarchyPluginStatus({ targetDir, shellConfigPath })` detects `enabledInShellConfig: true` when `shell.json` includes `{ "id": "agentlens.bar-widget" }` in `bar.layout.right`.
3. `uninstallOmarchyPlugin({ targetDir, runShellCommands: false })` removes `<targetDir>/agentlens.bar-widget` and subsequent `getOmarchyPluginStatus` returns `installed: false`.
4. If `/usr/share/omarchy/bin/omarchy` exists on the machine, run `omarchy plugin validate <targetDir>/agentlens.bar-widget` and assert exit code `0`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/omarchy-plugin-cli.test.ts`
Expected: FAIL (`Cannot find module '../src/omarchy-plugin.ts'`)

- [ ] **Step 3: Implement `src/omarchy-plugin.ts`, wire `plugin` command in `src/cli.ts`, and update `package.json`**

Implement `src/omarchy-plugin.ts`, add `plugin` subcommand and help text to `src/cli.ts`, and add `"plugins"` to `package.json` `files`.

- [ ] **Step 4: Run full test suite, typecheck, and live Omarchy plugin installation**

Run:
1. `npm test`
2. `npm run typecheck`
3. `node --no-warnings=ExperimentalWarning src/cli.ts ingest`
4. `node --no-warnings=ExperimentalWarning src/cli.ts plugin install --enable`
5. `omarchy plugin validate ~/.config/omarchy/plugins/agentlens.bar-widget`
6. `omarchy-shell agentlens.bar-widget status`
Expected: All tests pass, `tsc` exits 0, `omarchy plugin validate` outputs valid, and `omarchy-shell agentlens.bar-widget status` returns live JSON from the running Omarchy shell.

- [ ] **Step 5: Commit**

```bash
git add src/omarchy-plugin.ts src/cli.ts package.json test/omarchy-plugin-cli.test.ts
git commit -m "feat(cli): add agentlens plugin installer and Omarchy Quattro integration"
```
