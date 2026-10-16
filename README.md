# agentlens

Local-first, read-only usage and workflow optimizer for AI coding agents on Linux.
M1 status: usage dashboard for **Claude Code** and **Codex** (OpenCode and Antigravity are in M2).

- Reads the log files the agents already write; never modifies agent config; no network at runtime.
- Never stores prompt or tool text (hashes and lengths only).
- Three numbers kept separate: **tokens (measured)**, **API-equivalent cost (estimated** from a bundled LiteLLM price snapshot; not what a subscription bills), and **quota used (reported by the agent**; Codex today, Claude via statusline in M2; `n/a` otherwise).

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

## Configuration

| Variable | Default | Description |
|---|---|---|
| `AGENTLENS_DATA_DIR` | `$XDG_DATA_HOME/agentlens` (`~/.local/share/agentlens`) | Where SQLite DB and state are saved |
| `AGENTLENS_PORT` | `4711` | Dashboard HTTP port |
| `AGENTLENS_SOURCE_HOME` | `$HOME` | Home directory to discover agent logs from |

## Accuracy

Daily token totals are verified against [ccusage](https://github.com/ccusage/ccusage) (within 0–5% per day on real Claude Code and Codex logs).

## Development

```bash
npm test && npm run typecheck
npm run update-prices   # refresh src/prices.json (dev only)
```

MIT licensed. Parsing approach informed by ccusage (MIT); uPlot (MIT) is vendored in `web/vendor`.
