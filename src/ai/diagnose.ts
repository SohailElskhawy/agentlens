import { createHash } from 'node:crypto';
import type { DB } from '../db.ts';
import { cached } from './cache.ts';
import { aiStatus, finalizeAiCall, reserveAiCall } from './gate.ts';
import type { AiErrorCode } from './gate.ts';
import { buildPrompt, sessionDigest } from './payload.ts';
import { buildAnalystCommand, runAnalyst } from './runner.ts';
import type { AnalystAgent } from './runner.ts';

export interface Diagnosis {
  summary: string;
  causes: { cause: string; evidence: string; est_tokens: number }[];
  fixes: { action: string; where: string; snippet: string }[];
}

// Everything that leaves the machine, and nothing that varies per call (no clocks, no temp cwd).
export interface DiagnosisPreview {
  sessionId: string;
  agent: AnalystAgent;
  model: string | null;
  bin: string;
  args: string[];
  prompt: string;
  inputHash: string; // redacted prompt hash: cache and call-log identity
  confirmationHash: string; // binds consent to the exact command, provider and model
}

export type DiagnosisErrorCode = AiErrorCode | 'UNKNOWN_SESSION' | 'AI_PROVIDER_UNSUPPORTED' | 'AI_RUN_FAILED' | 'AI_INVALID_OUTPUT';
export type DiagnosisError = { status: 'error'; code: DiagnosisErrorCode; message: string };
export type PrepareResult = { status: 'ready'; preview: DiagnosisPreview } | DiagnosisError;
export type DiagnosisResult =
  | { status: 'ok'; cached: boolean; diagnosis: Diagnosis }
  | { status: 'confirmation_required'; preview: DiagnosisPreview }
  | DiagnosisError;

export type DiagnosisRunner = (prompt: string, opts: { agent: AnalystAgent; model?: string }) => Promise<{ ok: boolean; text: string }>;

const MESSAGES: Record<DiagnosisErrorCode, string> = {
  UNKNOWN_SESSION: 'Unknown session ID',
  AI_DISABLED: 'AI is disabled; run `agentlens ai enable` to opt in',
  AI_DAILY_LIMIT: 'AI daily call limit reached',
  AI_INVALID_SETTINGS: 'Invalid AI settings',
  AI_PROVIDER_UNSUPPORTED: 'Analyst provider is not supported safely',
  AI_RUN_FAILED: 'AI analysis failed',
  AI_INVALID_OUTPUT: 'AI output did not match the expected diagnosis schema',
};
const fail = (code: DiagnosisErrorCode): DiagnosisError => ({ status: 'error', code, message: MESSAGES[code] });

/** Builds the exact, read-only preview for a session; shared by `ai preview`, `diagnose --preview` and execution. */
export function prepareDiagnosis(db: DB, id: string): PrepareResult {
  const digest = sessionDigest(db, id);
  if (!digest) return fail('UNKNOWN_SESSION');
  const status = aiStatus(db);
  if (status.error === 'AI_INVALID_SETTINGS' || !status.agent) return fail('AI_INVALID_SETTINGS');
  const agent = status.agent === 'auto' ? 'claude' : status.agent;
  if (agent !== 'claude') return fail('AI_PROVIDER_UNSUPPORTED');
  const { prompt, inputHash } = buildPrompt('diagnose', digest);
  const { bin, args } = buildAnalystCommand(prompt, { agent, model: status.model ?? undefined });
  // args already contain the prompt, so hashing the command binds prompt, provider and model.
  const confirmationHash = createHash('sha256').update(JSON.stringify({ kind: 'diagnose', agent, model: status.model, bin, args })).digest('hex');
  return { status: 'ready', preview: { sessionId: id, agent, model: status.model, bin, args, prompt, inputHash, confirmationHash } };
}

const MAX_RAW = 64_000;
const MAX_ITEMS = 20;
const MAX_FIELD = 2000;
const MAX_LONG = 4000;
const str = (v: unknown, max = MAX_FIELD): v is string => typeof v === 'string' && v.length <= max;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Accepts plain or fenced JSON in the exact diagnosis shape; returns the normalized value or null. */
export function parseDiagnosis(text: string): Diagnosis | null {
  if (typeof text !== 'string' || text.length > MAX_RAW) return null;
  const body = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/i.exec(text)?.[1] ?? text;
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { return null; }
  if (!obj(raw) || !str(raw.summary, MAX_LONG) || !Array.isArray(raw.causes) || !Array.isArray(raw.fixes)
    || raw.causes.length > MAX_ITEMS || raw.fixes.length > MAX_ITEMS) return null;
  const causes: Diagnosis['causes'] = [];
  for (const c of raw.causes) {
    if (!obj(c) || !str(c.cause) || !str(c.evidence) || typeof c.est_tokens !== 'number' || !Number.isFinite(c.est_tokens) || c.est_tokens < 0) return null;
    causes.push({ cause: c.cause, evidence: c.evidence, est_tokens: c.est_tokens });
  }
  const fixes: Diagnosis['fixes'] = [];
  for (const f of raw.fixes) {
    if (!obj(f) || !str(f.action) || !str(f.where) || !str(f.snippet, MAX_LONG)) return null;
    fixes.push({ action: f.action, where: f.where, snippet: f.snippet });
  }
  return { summary: raw.summary, causes, fixes };
}

