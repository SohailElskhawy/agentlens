# agentlens — AI Agent Usage & Workflow Optimizer (Design)

Date: 2026-10-16 · Status: approved design, pre-plan

## 1. Purpose

A local-first, read-only Linux tool that analyzes how one developer uses Claude Code (Pro), Codex (Plus), Antigravity (Pro) and OpenCode (Go), in order to **save tokens, avoid hitting usage limits, and improve agent workflows** — globally and per project.

### Success criteria
- Hits usage limits less often, and can see *why* when it does (which project, session, pattern).
- Every recommendation shows evidence, confidence and estimated savings, and is later verified or refuted with measured data.
- The tool itself costs zero coding-agent tokens and negligible system resources.

### Non-goals
- Modifying any agent configuration, installing tools, or applying recommendations automatically.
- Calling any AI model (no LLM in the loop by default).
- Multi-user / team / cloud features.
- Semantic analysis of instruction prose.

## 2. Hard constraints

| Constraint | How it is met |
|---|---|
| Read-only | Agent files/DBs are only read (SQLite opened `mode=ro`). Only files the tool writes: its own DB, state, reports, and its systemd unit (via explicit `install-service`). |
| Privacy-first | Prompt and tool text are never stored — only SHA-256 hash + length. Opt-in `--store-excerpts` later. No network except opt-in `discover`. Dashboard binds `127.0.0.1`. |
| Zero agent allowance | No SessionStart hooks or injected context. Statusline output is not sent to the model. |
| Minimal resources | Incremental cursors, debounced `fs.watch`, niced backfill; target < 60 MB RSS, ~0% idle CPU. |
| Three distinct numbers | Measured tokens, estimated API-equivalent cost, actual quota % — always labeled separately; quota shows `n/a` when the agent doesn't report it, never a guess. |

## 3. Research summary

### Reused open-source projects

| Project | License | Lang | Use in agentlens |
|---|---|---|---|
| ccusage | MIT | Rust (npx) | Reference for parsing (Claude dedupe by `message.id+requestId`); optional external CLI for daily cross-check and Antigravity tokens (`ccusage <agent> daily --json`). |
| TraceRoost | MIT | TS | Ideas: hot files, loop patterns, plan-limit attribution, context growth. Not a dependency (its "Apply" edits instruction files → violates read-only). |
| Tokenomics | MIT | TS | Port waste heuristics (model fit, context management) as deterministic rules with attribution. |
| agent-audit | MIT | Python | Ideas for config audit checks. Not embedded. |
| mcp-tokens | Apache-2.0 | Rust | Optional external CLI for MCP tool-schema token cost (opt-in; it launches servers). |
| agent-observability | MIT | Go | Reference only. |

### Local data sources (verified on this machine)

| Agent | Source | Tokens | Actual quota |
|---|---|---|---|
| Claude Code | `~/.claude/projects/*/*.jsonl` (+ subagent/sidechain records) | per message, `cwd` | statusline stdin `rate_limits.five_hour/seven_day.used_percentage, resets_at` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `token_count.info.last_token_usage` per turn | `token_count.rate_limits.primary` (300 min) / `secondary` (10080 min) `used_percent`, `resets_at` |
| OpenCode | `~/.local/share/opencode/opencode.db`, table `message.data` JSON | `tokens{input,output,reasoning,cache{read,write}}`, `cost`, `path.cwd`, `modelID` | none (`n/a`) |
| Antigravity | `~/.gemini/antigravity{,-cli}/conversation_summaries.db` | none locally readable → ccusage if available | none (`n/a`) |

## 4. Architecture

Single Node process, single package, no build step.

- Runtime: Node ≥ 22, TypeScript via `--experimental-strip-types`.
- Built-ins: `node:sqlite`, `node:test`, `node:http`, `fs.watch`.
- Front end: vendored uPlot for charts.
- Target zero runtime npm dependencies.

```
src/
  cli.ts                 # agentlens serve|ingest|report|audit|status|statusline|discover|install-service|install-statusline
  db.ts                  # schema, migrations, queries
  ingest.ts              # watcher + cursor loop, dispatches to adapters
  project.ts             # cwd -> git root (worktree -> main repo), cached
  pricing.ts + prices.json
  adapters/{claude,codex,opencode,antigravity,ccusage}.ts
  analyze/<detector>.ts  # one file per detector -> Finding[]
  audit/<scanner>.ts     # config scanners -> Finding[]
  recommend.ts           # findings + catalog -> recommendations, lifecycle
  track.ts               # before/after evaluation with guardrails
  report.ts              # weekly md/html
  server.ts              # JSON API + static web/
web/                     # index.html, app.js, style.css, uplot (vendored)
catalog.yaml             # curated tools/MCPs/skills mapped to patterns
test/                    # node:test, fixture logs per adapter
```

