# agentlens

Local-first, read-only usage and workflow optimizer for AI coding agents on Linux.
Supports **Claude Code (Pro)**, **Codex (Plus)**, **OpenCode (Go)**, and **Antigravity (Pro)**.

- Reads the local log files and databases the agents already write; never modifies agent configuration; zero external network calls at runtime.
- Privacy-first: never stores prompt or tool text (SHA-256 hashes and byte lengths only).
- Three numbers kept separate: **Tokens (measured)**, **API-equivalent cost (estimated** from a bundled LiteLLM price snapshot; not what a subscription bills), and **Quota used (reported by agent**; Codex and Claude Code; `n/a` for agents without quota reporting).

## Install

Requires Node ≥ 22.18.

```bash
git clone <repo> agentlens && cd agentlens && npm install
node src/cli.ts ingest            # one-shot backfill
node src/cli.ts serve             # dashboard on http://127.0.0.1:4711
```

Always on from login:

```bash
node src/cli.ts install-service
systemctl --user daemon-reload && systemctl --user enable --now agentlens
```

## CLI Commands

| Command | Description |
|---|---|
| `agentlens serve` | Continuously ingest agent data and serve dashboard on `http://127.0.0.1:4711` |
| `agentlens ingest` | Perform a one-shot incremental backfill of all 4 agents into SQLite and exit |
| `agentlens status [--project <path>]` | Print terminal usage summary, estimated costs, and quotas for project |
| `agentlens statusline` | Process Claude Code statusline payload on stdin, spool quota, and format live status |
| `agentlens install-statusline` | Print instructions for configuring Claude Code statusline |
| `agentlens install-service` | Install systemd user service for background execution |

### Live Claude Code Statusline Setup

Add the following to `~/.claude/settings.json` or project `.claude/settings.json`:

```json
{
  "statusLine": {
    "command": "agentlens statusline"
  }
}
```

This pipes live Claude rate-limit data into agentlens without opening SQLite, keeping statusline latency under 10ms.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `AGENTLENS_DATA_DIR` | `$XDG_DATA_HOME/agentlens` (`~/.local/share/agentlens`) | Where SQLite DB and state are saved |
| `AGENTLENS_STATE_DIR` | `$XDG_STATE_HOME/agentlens` (`~/.local/state/agentlens`) | Where live summary and quota spool reside |
| `AGENTLENS_PORT` | `4711` | Dashboard HTTP port |
| `AGENTLENS_SOURCE_HOME` | `$HOME` | Home directory to discover agent logs from |

## Agent Data Sources

| Agent | Source | Tokens | Quota |
|---|---|---|---|
| **Claude Code** | `~/.claude/projects/*/*.jsonl` | Input, output, reasoning, cache read/write | Live 5h / 7d percentage via statusline |
| **Codex** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Input (deduped cache), output, reasoning, cache read | Rate limits in rollout logs (5h / 7d) |
| **OpenCode** | `~/.local/share/opencode/opencode.db` | Messages, tokens (input/output/reasoning/cache), tool parts | `n/a` |
| **Antigravity** | `~/.gemini/antigravity{,-cli}/conversation_summaries.db` | Sessions, workspace roots, ccusage bridge | `n/a` |

## Accuracy & Health

Daily token totals are verified against [ccusage](https://github.com/ccusage/ccusage) (within 0–5% per day on real agent logs).
Visit the **Health** tab in the dashboard (`http://127.0.0.1:4711/#/health`) to inspect ingestion statistics, skipped lines, and automated ccusage drift detection.

## Development

```bash
npm test && npm run typecheck
npm run update-prices   # refresh src/prices.json (dev only)
```

MIT licensed. Parsing approach informed by ccusage (MIT); uPlot (MIT) is vendored in `web/vendor`.
