import type { DB } from '../db.ts';
import { cached } from './cache.ts';
import { aiStatus, finalizeAiCall, reserveAiCall } from './gate.ts';
import { runAnalyst } from './runner.ts';
import type { DiagnosisRunner } from './diagnose.ts';
import type { AnalystAgent } from './runner.ts';

export interface AnalysisPreview { agent: AnalystAgent; model: string | null; bin: string; args: string[]; prompt: string; inputHash: string; confirmationHash: string }
type Failure = 'AI_DISABLED' | 'AI_INVALID_SETTINGS' | 'AI_DAILY_LIMIT' | 'AI_RUN_FAILED' | 'AI_INVALID_OUTPUT';
export async function confirmedAnalysis<T>(db: DB, kind: string, preview: AnalysisPreview, parse: (text: string) => T | null,
  opts: { confirm?: string; runner?: DiagnosisRunner; now?: number }): Promise<{ status: 'ok'; cached: boolean; value: T } | { status: 'confirmation_required' } | { status: 'error'; code: Failure; message?: string }> {
  try {
    const gate = aiStatus(db, opts.now);
    if (gate.error === 'AI_DISABLED' || gate.error === 'AI_INVALID_SETTINGS') return { status: 'error', code: gate.error };
    let failure: Failure | undefined; let message: string | undefined; let needsConsent = false; let ran = false;
    const result = await cached(db, kind, preview.inputHash, async () => {
      ran = true;
      if (opts.confirm !== preview.confirmationHash) { needsConsent = true; return { ok: false, text: '' }; }
      let reservation: number;
      try { reservation = reserveAiCall(db, { kind, agent: preview.agent, inputHash: preview.inputHash }, opts.now); }
      catch (e) {
        const code = (e as { code?: unknown } | null)?.code;
        failure = code === 'AI_DISABLED' || code === 'AI_DAILY_LIMIT' || code === 'AI_INVALID_SETTINGS' ? code : 'AI_RUN_FAILED';
        return { ok: false, text: '' };
      }
      const start = Date.now(); let value: T | null = null;
      try {
        const run = await (opts.runner ?? runAnalyst)(preview.prompt, { agent: preview.agent, model: preview.model ?? undefined });
        value = run.ok ? parse(run.text) : null;
        if (run.capabilityFailed) message = 'Claude CLI safety capability check failed; upgrade Claude Code and try again';
        if (value === null) failure = run.ok ? 'AI_INVALID_OUTPUT' : 'AI_RUN_FAILED';
      } catch { failure = 'AI_RUN_FAILED'; }
      try { finalizeAiCall(db, reservation, value !== null, Date.now() - start); } catch {}
      return value !== null ? { ok: true, text: JSON.stringify(value) } : { ok: false, text: '' };
    }, { agent: preview.agent, model: preview.model });
    if (needsConsent) return { status: 'confirmation_required' };
    if (failure) return { status: 'error', code: failure, ...(message ? { message } : {}) };
    const value = result.ok ? parse(result.text) : null;
    return value !== null ? { status: 'ok', cached: !ran, value } : { status: 'error', code: 'AI_INVALID_OUTPUT' };
  } catch { return { status: 'error', code: 'AI_RUN_FAILED' }; }
}
