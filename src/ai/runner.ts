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
export type AnalystAgent = Extract<Agent, 'claude' | 'codex' | 'gemini' | 'opencode'>;
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

export async function runAnalyst(prompt: string, opts: RunAnalystOptions): Promise<RunAnalystResult> {
  const start = Date.now();
  let cwd: string | undefined;
  try {
    if (opts.agent !== 'claude') {
      return { ok: false, text: '', agent: opts.agent, durationMs: Date.now() - start, error: 'Analyst provider is not supported safely' };
    }
    cwd = await mkdtemp(join(tmpdir(), `${TEMP_DIR_NAME}-`));
    const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--safe-mode', '--restricted',
      '--strict-mcp-config', '--disable-slash-commands', '--tools', ''];
    if (opts.model) args.push(`--model=${opts.model}`);
    args.push('--', prompt);
    const { stdout } = await (opts.exec ?? execFileAsync)(opts.agent, args, {
      cwd, encoding: 'utf8', shell: false,
      timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
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
