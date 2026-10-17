# `agentlens.bar-widget` — Omarchy Quattro Desktop Plugin (v1.1)

Native Quickshell / QtQuick bar widget and 3-tab slide-out telemetry cockpit for **Omarchy Quattro** on Linux.

## Features

- **Live Top-Bar Pill (`BarWidget.qml`):**
  - Displays your most constrained ("binding") 5-hour subscription quota percentage, reset countdown, active token burn rate (`🔥 X/h`), and live waste alert badge (`⚠ N`), e.g. `⚡ 82% (1h 14m) · 🔥 120.5k/h`.
  - Configurable `pillMode` (`"full"` | `"compact"` | `"cost"`) via `omarchy bar set agentlens.bar-widget pillMode compact` or **Middle-click** cycling.
  - **Left-click** toggles the 3-tab cockpit panel; **Right-click** opens `http://127.0.0.1:4711`.
  - Zero-overhead reactive file watching on `~/.local/state/agentlens/summary.json` via `Quickshell.Io.FileView` (`watchChanges: true`) plus a 15-second poll backup and loopback HTTP fallback (`http://127.0.0.1:4711/api/quota`).
- **3-Tab Telemetry Cockpit (`Panel.qml`):**
  - **Tab 1 (`Overview`):**
    - **Live Session Waste Alert Banner:** Surfaces active retry loops, context runaway, or large tool dumps detected in the last 30 minutes.
    - **Cross-Agent Switch Advisor:** Recommends switching when one agent's 5h quota is `>= 80%` while another has `<= 50%` used.
    - **Quota Windows & Clock Pace:** 5-hour and 7-day progress bars with linear clock-pace tick markers (`+X% vs clock`).
    - **Today's Activity KPIs & Active Agents Today:** Shows tokens, API cost, burn velocity, and per-agent breakdown (**Antigravity**, **Claude Code**, **Codex**, **OpenCode**, etc.).
  - **Tab 2 (`Fix & Optimize`):**
    - **Top 5 Recommendations Carousel (`[` / `]`):** Copy Fix Prompt (`c`) or mark as **Accept & Track 14d (`a`)** (`POST /api/recommendations/:id/accept`).
    - **1-Click Workspace Hygiene:** Preview and apply `.claudeignore`/`.agentignore` rules and instruction trims (`GET`/`POST /api/optimize`).
  - **Tab 3 (`Trends & Budgets`):**
    - **Tokens by Day (7d):** 7-day horizontal bar chart with today highlighted.
    - **Top Models (7d):** Model ranking with `in / out / cache` token split.
    - **Projects & Weekly Budgets:** Per-project usage and weekly budget progress bars.

## Keyboard Shortcuts (Inside Panel)

| Key | Action |
|---|---|
| `h` / `l` or `←` / `→` | Cycle between `Overview`, `Fix & Optimize`, and `Trends` tabs |
| `1` / `2` / `3` | Jump directly to tab 1, 2, or 3 |
| `[` / `]` | Previous / next open recommendation |
| `c` | Copy current recommendation Fix Prompt to clipboard |
| `a` | Accept current recommendation & start 14-day tracking |
| `o` | Open full web dashboard (`http://127.0.0.1:4711`) |
| `r` | Force immediate telemetry refresh |
| `Esc` | Close panel |

## Installation & CLI Management

```bash
# Install to ~/.config/omarchy/plugins/agentlens.bar-widget, validate, and enable in the bar
agentlens plugin install --enable

# Check installation & shell status
agentlens plugin status

# Query live widget status or trigger a reload over IPC
omarchy-shell agentlens.bar-widget status
omarchy-shell agentlens.bar-widget refresh

# Change bar pill format ("full", "compact", or "cost")
omarchy bar set agentlens.bar-widget pillMode compact

# Disable and uninstall
agentlens plugin uninstall
```
