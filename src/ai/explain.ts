import { createHash } from 'node:crypto';
import type { DB } from '../db.ts';
import { detectAnomalies, formatLocalDay } from '../anomaly.ts';
import { confirmedAnalysis } from './confirmed.ts';
import { aiStatus } from './gate.ts';
import { redact, sessionDigest } from './payload.ts';
import { buildAnalystCommand } from './runner.ts';
import type { DiagnosisRunner } from './diagnose.ts';

const error = (code: string, message: string) => ({ status: 'error' as const, code, message });
const errors: Record<string, string> = {
  AI_DISABLED: 'AI is disabled; run `agentlens ai enable` to opt in', AI_INVALID_SETTINGS: 'Invalid AI settings',
  AI_DAILY_LIMIT: 'AI daily call limit reached', AI_PROVIDER_UNSUPPORTED: 'Analyst provider is not supported safely',
  AI_RUN_FAILED: 'AI analysis failed', AI_INVALID_OUTPUT: 'AI output did not match the expected explanation schema',
};
export function prepareExplanation(db: DB, day: string, project: string, opts: { agent?: string; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return error('INVALID_DATE', 'Invalid local date');
  const [year, month, date] = day.split('-').map(Number);
  const start = new Date(year, month - 1, date);
  if (formatLocalDay(start) !== day || start.getTime() > now) return error('INVALID_DATE', 'Invalid or future local date');
  const end = new Date(year, month - 1, date + 1).getTime() - 1;
  const asOf = Math.min(now, end);
  const anomalies = detectAnomalies(db, {}, asOf).anomalies.filter(a =>
    ((project === 'null' || /^\d+$/.test(project)) ? String(a.projectId) === project : a.project === project) && (!opts.agent || a.agent === opts.agent));
  if (!anomalies.length) return error('UNKNOWN_ANOMALY', 'No detected anomaly matches that date and project');
  if (anomalies.length !== 1) return error('AMBIGUOUS_ANOMALY', 'Multiple anomalies match; specify project ID and agent');
  const anomaly = anomalies[0];
  const status = aiStatus(db, now);
  if (status.error === 'AI_INVALID_SETTINGS' || !status.agent) return error('AI_INVALID_SETTINGS', errors.AI_INVALID_SETTINGS);
  const agent = status.agent === 'auto' ? 'claude' : status.agent;
  if (agent !== 'claude') return error('AI_PROVIDER_UNSUPPORTED', errors.AI_PROVIDER_UNSUPPORTED);
  const data = {
    day, projectId: anomaly.projectId, agent: anomaly.agent, tokens: anomaly.tokens, baselineMedian: anomaly.baselineMedian,
    baselineSamples: anomaly.baselineSamples, ratio: anomaly.ratio,
    contributors: anomaly.topSessions.map(s => ({ tokens: s.tokens, events: s.events, digest: sessionDigest(db, s.sessionId) })),
  };
  // Drop detail at structural boundaries, so even a very large digest remains valid JSON.
  const instruction = 'Explain this detected token spike using only the structured data. State uncertainty; do not claim a proven cause. Return JSON {"explanation":string} with one concise paragraph.\n';
  const serialize = () => redact(JSON.stringify(data, (_key, value: unknown) => typeof value === 'string' ? redact(value) : value));
  let json = serialize();
  while (instruction.length + json.length > 12000 && data.contributors.length) {
    const digest = data.contributors.find(c => c.digest && c.digest.turns.length)?.digest;
    if (digest) digest.turns.pop();
    else data.contributors.pop();
    json = serialize();
  }
  const prompt = instruction + json;
  const inputHash = createHash('sha256').update(prompt).digest('hex');
  const { bin, args } = buildAnalystCommand(prompt, { agent, model: status.model ?? undefined });
  const confirmationHash = createHash('sha256').update(JSON.stringify({ kind: 'explain', agent, model: status.model, bin, args })).digest('hex');
  return { status: 'ready' as const, preview: { agent, model: status.model, bin, args, prompt, inputHash, confirmationHash } };
}
export function parseExplanation(text: string): { explanation: string } | null {
  if (typeof text !== 'string' || text.length > 5000) return null;
  const body = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/i.exec(text)?.[1] ?? text;
  try {
    const value = JSON.parse(body);
    if (!value || typeof value.explanation !== 'string' || !value.explanation.trim() || value.explanation.length > 2000 || /[\r\n]/.test(value.explanation)) return null;
    return { explanation: value.explanation.trim() };
  } catch { return null; }
}
export async function explainAnomaly(db: DB, day: string, project: string,
  opts: { agent?: string; now?: number; confirm?: string; runner?: DiagnosisRunner } = {}) {
  try {
    const prepared = prepareExplanation(db, day, project, opts);
    if (prepared.status === 'error') return prepared;
    const result = await confirmedAnalysis(db, 'explain', prepared.preview, parseExplanation, opts);
    if (result.status === 'confirmation_required') return { status: result.status, preview: prepared.preview };
    if (result.status === 'error') return error(result.code, errors[result.code]);
    return { status: 'ok' as const, cached: result.cached, ...result.value };
  } catch { return error('AI_RUN_FAILED', errors.AI_RUN_FAILED); }
}