/**
 * Runs one diagnosis. A validated cached result is returned without consent or a new reservation (AI must be
 * enabled with valid settings). Otherwise the exact preview hash must be confirmed; the call is reserved before the
 * runner is awaited and always finalized. Errors never echo the command, prompt or model output.
 */
export async function diagnoseSession(db: DB, id: string,
  opts: { confirm?: string; runner?: DiagnosisRunner; now?: number } = {}): Promise<DiagnosisResult> {
  try {
    const prepared = prepareDiagnosis(db, id);
    if (prepared.status === 'error') return prepared;
    const { preview } = prepared;
    const gate = aiStatus(db, opts.now);
    if (gate.error === 'AI_DISABLED' || gate.error === 'AI_INVALID_SETTINGS') return fail(gate.error);
    const runner = opts.runner ?? runAnalyst;
    let outcome = undefined as DiagnosisResult | undefined;
    let ran = false;
    const result = await cached(db, 'diagnose', preview.inputHash, async () => {
      ran = true;
      if (opts.confirm !== preview.confirmationHash) {
        outcome = { status: 'confirmation_required', preview };
        return { ok: false, text: '' };
      }
      let reservation: number;
      try {
        reservation = reserveAiCall(db, { kind: 'diagnose', agent: preview.agent, inputHash: preview.inputHash }, opts.now);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        outcome = fail(code === 'AI_DISABLED' || code === 'AI_DAILY_LIMIT' || code === 'AI_INVALID_SETTINGS' ? code : 'AI_RUN_FAILED');
        return { ok: false, text: '' };
      }
      const start = Date.now();
      let diagnosis: Diagnosis | null = null;
      try {
        const run = await runner(preview.prompt, { agent: preview.agent, model: preview.model ?? undefined });
        diagnosis = run.ok ? parseDiagnosis(run.text) : null;
        if (!diagnosis) outcome = fail(run.ok ? 'AI_INVALID_OUTPUT' : 'AI_RUN_FAILED');
      } catch {
        outcome = fail('AI_RUN_FAILED');
      }
      try { finalizeAiCall(db, reservation, diagnosis !== null, Date.now() - start); } catch {}
      return diagnosis ? { ok: true, text: JSON.stringify(diagnosis) } : { ok: false, text: '' };
    }, { agent: preview.agent, model: preview.model });
    if (outcome) return outcome;
    const diagnosis = result.ok ? parseDiagnosis(result.text) : null;
    return diagnosis ? { status: 'ok', cached: !ran, diagnosis } : fail('AI_INVALID_OUTPUT');
  } catch {
    return fail('AI_RUN_FAILED');
  }
}

/** Session ids ordered by the summed deterministic finding estimates (ties by id), optionally within one project. */
export function worstSessions(db: DB, limit: number, projectId?: number): string[] {
  const rows = db.prepare(`SELECT f.session_id AS id FROM findings f JOIN sessions s ON s.id = f.session_id
    WHERE (? IS NULL OR COALESCE(f.project_id, s.project_id) = ?)
    GROUP BY f.session_id ORDER BY sum(f.est_tokens_week) DESC, f.session_id ASC LIMIT ?`)
    .all(projectId ?? null, projectId ?? null, limit) as { id: string }[];
  return rows.map(r => r.id);
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function renderDiagnosisMarkdown(d: Diagnosis): string {
  const out = [d.summary, ''];
  if (d.causes.length) {
    out.push('### Likely causes', '');
    for (const c of d.causes) out.push(`- **${oneLine(c.cause)}**: ${oneLine(c.evidence)} (AI estimate: ~${Math.round(c.est_tokens).toLocaleString('en-US')} tokens)`);
    out.push('');
  }
  if (d.fixes.length) {
    out.push('### Suggested fixes', '');
    for (const f of d.fixes) {
      out.push(`- ${oneLine(f.action)} (${oneLine(f.where)})`);
      if (f.snippet.trim()) {
        const fence = '`'.repeat(Math.max(3, ...[...f.snippet.matchAll(/`+/g)].map(m => m[0].length + 1)));
        out.push('', fence, f.snippet, fence, '');
      }
    }
  }
  out.push('_AI-generated from structured session metadata. Token figures are unverified model estimates, not measurements; deterministic findings and recommendations are unchanged._');
  return out.join('\n');
}
