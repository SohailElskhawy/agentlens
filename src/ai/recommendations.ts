import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { getFindings, getRecommendations } from '../db.ts';
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

const evidenceKeys: Record<string, string[]> = {
  retry_loop: ['tool', 'count'], hot_files: ['reads'], large_tool_output: ['resultBytes'],
  repeated_prompt: ['sessionCount'], model_fit: ['model', 'outputTokens'],
  handoff: ['previousAgent', 'currentAgent', 'gapMinutes'], subagent_share: ['inputTokens', 'outputTokens'],
  quota_pressure: ['agent', 'window', 'usedPct'], cross_agent_balance: ['tightAgent', 'altAgent', 'window'],
  instruction_bloat: ['fixedTokens'], unused_config: ['kind', 'name', 'agent'], duplicate_config: ['kind', 'name', 'sources'],
};
const bounded = (value: unknown, max: number) => typeof value === 'string' ? redact(value).replace(/~\/(?:[^\s"']+)/g, '[REDACTED]').slice(0, max) : '';
function readProjectFile(root: string, path: string): string | null {
  let fd: number | undefined;
  try {
    const resolved = realpathSync(path); const rel = relative(root, resolved);
    if (!rel || rel.startsWith('..' + '/') || rel === '..' || isAbsolute(rel)) return null;
    fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 65536) return null;
    // Read no more than the checked size even if the file grows after fstat.
    const buffer = Buffer.alloc(stat.size);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString('utf8');
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
function projectContext(db: DB, id: number) {
  try {
    const row = db.prepare('SELECT root FROM projects WHERE id = ?').get(id) as { root: string } | undefined;
    if (!row) return null;
    const root = realpathSync(row.root);
    const raw = readProjectFile(root, join(root, 'package.json'));
    let dependencies: string[] = []; let scripts: string[] = [];
    if (raw) try {
      const pkg = JSON.parse(raw);
      const names = (obj: unknown) => obj && typeof obj === 'object' && !Array.isArray(obj)
        ? Object.keys(obj).filter(name => /^[\w@/.-]{1,100}$/.test(name) && redact(name) === name).sort() : [];
      dependencies = [...new Set([...names(pkg.dependencies), ...names(pkg.devDependencies), ...names(pkg.peerDependencies), ...names(pkg.optionalDependencies)])].sort().slice(0, 30);
      scripts = names(pkg.scripts).slice(0, 30);
    } catch {}
    const rows = db.prepare("SELECT source_path AS path FROM audit_items WHERE project_id = ? AND kind = 'instruction' ORDER BY source_path LIMIT 40").all(id) as { path: string }[];
    const headings: string[] = [];
    for (const item of rows) {
      const text = readProjectFile(root, item.path); if (!text) continue;
      let fence = false;
      for (const line of text.split(/\r?\n/)) {
        if (/^\s*(?:```|~~~)/.test(line)) { fence = !fence; continue; }
        if (fence) continue;
        const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
        if (match) headings.push(bounded(match[1], 80));
        if (headings.length >= 40) break;
      }
      if (headings.length >= 40) break;
    }
    return { dependencies, scripts, headings };
  } catch { return null; }
}
function prepare(db: DB, recs: Recommendation[], topN: number): { preview: AnalysisPreview; ids: Set<string> } | DiagnosisErrorCode {
  const status = aiStatus(db);
  if (status.error === 'AI_INVALID_SETTINGS' || !status.agent) return 'AI_INVALID_SETTINGS';
  const agent = status.agent === 'auto' ? 'claude' : status.agent;
  if (agent !== 'claude') return 'AI_PROVIDER_UNSUPPORTED';
  const findings = new Map(getFindings(db).map(f => [f.id, f]));
  const contexts = new Map<number, ReturnType<typeof projectContext>>();
  const data = recs.slice(0, topN).filter(r => safe(r.id, 200) && safe(r.findingRule, 100) && safe(r.action, 30)).map(r => {
    const prefix = `rec:${r.findingRule}:${r.projectId ?? 'global'}:`;
    const finding = r.id.startsWith(prefix) ? findings.get(r.id.slice(prefix.length)) : undefined;
    const evidence: Record<string, string | number> = {};
    if (finding && finding.rule === r.findingRule && finding.projectId === r.projectId) for (const key of evidenceKeys[r.findingRule] ?? []) {
      const value = finding.evidence?.[key];
      if (key === 'sources' && Array.isArray(value)) evidence.sources = Math.min(value.length, 1000000000);
      else if (typeof value === 'number' && Number.isFinite(value)) evidence[key] = Math.max(-1000000000, Math.min(1000000000, value));
      else if (typeof value === 'string' && safe(value, 100)) evidence[key] = value;
    }
    if (r.projectId != null && !contexts.has(r.projectId)) contexts.set(r.projectId, projectContext(db, r.projectId));
    return { id: r.id, rule: r.findingRule, action: r.action, score: Number.isFinite(r.score) ? r.score : null,
      title: bounded(r.title, 300), body: bounded(r.body, 600), actionSnippet: bounded(r.actionSnippet, 300), evidence,
      context: r.projectId == null ? null : contexts.get(r.projectId) };
  });
  const instruction = 'Refine only the supplied baseline using the supplied evidence and context; invent no facts and omit a field rather than weaken safe advice. Return a JSON array of objects with id, optional aiBody and optional aiActionSnippet. Use only the supplied IDs.\n';
  let prompt = instruction + JSON.stringify({ recommendations: data });
  while (prompt.length > 12000 && data.length) { data.pop(); prompt = instruction + JSON.stringify({ recommendations: data }); }
  const inputHash = createHash('sha256').update(prompt).digest('hex');
  const { bin, args } = buildAnalystCommand(prompt, { agent, model: status.model ?? undefined });
  const confirmationHash = createHash('sha256').update(JSON.stringify({ kind: 'recommendations', agent, model: status.model, bin, args })).digest('hex');
  return { preview: { agent, model: status.model, bin, args, prompt, inputHash, confirmationHash }, ids: new Set(data.map(r => r.id)) };
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
    const prepared = prepare(db, getRecommendations(db), topN); if (typeof prepared === 'string') return recs;
    const { preview, ids } = prepared;
    const row = db.prepare('SELECT text FROM ai_notes WHERE kind = ? AND input_hash = ? AND agent = ? AND model = ?').get('recommendations', preview.inputHash, preview.agent, preview.model ?? '') as { text: string } | undefined;
    const notes = row && parse(row.text, ids);
    return notes ? merge(recs, notes) : recs;
  } catch { return recs; }
}
export async function enrichRecommendations(db: DB, recs: Recommendation[], opts: { runner?: DiagnosisRunner; confirm?: string; now?: number; topN?: number; preview?: boolean } = {}): Promise<Result> {
  try {
    const topN = Math.max(0, Math.min(20, Number.isSafeInteger(opts.topN) ? opts.topN! : 5));
    const status = aiStatus(db, opts.now);
    if (!opts.preview && (status.error === 'AI_DISABLED' || status.error === 'AI_INVALID_SETTINGS')) return fail(recs, status.error);
    const prepared = prepare(db, recs, topN); if (typeof prepared === 'string') return fail(recs, prepared);
    const { preview, ids } = prepared;
    if (opts.preview) return { status: 'confirmation_required', preview, recommendations: recs };
    if (!ids.size) return { status: 'ok', cached: false, recommendations: recs };
    const result = await confirmedAnalysis(db, 'recommendations', preview, text => parse(text, ids), opts);
    if (result.status === 'error') return fail(recs, result.code);
    if (result.status === 'confirmation_required') return { ...result, preview, recommendations: recs };
    return { status: 'ok', cached: result.cached, recommendations: merge(recs, result.value) };
  } catch { return fail(recs, 'AI_RUN_FAILED'); }
}
