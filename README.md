# agentlens 🔍

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen.svg)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)
[![Privacy First](https://img.shields.io/badge/privacy-local--first-orange.svg)](#privacy--security-guarantees)
[![Tests Passing](https://img.shields.io/badge/tests-191%20passing-success.svg)](test/)

**agentlens** is a lightweight, local-first, cross-platform usage and workflow optimizer for AI coding agents on Linux, macOS, and Windows:
- **Claude Code** (Pro)
- **Codex** (Plus)
- **OpenCode** (Go)
- **Antigravity** (Pro)
- **Gemini CLI**
- **Aider**
- **Cursor**

It monitors how you use AI coding agents to **save tokens, avoid hitting subscription usage limits, and eliminate repetitive agent workflows** — globally and per project.

![agentlens Overview Dashboard](assets/screenshots/overview.png)

---

## ⚡ Key Capabilities

* **Unified Usage Dashboard (Fluid & Responsive):** Fluid full-width 12-column responsive layout, dense KPI bar, side-by-side uPlot canvas charts, dark/light token design system, collapsible sidebar, and slide-over drawers.
* **"Fix Now" Project Action Runner:** Instant project fix panel ranking open recommendations by tokens saved, with one-click copyable prompts and opt-in "Send to agent" CLI dispatch (`claude`, `codex`, `opencode`) capturing live `git diff --stat`.
* **Quota Forecasting & Live Statusline:** Burn rate extrapolation projecting 5-hour and 7-day rate-limit exhaustion times before reset (< 10ms latency in statusline, CLI status, and dashboard top bar).
* **Live Desktop Alerts:** Proactive notifications during `serve` for active retry loops, quota exhaustion predicted within 30 minutes, or project budgets crossing 80%/100%.
* **Per-Project Weekly Budgets:** Configurable weekly token and cost targets per project with visual progress bars and weekly report integration.
* **Cross-Agent Quota Balancing:** Evaluates quota headroom across agents to recommend optimal agent switching.
* **14 Workflow Waste Detectors:** Deterministic detectors covering retry loops, repetitive file reads, context runaway, idle cache misses, large tool dumps, model mismatch, git outcome efficiency, abandoned sessions, compaction churn, and reasoning overuse.
* **Interactive Session Turn Timeline:** Per-turn stacked token charts (input, output, cache-read) with clickable detector event markers and finding slide-over views.
* **Instruction Trimmer:** Generates non-destructive unified diffs proposing cuts for duplicate lines, conflicting rules, oversized code blocks, and stale paths across `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`.
* **Configuration Audit:** Scans global and project instructions, MCP servers, skills, and plugins. Calculates fixed session token overhead and detects unused (30d), duplicate, or conflicting configurations.
* **Smart Recommendations & Curated Catalog:** Synthesizes findings into ranked actions enriched with vetted open-source tools from `catalog.yaml`.
* **Automated Weekly Usage Reports:** Generates comprehensive Monday reports in GitHub-flavored Markdown and standalone dark/light HTML (`<dataDir>/reports/`), with native desktop notifications across Linux (`notify-send`), macOS (`osascript`), and Windows (PowerShell toast).
* **Improvement Tracking with Quality Guardrails:** Tracks accepted recommendations across 14-day before/after windows, verifying real token savings while ensuring error rates and interaction turns don't regress.
* **Flexible Exports & Prometheus Metrics:** CLI exporter (`agentlens export --format csv|json`), `GET /api/export.csv`, Prometheus `GET /metrics` text endpoint, and in-dashboard CSV table downloads.
* **Multi-Platform Reach:** Full Linux, macOS (`launchd`, `osascript`), and Windows (`schtasks`) support with graceful Antigravity degradation and adapters for Gemini CLI, Aider, and Cursor.

---

## 📸 Visual Tour

### 1. Recommendations & Improvement Tracking
Synthesizes findings into actionable recommendations with copyable snippets. Accepts recommendations and tracks 14-day before/after token deltas while enforcing error-rate guardrails.

![Workflow Recommendations](assets/screenshots/recommendations.png)

### 2. Configuration Audit
Calculates fixed instruction token tax per session, audits 30-day usage of MCP tools and skills, and flags duplicate configurations across agents.

![Configuration Audit](assets/screenshots/audit.png)

### 3. Automated Weekly Usage Reports
Comprehensive weekly executive summary: week-over-week trends, quota near-misses, top wasting patterns, and top 3 priorities for next week.

![Weekly Usage Reports](assets/screenshots/reports.png)

### 4. Curated Catalog & Privacy-Safe Tool Discovery
Browse vetted tools mapped to token-waste rules (Serena, Repomix, Context7, ccusage), or discover new tools from GitHub using privacy-safe generic queries.

![Tool Catalog and Discovery](assets/screenshots/catalog.png)

---

## 🏗 Architecture

```mermaid
flowchart TD
    subgraph AgentSources["Local Agent Data Sources (Read-Only)"]
        CC["Claude Code\nProjects JSONL"]
        CX["Codex\nSessions JSONL"]
        OC["OpenCode\nopencode.db (Multi-root)"]
        AG["Antigravity\nconversation_summaries.db"]
        GM["Gemini CLI\nChats & Turn Logs"]
        AI["Aider\nChat History & Analytics"]
        CR["Cursor\nstate.vscdb Composer Logs"]
    end

    subgraph CoreEngine["agentlens Core Engine (Zero External Deps)"]
        Adapters["Streaming Log & SQLite Adapters"]
        DB[("agentlens.db\n(node:sqlite)")]
        Detectors["14 Workflow Waste Detectors"]
        Audit["Config Audit & Instruction Trimmer"]
        Catalog["Curated Catalog\n(catalog.yaml)"]
        Reports["Weekly Report Generator\n(Markdown & HTML)"]
        Tracker["14-Day Improvement Tracker\n(with Quality Guardrails)"]
    end

    subgraph Outputs["Interfaces & Outputs"]
        Statusline["Live Statusline\n(< 10ms)"]
        CLI["agentlens CLI\n(status, audit, report, track, export, discover)"]
        WebUI["Local Web Dashboard\n(http://127.0.0.1:4711)"]
        Service["Background Service\n(systemd / launchd / schtasks)"]
        Metrics["Prometheus & CSV Exports\n(/metrics, /api/export.csv)"]
    end

    AgentSources --> Adapters
    Adapters --> DB
    DB --> Detectors
    DB --> Audit
    Detectors --> Catalog
    Catalog --> Tracker
    DB --> Reports
    DB --> WebUI
    DB --> CLI
    DB --> Metrics
    Statusline --> CC
    Service --> Adapters
```

---

## 🚀 Quick Start

### 1. Requirements
- Operating System: Linux (Ubuntu, Debian, Fedora, Arch, etc.), macOS (Sonoma, Sequoia, etc.), or Windows 10/11
- Node.js ≥ 22.18 (built with native SQLite and type-stripping support)
- Zero runtime npm dependencies required

### 2. Installation & Running

```bash
# Clone the repository
git clone https://github.com/SohailElskhawy/agentlens.git
cd agentlens

# Install devDependencies (TypeScript for typechecking/tests)
npm install

# Perform an initial one-shot backfill from your agent logs
# Linux / macOS:
./bin/agentlens ingest
# Windows (Command Prompt):
.\bin\agentlens.cmd ingest
# Windows (PowerShell):
.\bin\agentlens.ps1 ingest

# Start the continuous watcher and dashboard
# Linux / macOS:
./bin/agentlens serve
# Windows (Command Prompt):
.\bin\agentlens.cmd serve
# Windows (PowerShell):
.\bin\agentlens.ps1 serve
```

Open **http://127.0.0.1:4711** in your browser.

### 3. Optional: Global CLI Install
To make `agentlens` available anywhere in your terminal:
```bash
npm link
# Or install globally from checkout:
npm install -g .
```

### 4. Background Service Setup (`install-service`)
Run `agentlens install-service` to configure agentlens to start automatically in the background on user login. The installer automatically detects your operating system and creates native daemon configurations:

#### Linux (`systemd`)
Generates user unit `~/.config/systemd/user/agentlens.service` with resource caps (`Nice=10`, `MemoryMax=200M`):
```bash
agentlens install-service
systemctl --user daemon-reload
systemctl --user enable --now agentlens
```
- **Check status / logs:** `systemctl --user status agentlens` or `journalctl --user -u agentlens -f`
- **Restart / Stop:** `systemctl --user restart agentlens` or `systemctl --user stop agentlens`
- *(Optional)* Keep running without an active login session: `loginctl enable-linger $USER`

#### macOS (`launchd`)
Generates LaunchAgent `~/Library/LaunchAgents/com.agentlens.plist` with output logging to `<stateDir>/agentlens.log`:
```bash
agentlens install-service
launchctl load -w ~/Library/LaunchAgents/com.agentlens.plist
```
- **Check logs:** `tail -f ~/Library/Caches/agentlens/agentlens.log`
- **To unload / stop:** `launchctl unload -w ~/Library/LaunchAgents/com.agentlens.plist`

#### Windows (Task Scheduler / `schtasks`)
Creates `%LOCALAPPDATA%\agentlens\agentlens-service.cmd` and outputs the `schtasks` registration command to register an `onlogon` task:
```cmd
:: 1. Generate helper script and display the exact registration command
agentlens.cmd install-service

:: 2. Register the logon task (execute the schtasks command output by install-service)
schtasks /create /tn "agentlens" /tr "\"%ProgramFiles%\nodejs\node.exe\" --no-warnings=ExperimentalWarning \"%USERPROFILE%\agentlens\src\cli.ts\" serve" /sc onlogon /f

:: 3. Start the service immediately without logging out/in
schtasks /run /tn "agentlens"
```
- **To stop:** `schtasks /end /tn "agentlens"`
- **Manual inspection & testing:** `%LOCALAPPDATA%\agentlens\agentlens-service.cmd` is available to execute or inspect directly in Command Prompt / PowerShell for debugging.

### 5. Claude Code Live Statusline
Configure Claude Code to display real-time token usage and quota status in your prompt bar (< 10ms latency).

Run `agentlens install-statusline` to display the exact configuration snippet for your operating system:
```bash
agentlens install-statusline
```

Add the printed snippet to `~/.claude/settings.json` (or `%USERPROFILE%\.claude\settings.json` on Windows):

**Linux & macOS:**
```json
{
  "statusLine": {
    "command": "agentlens statusline"
  }
}
```

**Windows (Command Prompt & PowerShell):**
```json
{
  "statusLine": {
    "command": "agentlens.cmd statusline"
  }
}
```

---

## 💻 CLI Reference

| Command | Description |
|---|---|
| `agentlens serve` | Continuously ingest agent data and serve dashboard on `http://127.0.0.1:4711` |
| `agentlens ingest` | Perform an incremental backfill of all 4 agents into SQLite and exit |
| `agentlens export [--format csv\|json] [--type sessions\|daily\|findings] [--from <date>] [--to <date>] [--project <path>]` | Export session history, daily aggregates, or waste findings to CSV or JSON |
| `agentlens status [--project <path>]` | Terminal summary of token usage, estimated costs, and active quotas |
| `agentlens audit [--project <path>]` | Audit instruction overhead, unused MCPs/skills, duplicates, and conflicts |
| `agentlens report [--week YYYY-Www] [--html] [--json]` | Generate and display weekly usage report |
| `agentlens track [--project <path>]` | Display before/after improvement tracking for accepted recommendations |
| `agentlens accept <id>` | Accept a recommendation and start 14-day improvement tracking |
| `agentlens catalog [--rule <name>] [--json]` | Browse curated tool & MCP catalog mapped to waste patterns |
| `agentlens discover [--query <terms>] [--dry-run] [--json]` | Opt-in discovery of agent tools and MCPs from GitHub |
| `agentlens statusline` | Streamlined stdin processor for Claude Code statusline payload |
| `agentlens install-statusline` | Print configuration instructions for Claude Code statusline |
| `agentlens install-service` | Install native background service (systemd user unit, launchd agent, or Windows scheduled task) |

---

## 🔒 Privacy & Security Guarantees

agentlens is engineered from the ground up to respect developer privacy and system security:
- **Strictly Read-Only on Agent Files:** Agent log files and SQLite databases are opened with read-only flags (`mode=ro`). agentlens **never** modifies agent configurations, installs tools, or alters session histories.
- **Zero Raw Prompt or Output Storage:** Prompt text and tool outputs are never persisted to disk. Only SHA-256 hashes and byte lengths are recorded for repetition detection.
- **Strict Network Isolation:** Dashboard binds exclusively to loopback (`127.0.0.1`) with DNS rebinding host protection. Metrics (`/metrics`) and CSV exports (`/api/export.csv`) are strictly loopback-only. No analytics, telemetry, or external AI model calls are made.
- **Zero Agent Token Allowance:** agentlens never injects prompt instructions or SessionStart hooks into active coding sessions.
- **Privacy-Safe Discovery:** The optional GitHub discovery engine operates strictly on generic alphanumeric keyword queries. Local paths, project names, or token metrics are never transmitted.
- **Opt-In Agent Automation (`Fix Now`):** Executing automated fixes via local agent CLIs (`claude`, `codex`, `opencode`) is strictly opt-in and disabled by default until explicitly enabled in Settings (`Allow agentlens to launch agents`). All CLI commands require confirmation displaying the exact command array and verified project folder, and are executed via direct `execFile`/`spawn` argument arrays (never a shell string) restricted solely to repositories already tracked by agentlens.

---

## 📊 Three Numbers Kept Strictly Separate

agentlens strictly distinguishes three distinct metrics to avoid confusion:
1. **Measured Tokens:** Exact input, output, cache-read, cache-write, and reasoning tokens extracted directly from agent JSONL logs and SQLite databases.
2. **Estimated API Cost:** Theoretical pay-as-you-go API cost calculated from a bundled LiteLLM price snapshot (informative comparison, not actual subscription billing).
3. **Reported Subscription Quota:** Actual percentage of the rolling 5-hour and 7-day usage limits reported directly by Claude Code and Codex rate-limit headers.

---

## 📁 Platform Path Locations

agentlens automatically adheres to platform filesystem standards across Linux, macOS, and Windows:

| Path Item | Linux (XDG) | macOS (Darwin) | Windows |
|---|---|---|---|
| **Data Directory** (`dataDir`) | `~/.local/share/agentlens` | `~/Library/Application Support/agentlens` | `%LOCALAPPDATA%\agentlens` |
| **State Directory** (`stateDir`) | `~/.local/state/agentlens` | `~/Library/Caches/agentlens` | `%LOCALAPPDATA%\agentlens\state` |
| **Reports Directory** (`reportsDir`) | `<dataDir>/reports` | `<dataDir>/reports` | `<dataDir>\reports` |
| **SQLite Database** (`dbPath`) | `<dataDir>/agentlens.db` | `<dataDir>/agentlens.db` | `<dataDir>\agentlens.db` |
| **Live Summary** (`summaryPath`) | `<stateDir>/summary.json` | `<stateDir>/summary.json` | `<stateDir>\summary.json` |
| **Quota Spool** (`spoolPath`) | `<stateDir>/claude-quota.jsonl` | `<stateDir>/claude-quota.jsonl` | `<stateDir>\claude-quota.jsonl` |
| **Candidates Store** (`candidatesPath`) | `<dataDir>/discovery_candidates.json` | `<dataDir>/discovery_candidates.json` | `<dataDir>\discovery_candidates.json` |

> [!NOTE]
> **Path Overrides & Backwards Compatibility:**
> - `AGENTLENS_DATA_DIR` and `AGENTLENS_STATE_DIR` environment variables override default locations on all platforms.
> - **Legacy fallback:** If `~/.local/share/agentlens/agentlens.db` already exists on disk, agentlens continues using the legacy XDG path regardless of OS, ensuring zero migration friction.

---

## 📁 Agent Data Sources & Universal Discovery

agentlens performs read-only discovery of logs and session databases across Linux, macOS, and Windows:

| Agent | Platform Log / Database Locations | Tokens Tracked | Quota Support |
|---|---|---|---|
| **Claude Code** | • `CLAUDE_CONFIG_DIR`<br>• `<home>/.claude/projects/*/*.jsonl`<br>*(Identical structure on Linux, macOS, and `%USERPROFILE%\.claude\projects` on Windows)* | Input, output, reasoning, cache read/write (5m/1h) | Live 5h / 7d percentage & resets |
| **Codex** | • `CODEX_HOME`<br>• `<home>/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`<br>*(Identical structure on Linux, macOS, and `%USERPROFILE%\.codex\sessions` on Windows)* | Input (deduped cache), output, reasoning, cache read | 5h / 7d rate limits from session events |
| **OpenCode** | Multi-root candidate discovery searching for `opencode.db` in priority order:<br>1. **Linux**: `~/.local/share/opencode` (or `$XDG_DATA_HOME/opencode`)<br>2. **macOS**: `~/Library/Application Support/opencode`<br>3. **Windows**: `%APPDATA%\opencode` and `%LOCALAPPDATA%\opencode`<br>*(Config audit also scans `~/.config/opencode`, `~/Library/Application Support/opencode`, and `%APPDATA%\opencode` for `opencode.json`)* | Messages, tokens (input/output/reasoning/cache), tools | Session metrics (`n/a` for quota) |
| **Antigravity** | SQLite conversation summary database searched in priority order:<br>1. `<home>/.gemini/antigravity-cli/conversation_summaries.db`<br>2. `<home>/.gemini/antigravity/conversation_summaries.db`<br>*(Standard under user home directory on Linux, macOS, and Windows; degrades gracefully with dashboard warning when `ccusage` is absent)* | Sessions, workspace roots, ccusage bridge | Session metrics (`n/a` for quota) |
| **Gemini CLI** | Chat and turn session JSON logs searched across:<br>• `<home>/.gemini/tmp/*` and `<home>/.gemini/antigravity-cli/*` | Input, output, reasoning, cached tokens | Session metrics (`n/a` for quota) |
| **Aider** | Chat logs and telemetry searched across workspace roots:<br>• `.aider.chat.history.md`<br>• `.aider.input.history`<br>• `.aider.analytics.jsonl` | Session history, tokens, estimated cost | Session metrics (`n/a` for quota) |
| **Cursor** | SQLite composer state database (`state.vscdb`) searched in priority order:<br>1. **Linux**: `~/.config/Cursor/User/globalStorage/state.vscdb`<br>2. **macOS**: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`<br>3. **Windows**: `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | Composer prompts, token counters, models | Session metrics (`n/a` for quota) |

---

## 🛠 Configuration

| Environment Variable | Default Path (Linux / macOS / Windows) | Purpose |
|---|---|---|
| `AGENTLENS_DATA_DIR` | `~/.local/share/agentlens`<br>`~/Library/Application Support/agentlens`<br>`%LOCALAPPDATA%\agentlens` | SQLite database (`agentlens.db`), reports, and discovery candidates |
| `AGENTLENS_STATE_DIR` | `~/.local/state/agentlens`<br>`~/Library/Caches/agentlens`<br>`%LOCALAPPDATA%\agentlens\state` | Live summary (`summary.json`) and Claude quota spool |
| `AGENTLENS_PORT` | `4711` | Dashboard HTTP listening port |
| `AGENTLENS_SOURCE_HOME` | User home directory (`$HOME` or `%USERPROFILE%`) | Base home directory scanned for agent logs |
| `GITHUB_TOKEN` | *(optional)* | Personal access token for higher GitHub discovery rate limits |

---

## 🧪 Testing & Verification

```bash
# Run test suite (191 unit & integration tests)
npm test

# Run TypeScript typecheck
npm run typecheck

# Check dashboard syntax
node --check web/app.js

# Update bundled LiteLLM price snapshot (dev only)
npm run update-prices
```

---

## 🤝 Contributing

We welcome contributions! Please read our [Contributing Guide](CONTRIBUTING.md) to learn about our architecture, coding guidelines, and PR workflow.

1. Fork the repo and create your branch from `master`.
2. Ensure `npm test && npm run typecheck && node --check web/app.js` passes.
3. Submit a Pull Request!

---

## 🗺️ Roadmap & Integrations

- **[ROADMAP.md](ROADMAP.md)** — Architectural proposals for in-flight guardrails via MCP, automated ignore generation, git branch cost attribution, and terminal UI (`agentlens tui`).
- **[OMARCHY_PLUGIN.md](OMARCHY_PLUGIN.md)** — Complete specification for the native **Omarchy Quattro** desktop bar widget and slide-out details panel (`BarWidget.qml`, `Panel.qml`).
- **[VSCODE_EXTENSION.md](VSCODE_EXTENSION.md)** — Full specification for the **VS Code & Cursor** extension (`vscode-agentlens`), including ambient status bar quota monitoring, workspace Fix Now tree view, and in-editor instruction trimmer diff preview.

---

## 🤝 Open Source Acknowledgments

agentlens incorporates concepts and parsing techniques inspired by open-source projects in the developer community:
- [ccusage](https://github.com/ccusage/ccusage) (MIT) — Claude Code token and quota parsing.
- [TraceRoost](https://github.com/traceroost/core) (MIT) — Multi-agent workflow and subagent tracing ideas.
- [Tokenomics](https://github.com/galando/tokenomics) (MIT) — Model tier expenditure heuristics.
- [agent-audit](https://github.com/Back-Road-Creative/agent-audit) (MIT) — Tool retry sequence analysis.
- [mcp-tokens](https://github.com/sd2k/mcp-tokens) (MIT) — Tool schema overhead estimation.
- [uPlot](https://github.com/leeoniya/uPlot) (MIT) — Ultra-fast time-series canvas charts.
- [LiteLLM](https://github.com/BerriAI/litellm) — Community pricing snapshot reference.

---

## 📜 License

[MIT License](LICENSE) © 2026 agentlens authors.
