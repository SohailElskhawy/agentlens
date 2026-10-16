# agentlens M2 — All Agents + Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend agentlens to support all four target AI coding agents (Claude Code, Codex, OpenCode, and Antigravity) with unified token and session ingestion, Claude statusline quota ingestion, an instant terminal `status` command, and a cross-check health monitor.

**Architecture:** 
- OpenCode adapter opens `~/.local/share/opencode/opencode.db` in read-only mode (`node:sqlite`) and extracts sessions, messages, and tool events using a high-water mark timestamp cursor.
- Antigravity adapter reads session titles, timestamps, and workspace URIs from `~/.gemini/antigravity{,-cli}/conversation_summaries.db`, and fetches token breakdowns through the optional `ccusage antigravity session --json` helper when installed.
- Claude statusline CLI command (`agentlens statusline`) consumes stdin from Claude Code, appends quota snapshots to a lightweight spool file (`claude-quota.jsonl`), and formats a live status bar from a cached `summary.json` without opening the SQLite DB.
- The ingest loop merges the statusline spool into `quota_snapshots`, updates `summary.json`, and exposes cross-check health verification in `/api/health` and the dashboard UI.
- `agentlens status [--project .]` prints a clean terminal summary of today's and 7-day usage, estimated cost, and active quota limits.

**Tech Stack:** Node ≥ 22.18 running `.ts` directly (type stripping), `node:sqlite`, `node:http`, `node:test`, `fs.watch`, vendored uPlot; dev-only `typescript` for `tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-10-16-agentlens-design.md` (Milestone 2).

## Global Constraints

- Node `>=22.18`, `"type": "module"`, `.ts` executed directly: **erasable TypeScript only**. No `enum`, `namespace`, or constructor parameter properties. Relative imports end in `.ts`. Type-only imports use `import type`.
- Zero runtime npm dependencies. Dev dependencies are only `typescript@5.9.3` and `@types/node@24.10.1`.
- Read-only toward agent data: never write under `~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.local/share/opencode`, or `~/.gemini`. All SQLite connections to agent databases must use `readOnly: true`.
- Prompt and tool text is never stored. Store only `sha256` truncated to 16 hex chars, plus the length.
- The dashboard binds `127.0.0.1` only and rejects foreign `Host` headers.
- UI labels, verbatim: `Tokens (measured)`, `API-equivalent cost (estimated)`, `Quota used (reported by agent)`. Missing quota shows `n/a`, never an estimate. Unpriced models show `unpriced`, never `$0.00`.
- Fast statusline requirement: `agentlens statusline` must complete in < 50ms without opening SQLite.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Concurrent access to OpenCode or Antigravity SQLite databases while the agent is running.** Must open with `readOnly: true` and survive active WAL checkpoints without locking errors. Pinned in Task 1.
2. **OpenCode message data missing token counts or malformed JSON.** Rows without tokens (user prompts, aborted turns) must still record sessions/events without throwing or corrupting cursor state. Pinned in Task 1.
3. **Antigravity environment where ccusage is missing or fails.** Antigravity sessions from `conversation_summaries.db` must still ingest properly, and the health status should report ccusage as optional/unavailable without crashing. Pinned in Task 2.
4. **Statusline spool concurrency and partial writes.** `claude-quota.jsonl` must be safely appended by the statusline and atomic-drained by the ingest loop without race conditions or lost quota snapshots. Pinned in Task 3.
5. **Cross-check drift between agentlens and ccusage.** If drift exceeds 5% on any agent/day, `/api/health` must report a clear warning, but not abort queries. Pinned in Task 5.

## File Structure

```
src/
  types.ts                  # Shared types (updated with adapter extensions and health/summary shapes)
  summary.ts                # summary.json state generator and statusline formatter
  adapters/
    claude.ts               # Existing Claude adapter
    codex.ts                # Existing Codex adapter
    opencode.ts             # NEW: OpenCode SQLite adapter (message + part tables)
    antigravity.ts          # NEW: Antigravity adapter (conversation_summaries.db + ccusage session)
  ingest.ts                 # Ingest runner (dispatches to all 4 adapters + drains quota spool + writes summary.json)
  queries.ts                # Read queries (expanded health & quota queries)
  cli.ts                    # Expanded CLI: status, statusline, install-statusline
  health.ts                 # NEW: ccusage cross-check and health evaluation logic
test/
  opencode.test.ts          # NEW: OpenCode adapter unit tests
  antigravity.test.ts       # NEW: Antigravity adapter unit tests
  statusline.test.ts        # NEW: statusline and summary spool tests
  health.test.ts            # NEW: cross-check and health endpoint tests
  cli-status.test.ts        # NEW: agentlens status CLI tests
web/
  app.js                    # UI updates for 4 agents, Claude quota, and health warnings
```

---

### Task 1: OpenCode Adapter

