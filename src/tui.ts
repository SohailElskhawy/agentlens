import { readFileSync } from 'node:fs';
import type { SummaryData } from './summary.ts';
import { formatTokens } from './summary.ts';

export const NO_SUMMARY_MARKER = 'agentlens: no summary cache yet (run agentlens serve)';

export function renderTui(data: SummaryData | null): string {
  if (!data) return NO_SUMMARY_MARKER + '\n';
  const lines: string[] = [];
  const today = data.totals?.tokensToday;
  const burn = data.totals?.burnRateTokensPerHour;
  lines.push(
    `agentlens · tokens today ${today == null ? '--' : formatTokens(today)}` +
    ` · burn ${burn == null ? '--' : formatTokens(burn)}/h`,
  );

  for (const agent of ['claude', 'codex'] as const) {
    const q = data.quotas?.[agent];
    if (!q) continue;
    const parts: string[] = [];
    for (const win of ['5h', '7d'] as const) {
      const v = q[win];
      if (typeof v === 'number') parts.push(`${win} ${Math.round(v)}%`);
    }
    if (parts.length) lines.push(`${agent} quota: ${parts.join(' · ')}`);
  }

  for (const [root, p] of Object.entries(data.projects ?? {})) {
    let line = `${p.name} (${root}) · ${formatTokens(p.tokensToday)} tokens today`;
    if (p.contextWarning) line += ` · ${p.contextWarning}`;
    lines.push(line);
  }

  return lines.join('\n') + '\n';
}

export interface TuiStdout {
  write(s: string): void;
  isTTY?: boolean;
}

export interface TuiOptions {
  summaryPath: string;
  stdout: TuiStdout;
  intervalMs?: number;
  setInterval: (fn: () => void, ms: number) => string | number | NodeJS.Timeout;
  clearInterval: (handle: string | number | NodeJS.Timeout | undefined) => void;
}

function readSummaryCache(summaryPath: string): SummaryData | null {
  let raw: string;
  try {
    raw = readFileSync(summaryPath, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as SummaryData;
  } catch {
    return null;
  }
}

export function startTui(options: TuiOptions): () => void {
  const { summaryPath, stdout, intervalMs = 60_000, setInterval, clearInterval } = options;
  const data = readSummaryCache(summaryPath);
  if (!data) {
    stdout.write(renderTui(null));
    return () => {};
  }
  stdout.write(renderTui(data));
  if (!stdout.isTTY) return () => {};

  // No raw mode and no alternate screen in this slice, so there is no terminal state to restore:
  // the default SIGINT exit plus a cleared interval is all the cleanup needed.
  const handle = setInterval(() => {
    stdout.write(renderTui(readSummaryCache(summaryPath)));
  }, intervalMs);
  return () => {
    clearInterval(handle);
  };
}
