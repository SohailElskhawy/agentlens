import { createHash } from 'node:crypto';
import type { DB } from '../db.ts';
import type { Recommendation } from '../types.ts';
import { aiStatus } from './gate.ts';
import { redact } from './payload.ts';
import { buildAnalystCommand } from './runner.ts';
import { confirmedAnalysis } from './confirmed.ts';
import type { AnalysisPreview } from './confirmed.ts';
import type { DiagnosisErrorCode, DiagnosisRunner } from './diagnose.ts';

type Note = { id: string; aiBody?: string; aiActionSnippet?: string };
type Result = { recommendations: Recommendation[] } & (
  { status: 'ok'; cached: boolean } | { status: 'confirmation_required'; preview: AnalysisPreview } |
  { status: 'error'; code: DiagnosisErrorCode; message: string });
const fail = (recs: Recommendation[], code: DiagnosisErrorCode): Result => ({ status: 'error', code, message: code, recommendations: recs });
const safe = (s: string, max: number) => typeof s === 'string' && s.length > 0 && s.length <= max && /^[\w.:-]+$/.test(s) && redact(s) === s;

function prepare(db: DB, recs: Recommendation[], topN: number): AnalysisPreview | DiagnosisErrorCode {
  const status = aiStatus(db);
  if (status.error === 'AI_INVALID_SETTINGS' || !status.agent) return 'AI_INVALID_SETTINGS';
  const agent = status.agent === 'auto' ? 'claude' : status.agent;
  if (agent !== 'claude') return 'AI_PROVIDER_UNSUPPORTED';
  const data = recs.slice(0, topN).filter(r => safe(r.id, 200) && safe(r.findingRule, 100) && safe(r.action, 30))
    .map(r => ({ id: r.id, rule: r.findingRule, action: r.action, score: Number.isFinite(r.score) ? r.score : null }));
  const prompt = redact('Analyze these structured recommendation findings. Return a JSON array of objects with id, optional aiBody and optional aiActionSnippet. Use only the supplied IDs.\n' + JSON.stringify(data));
  const inputHash = createHash('sha256').update(prompt).digest('hex');
  const { bin, args } = buildAnalystCommand(prompt, { agent, model: status.model ?? undefined });
  const confirmationHash = createHash('sha256').update(JSON.stringify({ kind: 'recommendations', agent, model: status.model, bin, args })).digest('hex');
  return { agent, model: status.model, bin, args, prompt, inputHash, confirmationHash };
}
function parse(text: string, ids: Set<string>): Note[] | null {
  if (typeof text !== 'string' || text.length > 64000) return null;
  const body = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/i.exec(text)?.[1] ?? text;
  let raw: unknown; try { raw = JSON.parse(body); } catch { return null; }
  if (!Array.isArray(raw) || raw.length > ids.size) return null;
  const seen = new Set<string>(); const notes: Note[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !ids.has(item.id) || seen.has(item.id)
      || (item.aiBody === undefined && item.aiActionSnippet === undefined)
      || (item.aiBody !== undefined && (typeof item.aiBody !== 'string' || item.aiBody.length > 4000))
      || (item.aiActionSnippet !== undefined && (typeof item.aiActionSnippet !== 'string' || item.aiActionSnippet.length > 4000))) return null;
    seen.add(item.id); notes.push({ id: item.id, ...(item.aiBody !== undefined ? { aiBody: item.aiBody } : {}), ...(item.aiActionSnippet !== undefined ? { aiActionSnippet: item.aiActionSnippet } : {}) });
  }
  return notes;
}
function merge(recs: Recommendation[], notes: Note[]): Recommendation[] {
  const byId = new Map(notes.map(({ id, ...fields }) => [id, fields]));
  return recs.map(r => byId.has(r.id) ? { ...r, ...byId.get(r.id) } : r);
}
export function cachedRecommendations(db: DB, recs: Recommendation[], topN = 5): Recommendation[] {
  try {
    const status = aiStatus(db); if (status.error === 'AI_DISABLED' || status.error === 'AI_INVALID_SETTINGS') return recs;
    const preview = prepare(db, recs, topN); if (typeof preview === 'string') return recs;
    const row = db.prepare('SELECT text FROM ai_notes WHERE kind = ? AND input_hash = ? AND agent = ? AND model = ?').get('recommendations', preview.inputHash, preview.agent, preview.model ?? '') as { text: string } | undefined;
    const notes = row && parse(row.text, new Set(recs.slice(0, topN).filter(r => safe(r.id, 200) && safe(r.findingRule, 100) && safe(r.action, 30)).map(r => r.id)));
    return notes ? merge(recs, notes) : recs;
  } catch { return recs; }
}
export async function enrichRecommendations(db: DB, recs: Recommendation[], opts: { runner?: DiagnosisRunner; confirm?: string; now?: number; topN?: number; preview?: boolean } = {}): Promise<Result> {
  try {
    const topN = Math.max(0, Math.min(20, Number.isSafeInteger(opts.topN) ? opts.topN! : 5));
    const status = aiStatus(db, opts.now);
    if (!opts.preview && (status.error === 'AI_DISABLED' || status.error === 'AI_INVALID_SETTINGS')) return fail(recs, status.error);
    const preview = prepare(db, recs, topN); if (typeof preview === 'string') return fail(recs, preview);
    if (opts.preview) return { status: 'confirmation_required', preview, recommendations: recs };
    const ids = new Set(recs.slice(0, topN).filter(r => safe(r.id, 200) && safe(r.findingRule, 100) && safe(r.action, 30)).map(r => r.id));
    if (!ids.size) return { status: 'ok', cached: false, recommendations: recs };
    const result = await confirmedAnalysis(db, 'recommendations', preview, text => parse(text, ids), opts);
    if (result.status === 'error') return fail(recs, result.code);
    if (result.status === 'confirmation_required') return { ...result, preview, recommendations: recs };
    return { status: 'ok', cached: result.cached, recommendations: merge(recs, result.value) };
  } catch { return fail(recs, 'AI_RUN_FAILED'); }
}
