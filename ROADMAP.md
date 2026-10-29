# agentlens Feature Roadmap 🗺️

This document outlines upcoming feature proposals, architecture directions, and research ideas for **agentlens**, designed to make the tool increasingly proactive, intelligent, and native to developer workflows.

---

## 🧭 Core Architectural Guarantees (Non-Negotiable)

Every roadmap feature must strictly adhere to the project's foundational constraints:
1. **Zero Runtime npm Dependencies**: Built exclusively with Node.js ≥ 22.18 built-in modules (`node:sqlite`, `node:fs`, `node:path`, `node:child_process`, `node:http`, `node:crypto`). The web dashboard remains vanilla JavaScript and vendored uPlot.
2. **Local-First & Zero Telemetry**: Binds strictly to loopback (`127.0.0.1`). No cloud backends, phone-home telemetry, or external tracking. The only outbound paths are the opt-in AI analyst (off by default), which runs a user-installed agent CLI and sends only redacted data after exact-hash preview confirmation, and the opt-in GitHub discovery search, which sends only generic alphanumeric keyword queries (never local paths, project names, or token metrics).
3. **Privacy First (No Raw Prompt/Output Storage)**: Only cryptographically hashed identifiers (SHA-256) and byte lengths are stored. Raw user code and prompt content never persist to disk. AI payloads are redacted and shown in full preview before every send; only validated analysis results are cached, and the call log keeps metadata only.
4. **Explicit Opt-In for Agent Invocations**: Any mechanism that writes code or spawns agent CLIs must require explicit user opt-in, display confirmed command arguments, and operate exclusively via argument arrays (`execFile`/`spawn`). AI analysis additionally requires `ai_enabled`, a per-call confirmation of the exact previewed command hash, and a daily call cap.

---

## ⚡ Phase 1 — In-Flight Prevention & Real-Time Guardrails

*Transitioning agentlens from purely reactive post-mortem analysis to active in-flight waste interception.*

### 1.1 Lightweight Agentlens MCP Server (`agentlens mcp`)
- **Concept**: Provide a local MCP server over stdio that Claude Code, Codex, and Cursor can attach to via standard configuration.
- **Tools Provided**:
  - `check_context_health`: Returns current context token size, compaction recommendations, and active session burn rate.
  - `query_cached_file`: If an agent attempts to re-read a file already read 5+ times in the session (a `hot_file`), returns an excerpt or cache summary rather than dumping the full file into context again.
  - `preflight_tool_check`: Warns or limits when a command or tool call is about to output > 100KB of raw text (e.g. dumping entire database tables or unpaged logs).

### 1.2 Automated `.claudeignore` / `.cursorignore` Generator
- **Concept**: Analyze `large_tool_output` and `hot_files` detector logs to identify noisy directories and large files repeatedly read or searched by mistake.
- **Features**:
  - Detects recurring dumps from build artifacts (`dist/`, `.next/`, `build/`), lockfiles (`package-lock.json`, `pnpm-lock.yaml`), large test fixtures, or auto-generated code.
  - Dashboard & CLI command: `agentlens generate-ignore [--dry-run]` to preview and write clean ignore rules.

### 1.3 In-Flight Context Warning in Terminal (`statusline` extension)
- **Concept**: Enhance `agentlens statusline` to alert the user right in their terminal prompt before context runaway causes exponential token bills.
- **Behavior**:
  - When a session context reaches 120k tokens and turn-over-turn context growth exceeds 20k/turn, format statusline with a high-visibility indicator: `[COMPACT RECOMMENDED]`.

---

## 🧠 Phase 2 — Context & Instruction Engineering Automation

*Automating the maintenance of agent instruction files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) to minimize fixed turn-by-turn token overhead.*

### 2.1 Automated Architecture Cheat-Sheet Generator for `CLAUDE.md`
- **Concept**: For the top 5 `hot_files` identified in a repository, automatically extract exported symbols, interfaces, and primary function headers (using Node built-in parsing).
- **Output**: Generates a compact ~30-line architecture summary markdown block formatted for `CLAUDE.md` / `AGENTS.md`.
- **Benefit**: Prevents agents from needing to read 500-line core files on turn 1 of every new session.

### 2.2 Instruction Drift & Rule Staleness Watchdog
- **Concept**: Compare directives in `CLAUDE.md` against recent git commits and repository dependencies.
- **Examples**:
  - Flag when instructions say *"Run tests with jest"* but `package.json` migrated to `vitest`.
  - Flag when instructions reference deprecated paths, deleted configuration files, or obsolete branch naming conventions.
  - Surface as new audit findings in `src/audit/` with automated trimmer diffs.

### 2.3 Interactive Instruction Diff Stager (Web UI)
- **Concept**: Expand the Instruction Trimmer UI on the Audit page to allow line-by-line staging of cuts.
- **Features**:
  - Checkboxes next to individual duplicate lines, conflicting rules, and dead file references.
  - "Apply selected cuts" exports a customized copyable diff or sends a scoped prompt to the agent CLI via Task 2's runner.

---

## 📊 Phase 3 — Task, Branch & Feature Attribution

*Connecting abstract token expenditure to real engineering outcomes and pull requests.*

### 3.1 Git Branch & Feature-Based Cost Attribution
- **Concept**: Group agent sessions not just by calendar day or raw project folder, but by active git branch and feature.
- **Metrics**:
  - Tokens and estimated cost per branch (e.g. `feature/auth-redesign`, `fix/login-bug`).
  - Total tokens required from branch creation to pull request merge.
  - Answers: *"How many tokens and agent turns did it take to build this specific feature?"*

