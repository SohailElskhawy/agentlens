import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { Agent } from './types.ts';
import type { DB } from './db.ts';
import { getSetting } from './db.ts';

const execFileAsync = promisify(execFile);

let isRunningFix = false;

export interface RunFixOptions {
  agent: Agent;
  prompt: string;
  projectId: number;
  projectPath: string;
  headless?: boolean;
}

export interface RunFixResult {
  ok: boolean;
  mode: 'terminal' | 'headless';
  command: string;
  terminal?: string;
  diffStat?: string;
  output?: string;
  error?: string;
}

export function isAnyFixRunning(): boolean {
  return isRunningFix;
}

/**
 * Discovers available graphical terminal emulator on the local Linux/Unix environment.
 */
export async function detectTerminalEmulator(): Promise<{ bin: string; makeArgs: (cliArgs: string[]) => string[] } | null> {
  const envTerm = process.env.TERMINAL;
  const candidates: Array<{ bin: string; makeArgs: (args: string[]) => string[] }> = [];

  if (envTerm) {
    candidates.push({ bin: envTerm, makeArgs: (args) => ['-e', ...args] });
  }

  candidates.push(
    { bin: 'x-terminal-emulator', makeArgs: (args) => ['-e', ...args] },
    { bin: 'gnome-terminal', makeArgs: (args) => ['--', ...args] },
    { bin: 'konsole', makeArgs: (args) => ['-e', ...args] },
    { bin: 'kitty', makeArgs: (args) => [...args] },
    { bin: 'alacritty', makeArgs: (args) => ['-e', ...args] },
  );

  for (const c of candidates) {
    try {
      await execFileAsync('which', [c.bin]);
      return c;
    } catch {}
  }
  return null;
}

/**
 * Builds the binary name and argument array for the given agent CLI.
 * Strictly uses argument arrays; never constructs a shell command string.
 */
export function buildAgentCommand(agent: Agent, prompt: string, headless = false): { bin: string; args: string[] } {
  const overrideBin = process.env.AGENTLENS_FIX_BIN_OVERRIDE;
  if (overrideBin) {
    return { bin: overrideBin, args: [prompt] };
  }

  switch (agent) {
    case 'claude':
      return headless
        ? { bin: 'claude', args: ['-p', prompt] }
        : { bin: 'claude', args: [prompt] };
    case 'codex':
      return headless
        ? { bin: 'codex', args: ['exec', prompt] }
        : { bin: 'codex', args: [prompt] };
    case 'opencode':
      return { bin: 'opencode', args: ['run', prompt] };
    case 'antigravity':
    default:
      return { bin: 'claude', args: [prompt] };
  }
}

/**
 * Spawns an agent CLI to apply a fix prompt in the given project workspace.
 */
export async function runFix(db: DB, options: RunFixOptions): Promise<RunFixResult> {
  // 1. Safety check: setting must be enabled
  const allowed = getSetting(db, 'allow_agent_launch') === 'true';
  if (!allowed) {
    throw new Error('Permission denied: Launching agents is disabled. Enable "Allow agentlens to launch agents" in Settings.');
  }

  // 2. Safety check: project path must be known to agentlens
  const proj = db.prepare('SELECT id, root FROM projects WHERE id = ?').get(options.projectId) as { id: number; root: string } | undefined;
  if (!proj || proj.root !== options.projectPath) {
    throw new Error('Permission denied: Project path is not registered in agentlens.');
  }
  if (!existsSync(options.projectPath)) {
    throw new Error(`Project directory does not exist on disk: ${options.projectPath}`);
  }

  // 3. Concurrency check: rate-limit to one run at a time
  if (isRunningFix) {
    throw new Error('Another fix run is currently in progress. Please wait for it to complete.');
  }

  isRunningFix = true;
  try {
    const { bin, args } = buildAgentCommand(options.agent, options.prompt, options.headless ?? false);
    const commandDisplay = `${bin} ${args.map((a) => (a.includes(' ') ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')}`;

    if (options.headless) {
      // Headless execution mode
      let stdout = '';
      let stderr = '';
      try {
        const res = await execFileAsync(bin, args, {
          cwd: options.projectPath,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 120_000,
        });
        stdout = res.stdout;
        stderr = res.stderr;
      } catch (err: any) {
        stderr = err.stderr || err.message;
      }

      // Check git diff --stat in project directory
      let diffStat = '';
      try {
        const diffRes = await execFileAsync('git', ['diff', '--stat'], { cwd: options.projectPath });
        diffStat = diffRes.stdout.trim();
      } catch {}

      return {
        ok: true,
        mode: 'headless',
        command: commandDisplay,
        diffStat,
        output: (stdout + (stderr ? `\nErrors:\n${stderr}` : '')).trim(),
      };
    }

    // Default mode: open in terminal emulator
    const term = await detectTerminalEmulator();
    if (!term) {
      // If no GUI terminal is found, fall back to headless execution
      return await runFix(db, { ...options, headless: true });
    }

    const termArgs = term.makeArgs([bin, ...args]);
    const child = spawn(term.bin, termArgs, {
      cwd: options.projectPath,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    return {
      ok: true,
      mode: 'terminal',
      command: `${term.bin} ${termArgs.join(' ')}`,
      terminal: term.bin,
    };
  } finally {
    isRunningFix = false;
  }
}
