import { execFile } from 'node:child_process';
import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Agent } from '../types.ts';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const TEMP_DIR_NAME = 'agentlens-ai';

const execFileAsync = promisify(execFile);
const agents = ['claude', 'codex', 'gemini', 'opencode'] as const;
export type AnalystAgent = Extract<Agent, typeof agents[number]>;
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

export async function detectAgents(exec: AnalystExec = execFileAsync): Promise<AnalystAgent[]> {
  const found: AnalystAgent[] = [];
  for (const agent of agents) {
    try {
      await exec('which', [agent], { encoding: 'utf8', shell: false, timeout: DEFAULT_TIMEOUT_MS });
      found.push(agent);
    } catch {}
  }
  return found;
}

export async function runAnalyst(prompt: string, opts: RunAnalystOptions): Promise<RunAnalystResult> {
  const start = Date.now();
  let outputDir: string | undefined;
  try {
    const cwd = join(tmpdir(), TEMP_DIR_NAME);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const override = process.env.AGENTLENS_AI_BIN_OVERRIDE;
    let args: string[];
    let outputFile: string | undefined;
    if (override) {
      args = [prompt];
    } else {
      switch (opts.agent) {
        case 'claude':
          args = ['-p', prompt, '--output-format', 'json', '--no-session-persistence', '--tools', ''];
          break;
        case 'codex':
          outputDir = await mkdtemp(join(cwd, 'codex-'));
          outputFile = join(outputDir, 'result.txt');
          args = ['exec', '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '-o', outputFile, prompt];
          break;
        case 'gemini':
          args = ['-p', prompt, '-o', 'json', '--approval-mode', 'plan'];
          break;
        case 'opencode':
          args = ['run', '--standalone', prompt];
          break;
        default:
          throw new Error('Unsupported analyst agent');
      }
      if (opts.model) args.push(opts.agent === 'claude' ? '--model' : '-m', opts.model);
    }
    const { stdout } = await (opts.exec ?? execFileAsync)(override || opts.agent, args, {
      cwd, encoding: 'utf8', shell: false,
      timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      ...(opts.agent === 'opencode' ? {
        env: { ...process.env, OPENCODE_CONFIG_CONTENT: '{"permission":"deny"}' },
      } : {}),
    });
    let text = outputFile ? await readFile(outputFile, 'utf8') : stdout;
    if (opts.agent === 'claude' || opts.agent === 'gemini') {
      const data = JSON.parse(text);
      if (!data || data.is_error || data.error) throw new Error('Agent returned an error');
      text = opts.agent === 'claude' ? data.result : data.response;
    }
    if (typeof text !== 'string' || !text.trim()) throw new Error('Agent returned no analysis text');
    return { ok: true, text, agent: opts.agent, durationMs: Date.now() - start };
  } catch (error) {
    return {
      ok: false, text: '', agent: opts.agent, durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : 'Analyst execution failed',
    };
  } finally {
    if (outputDir) {
      try { await rm(outputDir, { recursive: true, force: true }); } catch {}
    }
  }
}