### Adapter interface
```ts
interface Adapter {
  agent: 'claude' | 'codex' | 'opencode' | 'antigravity';
  discover(): string[];                              // files/DBs to read
  read(path: string, cursor: Cursor): { events: NormalizedEvent[]; sessions: SessionInfo[]; quotas: QuotaSnapshot[]; cursor: Cursor };
}
```
`Cursor` is a byte offset (JSONL) or a `time.created`/rowid high-water mark (SQLite). Partial trailing JSONL lines are left for the next read.

### Data model (SQLite at `~/.local/share/agentlens/agentlens.db`, WAL)
- `cursors(source, path PK, offset, updated_at)`
- `projects(id, root UNIQUE, name)`
- `sessions(id PK, agent, project_id, cwd, started_at, ended_at, parent_id, model_main)`
- `events(id, session_id, ts, kind[user|assistant|tool_call|tool_result|compact|error|hook], model, input, output, cache_read, cache_write, reasoning, tool, args_hash, result_bytes, is_error, text_hash, text_len)`, unique dedupe key per adapter
- `quota_snapshots(agent, ts, window[5h|7d], used_pct, resets_at, source)`
- `findings(id, rule, project_id, session_id, evidence JSON, confidence, confidence_reason, est_tokens_week, first_seen, last_seen)`
- `recommendations(id, finding_rule, project_id, action[add|remove|replace|improve], title, body, catalog_ref, status[open|accepted|measuring|verified|no_effect|regressed|dismissed], accepted_at, result JSON)`
- `audit_snapshots(ts, scope, item_type, item_key, content_hash, est_tokens)`: enables detecting config changes over time.

Prices: bundled `prices.json` (per model: input/output/cache_read/cache_write per MTok, `as_of`). Unknown models are shown with cost `unknown`, not zero.