### 3.2 Tool Failure & Shell Command Root-Cause Heatmap
- **Concept**: Deep index of all `tool_result` events where `is_error = 1` across sessions.
- **Features**:
  - Categorizes failing commands (e.g. failing test suites, TypeScript compiler errors, linter violations, missing CLI tools).
  - Surfaces top failure drivers: *"Running 'npm test' failed 42 times across 12 sessions, causing 350k tokens in retry loops."*
  - Recommends environment fixes (e.g. pre-installing dependencies or setting up test shortcuts).

### 3.3 Multi-Model Benchmark & Efficiency Matrix
- **Concept**: Compare performance across different models (Claude 3.7 Sonnet, Claude 3.5 Haiku, Opus, Codex, GPT-4.5, Gemini 2.5 Pro) on the user's actual codebase.
- **Metrics Tracked**:
  - Tokens consumed per git commit created.
  - Average turns to task completion.
  - Tool error rate and retry loop propensity by model tier.

---

## 💻 Phase 4 — Developer Terminal & IDE Native Experience

*Making agentlens ambient and effortless inside developers' daily editors and terminals.*

### 4.1 Native Terminal UI Mode (`agentlens tui`)
- **Concept**: A terminal dashboard running directly in a terminal window or tmux split-pane alongside agent sessions.
- **Design**:
  - Implemented with pure ANSI escape codes and terminal control sequences (zero external npm packages).
  - Live rolling token meters, 5h / 7d quota dials, active session turns, and real-time alerts.

### 4.2 IDE Status Bar & Sidebar Extension (VS Code / Cursor)
- **Concept**: Ambient status bar indicator, workspace Fix Now tree view, and in-editor instruction trimmer diff preview.
- **Specification Document**: See **[VSCODE_EXTENSION.md](VSCODE_EXTENSION.md)** for complete extension architecture, virtual diff provider, and manifest layout.

### 4.3 Omarchy Quattro Desktop Bar Widget & Details Panel
- **Concept**: Native desktop shell integration for the Omarchy Quattro desktop environment.
- **Specification Document**: See **[OMARCHY_PLUGIN.md](OMARCHY_PLUGIN.md)** for complete QML component implementations (`BarWidget.qml`, `Panel.qml`), manifest, and installation workflow.

### 4.4 Shell Prompt Modules (`starship` / `p10k`)
- **Concept**: Provide formatted output for custom prompt engines.
- **CLI**: `agentlens statusline --format starship` or `--format raw`.
- **Display**: e.g., `⚡ 82% 5h (2h 14m) | 14.2k tok/h` rendered directly in shell prompts.

---

## 🤖 Phase 5 — Multi-Agent Ecosystem Expansion

*Broadening support to new local and open-source coding agents.*

### 5.1 New Agent Adapters
- **Windsurf (Cascade)**: Ingest local Cascade conversation state, token counters, and tool history.
- **Cline & Roo Code**: Read task history and token logs from VS Code `globalStorage` databases.
- **GitHub Copilot CLI / Workspaces**: Ingest session state from local Copilot CLI logs.
- **OpenHands / Devin CLI**: Read workspace trace event logs.

### 5.2 Subagent Hierarchy & Swarm Visualizer
- **Concept**: For agents that spawn subagents (Antigravity, OpenCode, Claude subagents):
  - Visual tree of coordinator sessions and spawned child subagents.
  - Identify redundant token duplication where parent agents pass large duplicate contexts to child tasks.

---

## 🤝 Phase 6 — Team Collaboration & Repository Benchmarking (Zero Telemetry)

*Enabling teams to share agent optimization patterns without central servers or privacy leaks.*

### 6.1 Git-Backed Repository Optimization File (`.agentlens.json`)
- **Concept**: Store anonymized project configurations and optimization targets inside the repository.
- **Contents**:
  - Recommended `.claudeignore` rules.
  - Project weekly token budgets.
  - Key architectural summaries for `CLAUDE.md`.
- **Benefit**: Team members immediately inherit optimal agent guardrails upon cloning the repository.

### 6.2 Subscription Plan ROI & Value Calculator
- **Concept**: Provide clear subscription economic transparency.
- **Features**:
  - Compare theoretical API pay-as-you-go costs with fixed subscription pricing (e.g. $20/mo Pro vs $200/mo Team).
  - Calculates ROI multiplier: e.g. *"You consumed $520 worth of Claude API-equivalent tokens on your $20 Pro plan (26x ROI)."*
  - Recommends when upgrading to Team/Enterprise eliminates quota downtime based on burn rate forecasts.

---

## 📋 Implementation Priority Matrix

| Phase | Initiative | Value | Effort | Target |
|:---:|---|:---:|:---:|:---:|
| **1.2** | Auto `.claudeignore` / `.cursorignore` Generator | High | Low | Next Release |
| **3.1** | Git Branch & Feature-Based Cost Attribution | High | Low–Med | Next Release |
| **1.1** | Lightweight Agentlens MCP Server (Context Guard) | Very High | Medium | Milestone 2 |
| **2.1** | Architecture Cheat-Sheet Generator for `CLAUDE.md` | High | Medium | Milestone 2 |
| **4.1** | Native Terminal UI Mode (`agentlens tui`) | High | Medium | Milestone 2 |
| **3.2** | Tool Failure & Shell Command Root-Cause Heatmap | High | Medium | Milestone 3 |
| **5.1** | Windsurf & Cline Adapters | Med–High | Low–Med | Milestone 3 |
| **6.1** | Git-Backed `.agentlens.json` Repository Health Config | High | Low | Milestone 3 |
| **4.2** | IDE Status Bar Companion | Med | Low | Milestone 4 |
