import { execFile } from 'node:child_process';
import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Agent } from '../types.ts';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const TEMP_DIR_NAME = 'agentlens-ai';

const execFileAsync = promisify(execFile);
// Other CLIs cannot reliably disable all configured hooks, plugins, and tools.
const agents = ['claude'] as const;
const safetyArgs = ['--no-session-persistence', '--safe-mode', '--restricted', '--strict-mcp-config',
  '--disable-slash-commands', '--tools', ''];
const requiredOptions = ['--print', '--output-format', '--no-session-persistence', '--safe-mode', '--restricted',
  '--strict-mcp-config', '--disable-slash-commands', '--tools'];
export type AnalystAgent = Extract<Agent, 'claude' | 'codex' | 'gemini' | 'opencode'>;

export interface ProviderIsolation {
  agent: AnalystAgent;
  supported: boolean;
  disablesTools: boolean;
  disablesHooksAndExtensions: boolean;
  ephemeralSession: boolean;
  preservesSubscriptionAuth: boolean;
  verifiedFlags: readonly string[];
  missingGuarantees: readonly string[];
  reason: string;
}

export const PROVIDER_ISOLATION: Record<AnalystAgent, ProviderIsolation> = {
  claude: {
    agent: 'claude',
    supported: true,
    disablesTools: true,
    disablesHooksAndExtensions: true,
    ephemeralSession: true,
    preservesSubscriptionAuth: true,
    verifiedFlags: ['-p', '--output-format', 'json', ...safetyArgs],
    missingGuarantees: [],
    reason: 'Isolated via --no-session-persistence, --safe-mode, --restricted, --strict-mcp-config, --disable-slash-commands, and --tools "" with pre-flight --help capability probe.',
  },
  codex: {
    agent: 'codex',
    supported: false,
    disablesTools: false,
    disablesHooksAndExtensions: true,
    ephemeralSession: true,
    preservesSubscriptionAuth: true,
    verifiedFlags: ['exec', '-s', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check'],
    missingGuarantees: [
      'no CLI flag to disable built-in shell/read tools (--tools "")',
      'read-only sandbox still allows model-generated shell commands and disk reads',
    ],
    reason: 'Codex CLI (codex exec -s read-only --ephemeral --ignore-user-config --ignore-rules) lacks a flag to disable built-in shell/file tools entirely.',
  },
  gemini: {
    agent: 'gemini',
    supported: false,
    disablesTools: false,
    disablesHooksAndExtensions: false,
    ephemeralSession: false,
    preservesSubscriptionAuth: true,
    verifiedFlags: ['-p', '-o', 'json', '--approval-mode', 'plan'],
    missingGuarantees: [
      'no --no-session-persistence flag (writes ~/.gemini/history and session logs)',
      'loads all extensions by default unless restricted',
      'plan mode still permits read-only file/search/MCP tools',
    ],
    reason: 'Gemini CLI lacks session-persistence suppression and tool-free isolation in plan mode.',
  },
  opencode: {
    agent: 'opencode',
    supported: false,
    disablesTools: false,
    disablesHooksAndExtensions: false,
    ephemeralSession: false,
    preservesSubscriptionAuth: true,
    verifiedFlags: ['run', '--standalone', '--format', 'json'],
    missingGuarantees: [
      'no --ephemeral or --no-session-persistence flag (writes opencode.db)',
      'no CLI flags to disable configured tools, plugins, skills, or MCP servers',
    ],
    reason: 'OpenCode CLI persists sessions to SQLite and lacks CLI flags to disable tools, plugins, skills, or MCP servers.',
  },
};

export function getProviderIsolation(agent: AnalystAgent): ProviderIsolation {
  return PROVIDER_ISOLATION[agent];
}

export type AnalystExec = (
  bin: string, args: string[], options: ExecFileOptionsWithStringEncoding,
) => Promise<{ stdout: string; stderr: string }>;

export interface RunAnalystOptions {
  agent: AnalystAgent;
  model?: string;
  timeout?: number;
  exec?: AnalystExec;
}

export interface RunAnalystResult {
  ok: boolean;
  text: string;
  agent: AnalystAgent;
  durationMs: number;
  error?: string;
  capabilityFailed?: boolean;
}

export async function detectAgents(exec: AnalystExec = execFileAsync, platform: NodeJS.Platform = process.platform): Promise<AnalystAgent[]> {
  const found: AnalystAgent[] = [];
  for (const agent of agents) {
    try {
      await exec(platform === 'win32' ? 'where.exe' : 'which', [agent], { encoding: 'utf8', shell: false, timeout: DEFAULT_TIMEOUT_MS });
      found.push(agent);
    } catch {}
  }
  return found;
}

export function buildAnalystArgs(prompt: string, opts: { agent: AnalystAgent; model?: string }): string[] {
  if (!PROVIDER_ISOLATION[opts.agent]?.supported) throw new Error('Analyst provider is not supported safely');
  const args = ['-p', '--output-format', 'json', ...safetyArgs];
  if (opts.model) args.push(`--model=${opts.model}`);
  args.push('--', prompt);
  return args;
}

export function buildAnalystCommand(prompt: string, opts: { agent: AnalystAgent; model?: string }): { bin: string; args: string[] } {
  return { bin: opts.agent, args: buildAnalystArgs(prompt, opts) };
}

export async function runAnalyst(prompt: string, opts: RunAnalystOptions): Promise<RunAnalystResult> {
  const start = Date.now();
  let cwd: string | undefined;
  try {
    if (!PROVIDER_ISOLATION[opts.agent]?.supported) {
      return { ok: false, text: '', agent: opts.agent, durationMs: Date.now() - start, error: 'Analyst provider is not supported safely' };
    }
    cwd = await mkdtemp(join(tmpdir(), `${TEMP_DIR_NAME}-`));
    const { bin, args } = buildAnalystCommand(prompt, opts);
    const exec = opts.exec ?? execFileAsync;
    const options: ExecFileOptionsWithStringEncoding = {
      cwd, encoding: 'utf8', shell: false,
      timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    };
    try {
      const help = await exec(bin, [...safetyArgs, '--help'], options);
      if (!requiredOptions.every(flag => new RegExp(`^[ \\t]+(?:-\\w,[ \\t]+)?${flag}(?=[ \\t,]|$)`, 'm').test(help.stdout))) {
        throw new Error('Missing required option');
      }
    } catch {
      return { ok: false, text: '', agent: opts.agent, durationMs: Date.now() - start,
        error: 'Claude CLI safety capability check failed; upgrade Claude Code and try again', capabilityFailed: true };
    }
    const { stdout } = await exec(bin, args, options);
    const data = JSON.parse(stdout);
    if (!data || data.is_error || data.error) throw new Error('Agent returned an error');
    const text = data.result;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Agent returned no analysis text');
    return { ok: true, text, agent: opts.agent, durationMs: Date.now() - start };
  } catch (error) {
    let message = 'Analyst execution failed';
    if (error && typeof error === 'object') {
      if ('killed' in error && error.killed === true) message = 'Analyst timed out';
      else if ('code' in error) {
        if (error.code === 'ENOENT') message = 'Analyst executable not found';
        else if (error.code === 'EACCES') message = 'Analyst executable permission denied';
        else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') message = 'Analyst output exceeded the limit';
        else if (typeof error.code === 'number' && Number.isSafeInteger(error.code)) message = `Analyst exited with code ${error.code}`;
      }
    }
    return {
      ok: false, text: '', agent: opts.agent, durationMs: Date.now() - start,
      error: message,
    };
  } finally {
    if (cwd) {
      try { await rm(cwd, { recursive: true, force: true }); } catch {}
    }
  }
}