### Data flow
1. On startup: each adapter's `discover()` runs; any path with an unchanged cursor is skipped. First backfill runs niced, in chunks, and commits after each file.
2. Steady state: `fs.watch` on source dirs fires a 2 s debounced re-read of the changed paths. A 60 s fallback poll catches missed events. OpenCode/Antigravity DBs are polled every 60 s.
3. After each ingest batch, the server:
   - rewrites `~/.local/state/agentlens/summary.json` (per-project today's tokens + latest quota), and
   - merges the statusline spool `claude-quota.jsonl` into `quota_snapshots`.
4. Detectors run incrementally on sessions touched since the last run. Audit runs hourly, and on demand.

### Error handling
- A malformed line/row is skipped and counted per source in `/api/health`. It never aborts the file.
- If an adapter throws, it is marked degraded in health and the others continue.
- Schema drift (unknown record types) is ignored. A version note is recorded for the health page.
- The ccusage cross-check flags drift > 5% per agent per day as a health warning.
- The DB uses WAL with a single writer (the service). CLI read commands open read-only.

## 5. Features

### 5.1 Unified dashboard
- Pages:
  - Overview: tokens/day stacked by agent, cost estimate, cache ratio, filter by agent/project/model/date range.
  - Projects.
  - Sessions, with drill-down to events: per-turn context-growth chart.
  - Quota: 5h/7d timelines, limit hits, burn-rate forecast, top consumers per window.
  - Findings & Recommendations.
  - Config Audit.
  - Reports.
  - Health.
- JSON API under `/api/*`, used by the web app and CLI.

### 5.2 Workflow detectors
Each detector is deterministic and emits findings with evidence (session/event ids), a confidence level with its reason, and `est_tokens_week`. Thresholds live in one constants file.

| Rule | Signal | Savings estimate |
|---|---|---|
| context_growth | per-turn input rises past threshold without compact | tokens above post-reset baseline |
| cache_miss | low cache_read ratio; idle gap > cache TTL then cold resend | uncached tokens × (1 − cached price ratio) |
| hot_files | same file read ≥ 3× in session, or across sessions in project | repeat read tokens |
| retry_loop | same tool+args_hash ≥ 3×, or error → identical retry | tokens of repeated calls |
| large_tool_output | result_bytes in top percentile (logs, whole files) | bytes/4 above median |
| repeated_prompt | same normalized prompt hash across sessions | suggests skill/command; savings = medium-confidence estimate |
| subagent_share | sidechain tokens vs parent and returned output | low confidence |
| model_fit | premium model on short low-output turns | price delta; medium/low confidence |
| handoff | same project, different agent within 30 min | first-N-turn tokens of the new session |
| quota_pressure | limit hits / > 80% windows, attributing sessions | n/a (diagnostic) |

### 5.3 Config audit (read-only)
Scans the following, all agents, global + per project:
- `~/.claude/` (CLAUDE.md, rules, skills, plugins, settings hooks), `~/.claude.json` (MCP)
- `~/.codex/` (config.toml MCP, AGENTS.md, skills, hooks.json)
- `~/.config/opencode/`
- `~/.gemini/`
- each known project's `.claude/`, `.mcp.json`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `docs/`

Checks:
- **Fixed overhead**: always-loaded instruction tokens (estimated as chars/4) plus SessionStart hook output measured from logs, × sessions/week.
- **Unused**: skills, MCP servers and plugins with zero invocations in 30 days. Invocations are counted from `Skill` tool calls and `mcp__<server>__*` calls.
- **Duplicates**: the same skill/MCP from multiple sources in one agent, or identical content hashes.
- **Conflicts** (low confidence, cheap cases only):
  - different package managers or test commands named across instruction files
  - multiple hooks on the same event matching the same tool
- **MCP schema cost**: estimated from readable tool definitions. Uses the `mcp-tokens` CLI only if installed and the user opts in.

### 5.4 Recommendations
- Findings + `catalog.yaml` matches become recommendations. Each one has:
  - action (add / remove / replace / improve)
  - copyable text or a user-run command
  - evidence links
  - confidence
  - `est_tokens_week` and the same savings expressed as % of a typical 5h window
- Ranking: savings × confidence weight.
- Simpler, deterministic fixes are ranked above adding tools.
- Recommendations are never auto-applied.
- `agentlens discover` (opt-in, off by default): weekly GitHub search with generic keywords only, never usage data. Results go into a "candidates" list kept separate from the curated catalog.

### 5.5 Weekly report
- **Schedule:** Monday 09:00 local, or on the first service run after a missed slot.
- **Output:** `~/.local/share/agentlens/reports/YYYY-Www.{md,html}`, plus an optional `notify-send`.
- **Sections:**
  1. Week-over-week trends per agent/project.
  2. Quota near-misses and limit hits.
  3. Biggest token-wasting patterns, with evidence.
  4. Recommendation status changes.
  5. Tool picks.
  6. **Top three actions**.
- **Scope:** a global report plus per-project sections.

### 5.6 Improvement tracking
- **Trigger:** the user marks a recommendation accepted (dashboard/CLI), or the audit detects the matching config change in `audit_snapshots`.
- **Comparison:** the 14 days before vs the 14 days after, on the targeted metric, normalized per session or per active hour. Scoped to the recommendation's project when it has one.
- **Quality guardrails** (all must not worsen beyond noise):
  - correction rate: interrupts, plus short user messages matching undo/wrong/revert heuristics, measured by hash/regex at ingest time; the text itself is not kept
  - tool error rate
  - turns per session
- **Result:** verified / no_effect / regressed, with the sample size. "Insufficient data" is reported until there are ≥ 5 sessions on each side.

### 5.7 Presence
- `agentlens install-service` writes `~/.config/systemd/user/agentlens.service` (`Nice=10`, `MemoryMax=200M`). The user then runs `systemctl --user enable --now agentlens`.
- `agentlens statusline`:
  - reads the Claude statusline JSON on stdin
  - appends `rate_limits` to the spool
  - prints `<project> · <tokens today> · 5h NN% · 7d NN%` from `summary.json`
  - never opens the DB, and must finish in < 50 ms of script work
- `agentlens install-statusline` prints the settings snippet; the user pastes it themselves.
- `agentlens status [--project .]`: terminal summary for the current project.

## 6. Testing
- `node:test` with small anonymized fixture logs per adapter, including edge cases:
  - duplicate Claude usage lines
  - partial trailing lines
  - cumulative vs last Codex token counts
  - OpenCode rows without tokens
- Detector tests run on synthetic event sequences.
- Golden test for the weekly report markdown on a fixture DB.
- Cross-check script: our daily totals vs `ccusage --json` on real local data (manual/CI-optional).

## 7. Milestones
1. **M1: Usage dashboard.**
   - Schema, Claude + Codex adapters, project resolution, pricing.
   - `serve` with watcher; Overview/Projects/Sessions pages; Codex quota page.
   - `install-service`.
2. **M2: All agents + quota.**
   - OpenCode + Antigravity adapters, ccusage cross-check, health page.
   - Statusline + Claude quota.
   - `status` CLI.
3. **M3: Workflow findings.** Detectors (5.2) + Findings/Recommendations page.
4. **M4: Config audit.** Scanners (5.3) + audit snapshots + Audit page.
5. **M5: Reports + tracking.** Weekly report (5.5) + improvement tracking (5.6).
6. **M6: Catalog + discovery + release.** `catalog.yaml`, `discover`, README, LICENSE (MIT), install docs.

## 8. Open risks
- Agent log formats change without notice. Mitigations: schema drift is tolerated, the health page reports it, and the ccusage cross-check catches silent breakage.
- Antigravity may expose no token data locally, in which case it stays session-level only.
- `node:sqlite` may still print an experimental warning on Node 22. Mitigation: suppress it via `--no-warnings=ExperimentalWarning` in the unit/bin.
