# agentlens Cross-Platform Support Design: Linux, macOS & Windows

**Status:** Approved  
**Date:** 2026-10-16  
**Scope:** Cross-Platform Path Resolution, Background Daemons, Desktop Notifications, and CLI Wrappers

---

## 1. Objectives & Guarantees

1. **Universal Agent Support:** Seamlessly detect and parse usage data from Claude Code, Codex, OpenCode, and Antigravity across **Linux**, **macOS** (Apple Silicon & Intel), and **Windows** (x64 & ARM64).
2. **Zero Runtime Dependencies:** Strictly maintain zero runtime npm dependencies by relying entirely on Node.js native standard libraries (`node:path`, `node:fs`, `node:child_process`, `node:os`, `node:sqlite`).
3. **Platform Native Storage:** Adhere to native filesystem conventions on each operating system while maintaining full backwards compatibility with existing Linux installations.
4. **Native Background Services:** Implement `install-service` for all three operating systems:
   - Linux: `systemd` user unit
   - macOS: `launchd` LaunchAgent
   - Windows: Windows Task Scheduler logon task (`schtasks`)
5. **Native Desktop Notifications:** Dispatch weekly report notifications natively:
   - Linux: `notify-send`
   - macOS: AppleScript via `osascript`
   - Windows: PowerShell toast / notification

---

## 2. Centralized Platform Paths (`src/paths.ts`)

Create a centralized path resolver module `src/paths.ts` used by the CLI, background daemon, HTTP server, and report generators:

```ts
export interface PlatformPaths {
  dataDir: string;
  stateDir: string;
  reportsDir: string;
  dbPath: string;
  summaryPath: string;
  spoolPath: string;
  candidatesPath: string;
}

export function getPlatformPaths(customHome?: string, env = process.env): PlatformPaths
```

### Path Resolution Rules

| Path Type | Linux (POSIX) | macOS (Darwin) | Windows (Win32) |
|---|---|---|---|
| **Data Directory** (`dataDir`) | `~/.local/share/agentlens` | `~/Library/Application Support/agentlens` | `%LOCALAPPDATA%\agentlens` |
| **State Directory** (`stateDir`) | `~/.local/state/agentlens` | `~/Library/Caches/agentlens` | `%LOCALAPPDATA%\agentlens\state` |
| **Reports Directory** (`reportsDir`) | `<dataDir>/reports` | `<dataDir>/reports` | `<dataDir>\reports` |
| **SQLite Database** (`dbPath`) | `<dataDir>/agentlens.db` | `<dataDir>/agentlens.db` | `<dataDir>\agentlens.db` |
| **Live Summary** (`summaryPath`) | `<stateDir>/summary.json` | `<stateDir>/summary.json` | `<stateDir>\summary.json` |
| **Quota Spool** (`spoolPath`) | `<stateDir>/claude-quota.jsonl` | `<stateDir>/claude-quota.jsonl` | `<stateDir>\claude-quota.jsonl` |
| **Candidates Store** (`candidatesPath`) | `<dataDir>/discovery_candidates.json` | `<dataDir>/discovery_candidates.json` | `<dataDir>\discovery_candidates.json` |

### Environment Variable Overrides & Legacy Fallback
1. `AGENTLENS_DATA_DIR` always overrides `dataDir`.
2. `AGENTLENS_STATE_DIR` always overrides `stateDir`.
3. **Backwards Compatibility:** If `customHome` is not set and `~/.local/share/agentlens/agentlens.db` already exists on disk, `dataDir` defaults to `~/.local/share/agentlens` even on macOS or Windows, ensuring zero migration friction for existing users.

---

## 3. Agent Log Discovery Across Platforms

### 1. Claude Code
- Path: `CLAUDE_CONFIG_DIR` or `join(home, '.claude/projects')`
- Cross-platform behavior: Identical on Linux, macOS, and Windows under `%USERPROFILE%\.claude\projects`.

### 2. Codex
- Path: `CODEX_HOME` or `join(home, '.codex/sessions')`
- Cross-platform behavior: Identical on Linux, macOS, and Windows under `%USERPROFILE%\.codex\sessions`.

### 3. OpenCode (`src/adapters/opencode.ts`)
- Database: `opencode.db`
- Discovery roots (searched in order):
  1. `~/.local/share/opencode` (Linux & default XDG)
  2. `~/Library/Application Support/opencode` (macOS standard)
  3. `%APPDATA%/opencode` and `%LOCALAPPDATA%/opencode` (Windows standard)
- Configuration:
  - Scanners search `~/.config/opencode/opencode.json`, `~/Library/Application Support/opencode/opencode.json`, and `%APPDATA%/opencode/opencode.json`.

### 4. Antigravity
- Path: `join(home, '.gemini/antigravity-cli/conversation_summaries.db')` and `join(home, '.gemini/antigravity/conversation_summaries.db')`
- Cross-platform behavior: Standard under user home directory across all platforms.

---

## 4. Background Services (`agentlens install-service`)

`src/cli.ts` will inspect `process.platform` to generate and write the native daemon configuration:

### 1. Linux: `systemd` User Service
- Path: `~/.config/systemd/user/agentlens.service`
- Configuration:
  ```ini
  [Unit]
  Description=agentlens: local AI agent usage monitor

  [Service]
  ExecStart="${process.execPath}" --no-warnings=ExperimentalWarning "${cliPath}" serve
  Restart=on-failure
  Nice=10
  IOSchedulingClass=idle
  MemoryMax=200M

  [Install]
  WantedBy=default.target
  ```
- User commands:
  ```bash
  systemctl --user daemon-reload && systemctl --user enable --now agentlens
  ```

### 2. macOS: `launchd` LaunchAgent
- Path: `~/Library/LaunchAgents/com.agentlens.plist`
- Configuration:
  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
      <key>Label</key>
      <string>com.agentlens</string>
      <key>ProgramArguments</key>
      <array>
          <string>${process.execPath}</string>
          <string>--no-warnings=ExperimentalWarning</string>
          <string>${cliPath}</string>
          <string>serve</string>
      </array>
      <key>RunAtLoad</key>
      <true/>
      <key>KeepAlive</key>
      <true/>
      <key>StandardOutPath</key>
      <string>${stateDir}/agentlens.log</string>
      <key>StandardErrorPath</key>
      <string>${stateDir}/agentlens.err</string>
  </dict>
  </plist>
  ```
- User commands:
  ```bash
  launchctl load -w ~/Library/LaunchAgents/com.agentlens.plist
  # To unload:
  launchctl unload -w ~/Library/LaunchAgents/com.agentlens.plist
  ```

### 3. Windows: Scheduled Task (`schtasks`)
- Action:
  Executes `schtasks` to create a logon task:
  ```cmd
  schtasks /create /tn "agentlens" /tr "\"%NODE_PATH%\" --no-warnings=ExperimentalWarning \"%CLI_PATH%\" serve" /sc onlogon /f
  ```
- Also writes a helper script `%LOCALAPPDATA%\agentlens\agentlens-service.cmd` for direct execution or manual testing.
- User commands:
  ```cmd
  schtasks /run /tn "agentlens"
  # To stop:
  schtasks /end /tn "agentlens"
  ```

---

## 5. Desktop Notifications (`src/report-scheduler.ts`)

Dispatches desktop notifications across all three platforms without external dependencies:

```ts
export function sendDesktopNotification(title: string, body: string): boolean {
  try {
    if (process.platform === 'darwin') {
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
      const p = spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true });
      p.on('error', () => {});
      p.unref();
      return true;
    }
    if (process.platform === 'win32') {
      const psScript = `
        [reflection.assembly]::loadwithpartialname('System.Windows.Forms') | Out-Null;
        $notify = New-Object System.Windows.Forms.NotifyIcon;
        $notify.Icon = [System.Drawing.SystemIcons]::Information;
        $notify.Visible = $True;
        $notify.ShowBalloonTip(10000, ${JSON.stringify(title)}, ${JSON.stringify(body)}, [System.Windows.Forms.ToolTipIcon]::Info);
      `;
      const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
        stdio: 'ignore',
        detached: true,
      });
      p.on('error', () => {});
      p.unref();
      return true;
    }
    const p = spawn('notify-send', [title, body], { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch {
    return false;
  }
}
```

---

## 6. CLI Executables & Packaging

### 1. Windows Wrappers
- **`bin/agentlens.cmd`:**
  ```cmd
  @echo off
  node --no-warnings=ExperimentalWarning "%~dp0..\src\cli.ts" %*
  ```
- **`bin/agentlens.ps1`:**
  ```powershell
  & node --no-warnings=ExperimentalWarning "$PSScriptRoot/../src/cli.ts" @args
  ```

### 2. POSIX Wrapper (`bin/agentlens`)
- Retains existing POSIX shell wrapper for Linux, macOS, WSL, and Git Bash:
  ```bash
  #!/usr/bin/env bash
  set -e
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  exec node --no-warnings=ExperimentalWarning "$DIR/../src/cli.ts" "$@"
  ```

### 3. Statusline Setup (`agentlens install-statusline`)
- Inspects `process.platform` to output OS-appropriate configuration snippets for `~/.claude/settings.json`:
  - Linux / macOS: `"command": "agentlens statusline"`
  - Windows: `"command": "agentlens.cmd statusline"`

---

## 7. Testing Strategy

1. **Unit Tests (`test/paths.test.ts`):**
   - Test `getPlatformPaths()` under mock `process.platform` values (`linux`, `darwin`, `win32`).
   - Test legacy fallback when `~/.local/share/agentlens/agentlens.db` exists.
   - Test environment variable overrides (`AGENTLENS_DATA_DIR`, `AGENTLENS_STATE_DIR`).
2. **Adapter Discovery Tests (`test/adapters-crossplatform.test.ts`):**
   - Test OpenCode discovery on macOS application support and Windows AppData mock trees.
3. **Notification Unit Tests:**
   - Verify `sendDesktopNotification` handles mock spawns on darwin and win32 safely without throwing.
4. **Service Installation Tests:**
   - Test generated plist, systemd unit, and schtasks commands for proper quoting and escaping.