**Files:**
- Create: `src/adapters/opencode.ts`
- Test: `test/opencode.test.ts`
- Modify: `src/ingest.ts`

**Interfaces:**
- Consumes: `types.ts` (`Adapter`, `Cursor`, `ReadResult`, `NormalizedEvent`, `SessionInfo`), `hash` from `util.ts`.
- Produces: `export const opencode: Adapter`.
- Behavior:
  - `root(home: string)`: returns `join(home, '.local/share/opencode')`.
  - `discover(root: string)`: checks for `join(root, 'opencode.db')`. If it exists, returns `[join(root, 'opencode.db')]`.
  - `read(path: string, cursor: Cursor)`:
    - Opens SQLite database at `path` with `readOnly: true`.
    - Cursor state tracks `lastMessageTime: number` and `lastPartTime: number`.
    - Queries `session` table: `id, directory, parent_id`.
    - Queries `message` table where `time_created > lastMessageTime ORDER BY time_created ASC`.
      - Parses `data` JSON.
      - Extracts tokens: `tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read`, `tokens.cache.write`. Note: `input` in OpenCode is already uncached input.
      - Extracts `modelID`, `path.cwd`, `role`, `time.created`.
      - User prompts: emit `user` kind, text hash + text len.
      - Assistant turns: emit `assistant` kind with tokens, model.
    - Queries `part` table where `time_created > lastPartTime ORDER BY time_created ASC`.
      - For `json_extract(data, '$.type') = 'tool'`, extracts tool name, args hash, result bytes, is_error.
    - Updates cursor state with the highest seen `time_created` timestamps.

- [ ] **Step 1: Write the failing test**

`test/opencode.test.ts`:
Create tests covering:
1. Extracting session and assistant turns with tokens from SQLite fixtures.
2. Handling message rows with null or missing tokens safely.
3. Extracting tool calls and results from part rows.
4. Incremental cursor progression using `time_created`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/opencode.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/adapters/opencode.ts`**

Implement `opencode: Adapter` with safe SQLite read-only access, JSON parsing try/catch per row, error counter, and incremental cursors.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/opencode.ts test/opencode.test.ts
git commit -m "feat: OpenCode SQLite adapter for sessions, messages, and tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Antigravity Adapter

**Files:**
- Create: `src/adapters/antigravity.ts`
- Test: `test/antigravity.test.ts`
- Modify: `src/ingest.ts`

**Interfaces:**
- Consumes: `types.ts` (`Adapter`, `Cursor`, `ReadResult`, `NormalizedEvent`, `SessionInfo`).
- Produces: `export const antigravity: Adapter`.
- Behavior:
  - `root(home: string)`: returns `join(home, '.gemini')`.
  - `discover(root: string)`: returns existing conversation summary DBs, e.g. `join(root, 'antigravity-cli/conversation_summaries.db')` and `join(root, 'antigravity/conversation_summaries.db')`.
  - `read(path: string, cursor: Cursor)`:
    - Opens `conversation_summaries.db` with `readOnly: true`.
    - Queries `conversation_summaries` table for `conversation_id, title, workspace_uris, last_modified_time`.
    - Converts `workspace_uris` JSON (e.g. `["file:///path/to/project"]`) into local filesystem `cwd`.
    - Attempts to invoke `ccusage antigravity session --json` via `execFileSync` if available.
    - If ccusage succeeds, maps session tokens (`inputTokens`, `outputTokens`, `cacheReadTokens`, `modelsUsed`) to normalized events.
    - If ccusage is unavailable or fails, emits session records with title/cwd and 0 tokens so projects and sessions appear in the dashboard.
    - Cursor tracks `lastModified` timestamp.

- [ ] **Step 1: Write the failing test**

`test/antigravity.test.ts`:
Create tests covering:
1. Parsing `conversation_summaries.db` fixture into sessions with workspace root.
2. Integrating mock `ccusage` JSON output to assign tokens and models.
3. Graceful fallback when `ccusage` is not installed or fails (records sessions without crash).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/antigravity.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/adapters/antigravity.ts`**

Implement `antigravity: Adapter`.

- [ ] **Step 4: Register OpenCode and Antigravity in `src/ingest.ts`**

Update `ADAPTERS = [claude, codex, opencode, antigravity]` in `src/ingest.ts`. Note: adjust `statSync(path).size` check in `src/ingest.ts` to support SQLite files where WAL modifications change mtime/size.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/antigravity.ts src/ingest.ts test/antigravity.test.ts
git commit -m "feat: Antigravity adapter with conversation summaries and ccusage bridge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Claude Quota Spool, Summary Writer & Statusline

**Files:**
- Create: `src/summary.ts`
- Modify: `src/ingest.ts`
- Modify: `src/cli.ts`
- Test: `test/statusline.test.ts`

