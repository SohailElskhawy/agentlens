import { createHash } from 'node:crypto';
import type { DB } from '../db.ts';
import { sessionDetail, sessionTimeline } from '../queries.ts';

export function redact(text: string): string {
  return text
    .replace(/\b(?:sk[-_](?:proj[-_])?[a-zA-Z0-9_-]{8,}|ghp_[a-zA-Z0-9_]{8,}|github_pat_[a-zA-Z0-9_]{8,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[REDACTED]')
    .replace(/(^|\n|\\n)[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*(?:(?!\\n)[^\r\n])*/g, '$1[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED]')
    .replace(/(?:\/home\/|\/Users\/)[^\s/\\"']+(?:\/[^\s"']*)?/g, '[REDACTED]')
    .replace(/\b[A-Za-z]:\\Users\\[^\s\\"']+(?:\\[^\s"']*)?/gi, '[REDACTED]');
}

export function buildPrompt(kind: string, data: unknown): { prompt: string; inputHash: string } {
  // Redact strings before JSON escapes newlines, then redact the serialized result too.
  const serialized = JSON.stringify(data, (key, value: unknown) => typeof value === 'string' ? redact(value) : value);
  let prompt = redact(`Analyze this ${kind} structured data. Return JSON {"summary":string,"causes":[{"cause":string,"evidence":string,"est_tokens":number}],"fixes":[{"action":string,"where":string,"snippet":string}]}\n${serialized}`);
  const marker = '\n[truncated]';
  if (prompt.length > 12000) prompt = prompt.slice(0, 12000 - marker.length) + marker;
  return { prompt, inputHash: createHash('sha256').update(prompt).digest('hex') };
}

const metadata = (value: unknown) => typeof value === 'string' && /^[\w.:-]{1,100}$/.test(value) ? value : null;

export function sessionDigest(db: DB, id: string) {
  const detail = sessionDetail(db, id);
  if (!detail) return null;
  const timeline = sessionTimeline(db, id);
  // Findings and tools come first and turns are capped so the 12k prompt cap never truncates the key signal.
  return {
    agent: metadata((detail as typeof detail & { agent: unknown }).agent),
    findings: timeline.markers.slice(0, 30).map(f => ({ rule: metadata(f.rule), turnIndex: f.turnIndex, estTokensWeek: f.estTokensWeek,
      evidence: { tool: metadata(f.evidence?.tool), count: typeof f.evidence?.count === 'number' ? f.evidence.count : null } })),
    tools: detail.tools.slice(0, 20).map(t => ({ tool: metadata(t.tool), calls: t.calls, resultBytes: t.resultBytes, errors: t.errors })),
    totals: { input: detail.totals.input, output: detail.totals.output, cacheRead: detail.totals.cacheRead,
      cacheWrite: detail.totals.cacheWrite, reasoning: detail.totals.reasoning },
    turnCount: timeline.turns.length,
    turns: timeline.turns.slice(0, 40).map(t => ({ model: metadata(t.model), input: t.input, output: t.output,
      cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, reasoning: t.reasoning, contextSize: t.contextSize })),
  };
}
