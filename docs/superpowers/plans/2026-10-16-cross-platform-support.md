# Cross-Platform Support (Linux, macOS, Windows) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend agentlens from Linux-only to full cross-platform support across macOS (Apple Silicon & Intel), Windows (x64 & ARM64), and Linux with native path resolution, native background services (`launchd`, `schtasks`, `systemd`), and native desktop notifications, with zero runtime npm dependencies.

**Architecture:** A centralized platform paths module (`src/paths.ts`) resolves data, state, reports, and agent log directories according to OS standards (XDG for Linux, `Library/Application Support` for macOS, `AppData/Local` for Windows) with backwards compatibility for existing installations. Agent adapters and config scanners discover data across platform roots; background service installer (`agentlens install-service`) and desktop notifications dispatch through platform-native tools (`systemd`, `launchd`, `schtasks`, `notify-send`, `osascript`, `powershell`).

**Tech Stack:** Node.js (>= 22.18, native standard library: `node:path`, `node:fs`, `node:child_process`, `node:os`, `node:sqlite`), TypeScript 5.9, `node:test`.

**Spec:** [docs/superpowers/specs/2026-10-16-cross-platform-support-design.md](file:///home/sohail/sohal-dev/token-analyzer/docs/superpowers/specs/2026-10-16-cross-platform-support-design.md)

## Global Constraints

- Zero external runtime npm dependencies (`dependencies` in `package.json` must remain empty).
- Privacy-first and read-only: strictly read-only access to all agent logs and configuration files; no raw prompt or tool outputs stored.
- Node.js version floor: `>= 22.18` (uses native `DatabaseSync` from `node:sqlite`).
- Backwards compatibility: Existing Linux installations and environments where `~/.local/share/agentlens/agentlens.db` exists continue using that path by default.
- Environment variable overrides: `AGENTLENS_DATA_DIR` and `AGENTLENS_STATE_DIR` always take highest precedence across all operating systems.
- Every git commit message must end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Missing Windows environment variables (`LOCALAPPDATA` / `APPDATA` unset):** In minimal or containerized Windows environments where `LOCALAPPDATA` is unset, path resolution must fall back cleanly to `join(home, 'AppData/Local')` without throwing.
2. **Paths with spaces in Windows usernames:** A user profile path containing spaces (e.g., `C:\Users\John Doe\AppData\Local\agentlens`) must be properly quoted in Windows service definitions (`schtasks`), batch files, and CLI wrappers.
3. **Double quotes and special characters in notifications:** Desktop notification title and body text containing single quotes, double quotes, or newlines must be safely escaped for `osascript` (AppleScript) and `powershell` to prevent command injection or syntax errors.
4. **Coexisting OpenCode data roots:** If both `~/.local/share/opencode` and `~/Library/Application Support/opencode` exist, the adapter must discover the existing database deterministically without crashing.
5. **Headless or permission-restricted environments:** `install-service` and desktop notifications on macOS and Windows must catch spawn and execution errors gracefully and output helpful manual setup instructions instead of failing unhandled.

---

### Task 1: Centralized Platform Paths Resolver

**Files:**
- Create: `src/paths.ts`
- Modify: `src/cli.ts:21-28`, `src/report.ts:150-156`, `src/report-scheduler.ts:35-40`, `src/server.ts:83-88`, `src/discover.ts:75-85`
- Test: `test/paths.test.ts`

**Interfaces:**
- Consumes: `process.platform`, `process.env`, `node:os.homedir`, `node:path.join`
- Produces:
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
  export function getPlatformPaths(customHome?: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): PlatformPaths;
  export function getOpenCodeDataRoots(home: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string[];
  export function getOpenCodeConfigRoots(home: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string[];
  ```

- [ ] **Step 1: Write the failing test**

Create `test/paths.test.ts`:
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { getPlatformPaths, getOpenCodeDataRoots, getOpenCodeConfigRoots } from '../src/paths.ts';

test('getPlatformPaths: Linux paths follow XDG defaults', () => {
  const home = '/fake/user';
  const p = getPlatformPaths(home, {}, 'linux');
  assert.equal(p.dataDir, join(home, '.local/share/agentlens'));
  assert.equal(p.stateDir, join(home, '.local/state/agentlens'));
  assert.equal(p.reportsDir, join(home, '.local/share/agentlens/reports'));
  assert.equal(p.dbPath, join(home, '.local/share/agentlens/agentlens.db'));
  assert.equal(p.summaryPath, join(home, '.local/state/agentlens/summary.json'));
  assert.equal(p.spoolPath, join(home, '.local/state/agentlens/claude-quota.jsonl'));
  assert.equal(p.candidatesPath, join(home, '.local/share/agentlens/discovery_candidates.json'));
});

test('getPlatformPaths: macOS paths follow Darwin Application Support and Caches', () => {
  const home = '/fake/macuser';
  const p = getPlatformPaths(home, {}, 'darwin');
  assert.equal(p.dataDir, join(home, 'Library/Application Support/agentlens'));
  assert.equal(p.stateDir, join(home, 'Library/Caches/agentlens'));
  assert.equal(p.reportsDir, join(home, 'Library/Application Support/agentlens/reports'));
  assert.equal(p.dbPath, join(home, 'Library/Application Support/agentlens/agentlens.db'));
  assert.equal(p.summaryPath, join(home, 'Library/Caches/agentlens/summary.json'));
});

test('getPlatformPaths: Windows paths use LOCALAPPDATA when present', () => {
  const home = 'C:\\Users\\fakeuser';
  const localAppData = 'C:\\Users\\fakeuser\\AppData\\Local';
  const p = getPlatformPaths(home, { LOCALAPPDATA: localAppData }, 'win32');
  assert.equal(p.dataDir, join(localAppData, 'agentlens'));
  assert.equal(p.stateDir, join(localAppData, 'agentlens/state'));
  assert.equal(p.dbPath, join(localAppData, 'agentlens/agentlens.db'));
});

test('getPlatformPaths: Windows paths fallback when LOCALAPPDATA is unset (Review Focus 1)', () => {
  const home = 'C:\\Users\\fakeuser';
  const p = getPlatformPaths(home, {}, 'win32');
  assert.equal(p.dataDir, join(home, 'AppData/Local/agentlens'));
  assert.equal(p.stateDir, join(home, 'AppData/Local/agentlens/state'));
});

test('getPlatformPaths: AGENTLENS_DATA_DIR and AGENTLENS_STATE_DIR override all OS defaults', () => {
  const home = '/fake/user';
  const p = getPlatformPaths(home, {
    AGENTLENS_DATA_DIR: '/custom/data',
    AGENTLENS_STATE_DIR: '/custom/state',
  }, 'darwin');
  assert.equal(p.dataDir, '/custom/data');
  assert.equal(p.stateDir, '/custom/state');
  assert.equal(p.dbPath, join('/custom/data', 'agentlens.db'));
});

test('getPlatformPaths: preserves legacy ~/.local/share/agentlens if db already exists', () => {
  const tmpHome = join(process.cwd(), 'scratch/tmp-home-legacy');
  const legacyDir = join(tmpHome, '.local/share/agentlens');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'agentlens.db'), '');

  try {
    const p = getPlatformPaths(tmpHome, {}, 'darwin');
    assert.equal(p.dataDir, legacyDir);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('getOpenCodeDataRoots: returns candidate data directories in priority order', () => {
  const roots = getOpenCodeDataRoots('/fake/user', {}, 'linux');
  assert.ok(roots.length >= 2);
  assert.equal(roots[0], join('/fake/user', '.local/share/opencode'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test "test/paths.test.ts"`
Expected: FAIL with Cannot find module '../src/paths.ts'

- [ ] **Step 3: Implement `src/paths.ts` and integrate into existing modules**

1. Create `src/paths.ts` implementing `getPlatformPaths`, `getOpenCodeDataRoots`, and `getOpenCodeConfigRoots` with:
   - Priority 1: `AGENTLENS_DATA_DIR` / `AGENTLENS_STATE_DIR`.
   - Priority 2: Legacy fallback check for `join(home, '.local/share/agentlens/agentlens.db')` (if exists and no custom env override).
   - Priority 3: Native OS default (`darwin` -> `Library/Application Support` and `Library/Caches`, `win32` -> `LOCALAPPDATA` or `AppData/Local`, `linux`/default -> `XDG` or `.local/share` and `.local/state`).
2. Update `src/cli.ts` lines 21-28 to use `getPlatformPaths(HOME)`.
3. Update `src/report.ts` and `src/report-scheduler.ts` to use `getPlatformPaths(home).reportsDir`.
4. Update `src/server.ts` to use `getPlatformPaths(home).reportsDir`.
5. Update `src/discover.ts` to use `getPlatformPaths(customHome).candidatesPath`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test "test/paths.test.ts"`
Expected: PASS (all 7 tests pass)
Run: `npm test && npm run typecheck`
Expected: PASS (all existing 119 tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts src/cli.ts src/report.ts src/report-scheduler.ts src/server.ts src/discover.ts test/paths.test.ts
git commit -m "feat: add centralized cross-platform path resolver

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Cross-Platform OpenCode Adapter & Config Scanners

**Files:**
- Modify: `src/adapters/opencode.ts:7-15`
- Modify: `src/audit/scanners/instruction.ts:64-70`
- Modify: `src/audit/scanners/mcp.ts:154-180`
- Modify: `src/audit/scanners/plugin.ts:34-60`
- Modify: `src/audit/scanners/skill.ts:66-70`
- Test: `test/adapters-crossplatform.test.ts`

**Interfaces:**
- Consumes: `getOpenCodeDataRoots(home)`, `getOpenCodeConfigRoots(home)` from `src/paths.ts`
- Produces:
  - `opencode.root(home: string): string` returns the first candidate root containing `opencode.db` or the first platform candidate root.
  - `opencode.discover(root: string): string[]` checks candidate directories for `opencode.db`.
  - Scanners inspect all candidate OpenCode config roots for `opencode.json`, `AGENTS.md`, and `skills/` without duplicate items.

- [ ] **Step 1: Write the failing test**

Create `test/adapters-crossplatform.test.ts`:
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { opencode } from '../src/adapters/opencode.ts';
import { scanInstructions } from '../src/audit/scanners/instruction.ts';
import { scanMcpConfigs } from '../src/audit/scanners/mcp.ts';
import { scanPluginConfigs } from '../src/audit/scanners/plugin.ts';
import { scanSkills } from '../src/audit/scanners/skill.ts';

test('opencode adapter: discovers database in macOS Library/Application Support', () => {
  const tmpHome = join(process.cwd(), 'scratch/tmp-mac-opencode');
  const macDbDir = join(tmpHome, 'Library/Application Support/opencode');
  mkdirSync(macDbDir, { recursive: true });
  writeFileSync(join(macDbDir, 'opencode.db'), '');

  try {
    const root = opencode.root(tmpHome);
    const discovered = opencode.discover(root);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0], join(macDbDir, 'opencode.db'));
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('opencode adapter: handles coexisting data roots deterministically (Review Focus 4)', () => {
  const tmpHome = join(process.cwd(), 'scratch/tmp-coexist-opencode');
  const linuxDir = join(tmpHome, '.local/share/opencode');
  const macDir = join(tmpHome, 'Library/Application Support/opencode');
  mkdirSync(linuxDir, { recursive: true });
  mkdirSync(macDir, { recursive: true });
  writeFileSync(join(linuxDir, 'opencode.db'), '');
  writeFileSync(join(macDir, 'opencode.db'), '');

  try {
    const root = opencode.root(tmpHome);
    const discovered = opencode.discover(root);
    assert.equal(discovered.length, 1);
    assert.ok(discovered[0].includes('opencode.db'));
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('audit scanners: detects OpenCode instructions, MCPs, and skills in macOS/Windows config roots', () => {
  const tmpHome = join(process.cwd(), 'scratch/tmp-opencode-audit');
  const macConfigDir = join(tmpHome, 'Library/Application Support/opencode');
  mkdirSync(join(macConfigDir, 'skills/deploy'), { recursive: true });
  writeFileSync(join(macConfigDir, 'AGENTS.md'), '# macOS Agent Instructions');
  writeFileSync(join(macConfigDir, 'opencode.json'), JSON.stringify({
    mcpServers: {
      tester: { command: 'node', args: ['test.js'] }
    },
    plugins: ['lint-plugin']
  }));
  writeFileSync(join(macConfigDir, 'skills/deploy/SKILL.md'), '---\nname: deploy\n---\nDeploy instructions');

  try {
    const instructions = scanInstructions([], tmpHome);
    const macInstr = instructions.find((i) => i.agent === 'opencode');
    assert.ok(macInstr);
    assert.ok(macInstr.path.includes('Library/Application Support/opencode/AGENTS.md'));

    const mcps = scanMcpConfigs([], tmpHome);
    const macMcp = mcps.find((m) => m.name === 'tester');
    assert.ok(macMcp);

    const plugins = scanPluginConfigs([], tmpHome);
    const macPlug = plugins.find((p) => p.name === 'lint-plugin');
    assert.ok(macPlug);

    const skills = scanSkills([], tmpHome);
    const macSkill = skills.find((s) => s.name === 'deploy');
    assert.ok(macSkill);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test "test/adapters-crossplatform.test.ts"`
Expected: FAIL because `opencode.root` currently only checks `.local/share/opencode` and scanners only check `.config/opencode`.

- [ ] **Step 3: Update `src/adapters/opencode.ts` and `src/audit/scanners/`**

1. In `src/adapters/opencode.ts`:
   - Import `getOpenCodeDataRoots` from `../paths.ts`.
   - Update `root(home: string)`:
     - Find the first root in `getOpenCodeDataRoots(home)` where `existsSync(join(candidate, 'opencode.db'))` is true.
     - If none has `opencode.db`, return the first root from `getOpenCodeDataRoots(home)`.
   - Update `discover(root: string)`:
     - Check `join(root, 'opencode.db')`. If it exists, return `[join(root, 'opencode.db')]`.
     - Also check any other candidate roots from `getOpenCodeDataRoots` so if `root` was default but DB is in another candidate directory, it is discovered.
2. In `src/audit/scanners/instruction.ts`, `src/audit/scanners/mcp.ts`, `src/audit/scanners/plugin.ts`, `src/audit/scanners/skill.ts`:
   - Use `getOpenCodeConfigRoots(home)` to search candidate directories (`.config/opencode`, `Library/Application Support/opencode`, `%APPDATA%/opencode`).
   - Deduplicate items by source path or item name.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test "test/adapters-crossplatform.test.ts"`
Expected: PASS
Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/opencode.ts src/audit/scanners/ test/adapters-crossplatform.test.ts
git commit -m "feat: add cross-platform discovery for OpenCode adapter and config scanners

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Cross-Platform Native Desktop Notifications

**Files:**
- Modify: `src/report-scheduler.ts:1-25`
- Test: `test/notifications-crossplatform.test.ts`

**Interfaces:**
- Consumes: `process.platform`, `node:child_process.spawn`
- Produces:
  ```ts
  export function sendDesktopNotification(
    title: string,
    body: string,
    platform?: NodeJS.Platform,
    spawnFn?: typeof spawn
  ): boolean;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/notifications-crossplatform.test.ts`:
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendDesktopNotification } from '../src/report-scheduler.ts';

test('sendDesktopNotification: dispatches osascript on macOS (darwin)', () => {
  let calledCmd = '';
  let calledArgs: string[] = [];
  const fakeSpawn: any = (cmd: string, args: string[]) => {
    calledCmd = cmd;
    calledArgs = args;
    return { on: () => {}, unref: () => {} };
  };

  const ok = sendDesktopNotification('agentlens Weekly', 'Report ready', 'darwin', fakeSpawn);
  assert.equal(ok, true);
  assert.equal(calledCmd, 'osascript');
  assert.equal(calledArgs[0], '-e');
  assert.ok(calledArgs[1].includes('display notification'));
  assert.ok(calledArgs[1].includes('Report ready'));
  assert.ok(calledArgs[1].includes('agentlens Weekly'));
});

test('sendDesktopNotification: dispatches powershell toast on Windows (win32)', () => {
  let calledCmd = '';
  let calledArgs: string[] = [];
  const fakeSpawn: any = (cmd: string, args: string[]) => {
    calledCmd = cmd;
    calledArgs = args;
    return { on: () => {}, unref: () => {} };
  };

  const ok = sendDesktopNotification('agentlens Weekly', 'Report ready', 'win32', fakeSpawn);
  assert.equal(ok, true);
  assert.equal(calledCmd, 'powershell');
  assert.ok(calledArgs.includes('-NoProfile'));
  assert.ok(calledArgs.some((arg) => arg.includes('System.Windows.Forms.NotifyIcon')));
});

test('sendDesktopNotification: dispatches notify-send on Linux', () => {
  let calledCmd = '';
  let calledArgs: string[] = [];
  const fakeSpawn: any = (cmd: string, args: string[]) => {
    calledCmd = cmd;
    calledArgs = args;
    return { on: () => {}, unref: () => {} };
  };

  const ok = sendDesktopNotification('agentlens Weekly', 'Report ready', 'linux', fakeSpawn);
  assert.equal(ok, true);
  assert.equal(calledCmd, 'notify-send');
  assert.deepEqual(calledArgs, ['agentlens Weekly', 'Report ready']);
});

test('sendDesktopNotification: safely escapes quotes and special chars (Review Focus 3)', () => {
  let darwinScript = '';
  const fakeSpawnDarwin: any = (_cmd: string, args: string[]) => {
    darwinScript = args[1];
    return { on: () => {}, unref: () => {} };
  };
  sendDesktopNotification('Title with "quotes" and \'apostrophes\'', 'Line 1\nLine "2"', 'darwin', fakeSpawnDarwin);
  assert.ok(darwinScript.startsWith('display notification '));
  assert.doesNotThrow(() => JSON.parse(darwinScript.split('display notification ')[1].split(' with title ')[0]));

  let winScript = '';
  const fakeSpawnWin: any = (_cmd: string, args: string[]) => {
    winScript = args[args.indexOf('-Command') + 1];
    return { on: () => {}, unref: () => {} };
  };
  sendDesktopNotification('Title "test"', 'Body "test"', 'win32', fakeSpawnWin);
  assert.ok(winScript.includes('"Title \\"test\\""'));
});

test('sendDesktopNotification: returns false gracefully when spawn throws (Review Focus 5)', () => {
  const throwingSpawn: any = () => {
    throw new Error('EACCES spawn error');
  };
  const ok = sendDesktopNotification('Title', 'Body', 'darwin', throwingSpawn);
  assert.equal(ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test "test/notifications-crossplatform.test.ts"`
Expected: FAIL because `sendDesktopNotification` currently only supports `notify-send`.

- [ ] **Step 3: Implement cross-platform desktop notification in `src/report-scheduler.ts`**

Implement `sendDesktopNotification(title: string, body: string, platform = process.platform, spawnFn = spawn): boolean`:
- On `'darwin'`:
  AppleScript via `spawnFn('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`])`.
- On `'win32'`:
  PowerShell script using `System.Windows.Forms.NotifyIcon` with proper JSON-escaped string arguments for title and body.
- On default/`'linux'`:
  `spawnFn('notify-send', [title, body])`.
- Wrap in try/catch, attach `.on('error', () => {})`, unref, and return `true` on success, `false` on catch.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test "test/notifications-crossplatform.test.ts"`
Expected: PASS
Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/report-scheduler.ts test/notifications-crossplatform.test.ts
git commit -m "feat: add cross-platform desktop notifications for macOS, Windows, and Linux

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Cross-Platform Background Services (`agentlens install-service`)

**Files:**
- Modify: `src/cli.ts:104-126, 488`
- Create: `src/service.ts`
- Test: `test/service-crossplatform.test.ts`

**Interfaces:**
- Consumes: `process.platform`, `process.execPath`, `PlatformPaths`
- Produces:
  ```ts
  export interface ServiceConfigResult {
    platform: NodeJS.Platform;
    targetPath: string;
    content: string;
    enableCommand: string;
    auxiliaryPath?: string;
    auxiliaryContent?: string;
  }
  export function generateServiceConfig(
    platform: NodeJS.Platform,
    options: {
      nodePath: string;
      cliPath: string;
      stateDir: string;
      home: string;
      env?: NodeJS.ProcessEnv;
    }
  ): ServiceConfigResult;
  export function installService(options?: {
    platform?: NodeJS.Platform;
    home?: string;
    execPath?: string;
    cliPath?: string;
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
  }): { success: boolean; message: string };
  ```

- [ ] **Step 1: Write the failing test**

Create `test/service-crossplatform.test.ts`:
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { generateServiceConfig, installService } from '../src/service.ts';

test('generateServiceConfig: Linux produces valid systemd user service', () => {
  const res = generateServiceConfig('linux', {
    nodePath: '/usr/bin/node',
    cliPath: '/app/src/cli.ts',
    stateDir: '/home/user/.local/state/agentlens',
    home: '/home/user',
  });
  assert.equal(res.platform, 'linux');
  assert.equal(res.targetPath, '/home/user/.config/systemd/user/agentlens.service');
  assert.ok(res.content.includes('[Unit]'));
  assert.ok(res.content.includes('ExecStart="/usr/bin/node" --no-warnings=ExperimentalWarning "/app/src/cli.ts" serve'));
  assert.ok(res.enableCommand.includes('systemctl --user daemon-reload'));
});

test('generateServiceConfig: macOS produces valid launchd plist', () => {
  const res = generateServiceConfig('darwin', {
    nodePath: '/opt/homebrew/bin/node',
    cliPath: '/Users/macuser/agentlens/src/cli.ts',
    stateDir: '/Users/macuser/Library/Caches/agentlens',
    home: '/Users/macuser',
  });
  assert.equal(res.platform, 'darwin');
  assert.equal(res.targetPath, '/Users/macuser/Library/LaunchAgents/com.agentlens.plist');
  assert.ok(res.content.includes('<key>Label</key>'));
  assert.ok(res.content.includes('<string>com.agentlens</string>'));
  assert.ok(res.content.includes('/opt/homebrew/bin/node'));
  assert.ok(res.content.includes('/Users/macuser/Library/Caches/agentlens/agentlens.log'));
  assert.ok(res.enableCommand.includes('launchctl load -w'));
});

test('generateServiceConfig: Windows quotes paths with spaces (Review Focus 2)', () => {
  const res = generateServiceConfig('win32', {
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    cliPath: 'C:\\Users\\John Doe\\agentlens\\src\\cli.ts',
    stateDir: 'C:\\Users\\John Doe\\AppData\\Local\\agentlens\\state',
    home: 'C:\\Users\\John Doe',
    env: { LOCALAPPDATA: 'C:\\Users\\John Doe\\AppData\\Local' },
  });
  assert.equal(res.platform, 'win32');
  assert.ok(res.enableCommand.includes('schtasks /create /tn "agentlens"'));
  assert.ok(res.enableCommand.includes('"C:\\Program Files\\nodejs\\node.exe"'));
  assert.ok(res.auxiliaryPath);
  assert.ok(res.auxiliaryContent?.includes('"C:\\Program Files\\nodejs\\node.exe"'));
});

test('installService: writes files to disk cleanly on simulated platforms', () => {
  const tmpHome = join(process.cwd(), 'scratch/tmp-service-test');
  mkdirSync(tmpHome, { recursive: true });

  try {
    const res = installService({
      platform: 'darwin',
      home: tmpHome,
      execPath: '/usr/bin/node',
      cliPath: '/test/cli.ts',
      stateDir: join(tmpHome, 'Library/Caches/agentlens'),
    });
    assert.equal(res.success, true);
    assert.ok(existsSync(join(tmpHome, 'Library/LaunchAgents/com.agentlens.plist')));
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test "test/service-crossplatform.test.ts"`
Expected: FAIL because `src/service.ts` does not exist yet.

- [ ] **Step 3: Implement `src/service.ts` and connect to `src/cli.ts`**

1. Create `src/service.ts` with `generateServiceConfig` and `installService`.
   - On Linux: writes `~/.config/systemd/user/agentlens.service`.
   - On macOS: creates `~/Library/LaunchAgents/` and writes `com.agentlens.plist`.
   - On Windows: creates `%LOCALAPPDATA%\agentlens\agentlens-service.cmd` and outputs `schtasks` creation command.
   - Handles spaces in usernames and paths with robust quoting.
2. In `src/cli.ts`, replace inline `installService` with the one from `src/service.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test "test/service-crossplatform.test.ts"`
Expected: PASS
Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/service.ts src/cli.ts test/service-crossplatform.test.ts
git commit -m "feat: implement native background service installation for Linux, macOS, and Windows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Windows CLI Wrappers & Statusline Setup

**Files:**
- Create: `bin/agentlens.cmd`
- Create: `bin/agentlens.ps1`
- Modify: `src/cli.ts:478-486` (`install-statusline`)
- Test: `test/cli-wrappers.test.ts`

**Interfaces:**
- Consumes: `process.platform`
- Produces:
  - `bin/agentlens.cmd` executable batch wrapper
  - `bin/agentlens.ps1` executable PowerShell wrapper
  - `install-statusline` outputs `"command": "agentlens.cmd statusline"` on Win32 vs `"command": "agentlens statusline"` on Linux/macOS.

- [ ] **Step 1: Write the failing test**

Create `test/cli-wrappers.test.ts`:
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

test('bin/agentlens.cmd exists and contains proper node invocation with flags', () => {
  const cmdPath = join(process.cwd(), 'bin/agentlens.cmd');
  assert.ok(existsSync(cmdPath), 'bin/agentlens.cmd must exist');
  const content = readFileSync(cmdPath, 'utf-8');
  assert.ok(content.includes('@echo off'));
  assert.ok(content.includes('node --no-warnings=ExperimentalWarning'));
  assert.ok(content.includes('cli.ts'));
  assert.ok(content.includes('%*'));
});

test('bin/agentlens.ps1 exists and contains PowerShell script execution syntax', () => {
  const ps1Path = join(process.cwd(), 'bin/agentlens.ps1');
  assert.ok(existsSync(ps1Path), 'bin/agentlens.ps1 must exist');
  const content = readFileSync(ps1Path, 'utf-8');
  assert.ok(content.includes('node --no-warnings=ExperimentalWarning'));
  assert.ok(content.includes('cli.ts'));
  assert.ok(content.includes('@args'));
});

test('getStatuslineSnippet: outputs agentlens.cmd on Windows and agentlens on POSIX', async () => {
  const { getStatuslineSnippet } = await import('../src/cli.ts');
  const winSnippet = getStatuslineSnippet('win32');
  assert.ok(winSnippet.includes('"command": "agentlens.cmd statusline"'));

  const linuxSnippet = getStatuslineSnippet('linux');
  assert.ok(linuxSnippet.includes('"command": "agentlens statusline"'));

  const macSnippet = getStatuslineSnippet('darwin');
  assert.ok(macSnippet.includes('"command": "agentlens statusline"'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test "test/cli-wrappers.test.ts"`
Expected: FAIL because `bin/agentlens.cmd`, `bin/agentlens.ps1`, and `getStatuslineSnippet` do not exist.

- [ ] **Step 3: Create wrappers and export statusline snippet helper**

1. Create `bin/agentlens.cmd`:
   ```cmd
   @echo off
   node --no-warnings=ExperimentalWarning "%~dp0..\src\cli.ts" %*
   ```
2. Create `bin/agentlens.ps1`:
   ```powershell
   & node --no-warnings=ExperimentalWarning "$PSScriptRoot/../src/cli.ts" @args
   ```
3. In `src/cli.ts`, export `getStatuslineSnippet(platform = process.platform): string` and use it inside `'install-statusline'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test "test/cli-wrappers.test.ts"`
Expected: PASS
Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bin/agentlens.cmd bin/agentlens.ps1 src/cli.ts test/cli-wrappers.test.ts
git commit -m "feat: add Windows CLI wrappers and platform-aware statusline configuration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation & Verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: cross-platform CLI, service commands, and paths
- Produces: comprehensive documentation for Linux, macOS, and Windows users

- [ ] **Step 1: Update README.md with cross-platform instructions**

1. Document path locations across Linux, macOS, and Windows.
2. Document `agentlens install-service` behavior and startup commands for `systemd` (Linux), `launchd` (macOS), and `schtasks` (Windows).
3. Document statusline setup on Windows (`agentlens.cmd statusline`) vs macOS/Linux (`agentlens statusline`).
4. Document how OpenCode, Claude Code, Codex, and Antigravity log discovery works across all three platforms.

- [ ] **Step 2: Run all verifications**

Run: `npm test`
Expected: 125+ tests pass with 0 failures.
Run: `npm run typecheck`
Expected: Clean TypeScript check with 0 errors.

- [ ] **Step 3: Commit and push**

```bash
git add README.md
git commit -m "docs: document cross-platform usage for Linux, macOS, and Windows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin master
```