**Interfaces:**
- Produces:
  - `writeSummary(db: DB, targetPath: string): void`: writes `summary.json` containing today's tokens per project and latest quota percentages.
  - `formatStatusline(summaryPath: string, projectCwd: string): string`: reads `summary.json` in < 10ms and outputs `<project> · <tokens today> · 5h NN% · 7d NN%`.
  - `spoolQuota(spoolPath: string, stdinJson: string): void`: parses Claude stdin statusline payload for `rate_limits` and appends to `claude-quota.jsonl`.
  - `drainQuotaSpool(db: DB, spoolPath: string): void`: merges spooled quota records into `quota_snapshots` table and truncates spool.
- In `src/cli.ts`:
  - `agentlens statusline`: reads stdin, calls `spoolQuota`, outputs `formatStatusline`.
  - `agentlens install-statusline`: prints Claude Code settings snippet.
  - In `serve()`: calls `drainQuotaSpool` and `writeSummary` after each ingest batch.

- [ ] **Step 1: Write the failing test**

`test/statusline.test.ts`:
Create tests covering:
1. `spoolQuota` correctly parses Claude statusline JSON with `rate_limits` and appends valid JSONL.
2. `formatStatusline` quickly reads `summary.json` and formats current project status.
3. `drainQuotaSpool` merges spooled snapshots into SQLite and clears the spool file.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/statusline.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/summary.ts` and update `src/ingest.ts` & `src/cli.ts`**

Implement fast statusline parsing, atomic spooling, summary generation, and CLI subcommands.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/summary.ts src/ingest.ts src/cli.ts test/statusline.test.ts
git commit -m "feat: Claude statusline quota ingestion and live status bar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Terminal Status CLI (`agentlens status`)

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli-status.test.ts`

**Interfaces:**
- Produces: `agentlens status [--project <path>]`
- Behavior:
  - Connects to SQLite (in read-only mode).
  - Determines project root from `--project <path>` or `process.cwd()`.
  - Prints:
    - Active project name and root.
    - Today's tokens (measured) and estimated cost across agents.
    - 7-day tokens and estimated cost.
    - Active quota status for Claude and Codex (5h and 7d % with reset time).
    - Top models used.

- [ ] **Step 1: Write the failing test**

`test/cli-status.test.ts`:
Create tests verifying terminal output format for both specific project and global status.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/cli-status.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `agentlens status` command in `src/cli.ts`**

Implement formatted ASCII table / report for terminal display.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli-status.test.ts
git commit -m "feat: terminal status CLI command for project and quota overview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: ccusage Cross-Check & Health Page

**Files:**
- Create: `src/health.ts`
- Modify: `src/queries.ts`
- Modify: `src/server.ts`
- Modify: `web/app.js`
- Test: `test/health.test.ts`

**Interfaces:**
- Produces:
  - `checkHealth(db: DB, home: string): Promise<HealthReport>`
  - Exposes `/api/health` with:
    - Ingestion status per agent (files, bad lines, skipped lines, latest event).
    - ccusage cross-check results (daily token diff percentage; flags warnings if > 5%).
    - System health indicator (`healthy` | `warning` | `degraded`).
  - Web UI displays Health dashboard with status badges, drift warnings, and source stats.

- [ ] **Step 1: Write the failing test**

`test/health.test.ts`:
Create tests covering health query structure, drift detection, and warnings.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/health.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/health.ts` and wire into `src/queries.ts` & `src/server.ts`**

Implement health checks and update web UI in `web/app.js`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/health.ts src/queries.ts src/server.ts web/app.js test/health.test.ts
git commit -m "feat: ccusage cross-check and expanded health monitoring

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: UI Enhancements for All Agents & Final Verification

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `README.md`
- Test: `test/server.test.ts`

**Interfaces:**
- Updates UI:
  - Agent filter selector includes: All Agents, Claude Code, Codex, OpenCode, Antigravity.
  - Quota view displays both Claude (via statusline) and Codex timelines.
  - Session view badges differentiate all 4 agents.
- Verification:
  - Run full ingest on real data across all four agents.
  - Verify all 4 agents display in dashboard without errors.
  - Verify `npm test` and `npm run typecheck`.

- [ ] **Step 1: Update UI controls in `web/index.html` and `web/app.js`**

Add OpenCode and Antigravity styling, agent tags, and quota display.

- [ ] **Step 2: Update `README.md` to reflect M2 completion**

Document OpenCode, Antigravity, statusline setup, and `agentlens status`.

- [ ] **Step 3: Run full verification suite**

Run: `npm test && npm run typecheck`
Run real ingest and verify terminal status: `node src/cli.ts ingest && node src/cli.ts status`

- [ ] **Step 4: Commit**

```bash
git add web/ README.md
git commit -m "feat: complete M2 multi-agent dashboard, quota, and documentation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
