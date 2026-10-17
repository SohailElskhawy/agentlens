# `agentlens.bar-widget` — Omarchy Quattro Desktop Plugin

Live AI coding agent quota tracking, token burn velocity, and one-click waste remediation for the **Omarchy Quattro** shell (`omarchy-shell` / Quickshell).

## Features

- **Live Bar Pill (`BarWidget.qml`)**:
  - Displays the most constrained ("binding") 5-hour quota window (`⚡ 68% (1h 42m)`) and active token burn velocity (`🔥 42.1k/h`).
  - Automatic semantic coloring (`Normal`, `Warning` >= 80%, `Danger` >= 95% or projected exhaustion within 30m).
  - **Left-click**: Toggle the anchored floating details panel.
  - **Middle-click**: Force an immediate state reload.
  - **Right-click**: Open the local `agentlens` dashboard (`http://127.0.0.1:4711`).
- **Details Panel (`Panel.qml`)**:
  - Multi-agent 5h & 7d quota meters and pace projections for Claude Code and Codex.
  - Today's total tokens, API-equivalent cost (`$`), burn velocity, and top 3 active projects.
  - **Priority Fix Now** card with one-click fix prompt copy to the clipboard.

## Installation

From the `agentlens` CLI:

```bash
agentlens plugin install --enable
```

Or manually via Omarchy CLI:

```bash
omarchy plugin validate ~/.config/omarchy/plugins/agentlens.bar-widget
omarchy-shell shell rescanPlugins
omarchy plugin enable agentlens.bar-widget
```

## IPC Commands

```bash
omarchy-shell agentlens.bar-widget status
omarchy-shell agentlens.bar-widget toggle
omarchy-shell agentlens.bar-widget refresh
```
