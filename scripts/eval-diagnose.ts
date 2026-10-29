import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSetting } from '../src/db.ts';
import { diagnoseSession, prepareDiagnosis, worstSessions, renderDiagnosisMarkdown } from '../src/ai/diagnose.ts';
import type { DiagnosisRunner, DiagnosisResult } from '../src/ai/diagnose.ts';
import { sessionDigest, redact } from '../src/ai/payload.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside = (root: string, path: string) => { const r = relative(root, path); return r !== '' && !r.startsWith('..' + '/') && r !== '..' && !isAbsolute(r); };
const clean = (text: string) => redact(text).replace(/(?:\/[\w.@~+-]+){2,}/g, '[REDACTED]');
function artifact(dir: string, name: string, content: string, snapshot: string) {
  const target = join(dir, name);
  if (target === snapshot) throw new Error('Output cannot replace the snapshot');
  const temp = join(dir, `.eval-${randomUUID()}`);
  try { writeFileSync(temp, content, { mode: 0o600, flag: 'wx' }); renameSync(temp, target); }
  finally { rmSync(temp, { force: true }); }
}
const publicId = (id: string) => /^[\w.:-]{1,100}$/.test(id) && clean(id) === id ? id : hash(id);

// Only the tables required by diagnosis and the AI gate are copied into memory. No arbitrary settings are copied.
function privateSnapshot(path: string): DatabaseSync {
  const source = new DatabaseSync(path, { readOnly: true });
  const db = new DatabaseSync(':memory:');
  try {
    source.exec('BEGIN');
    const schema = source.prepare("SELECT type, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table', 'index', 'view', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name").all() as { type: string; sql: string }[];
    for (const entry of schema.filter(e => e.type === 'table' || e.type === 'index')) db.exec(entry.sql);
    for (const table of ['projects', 'sessions', 'events', 'findings', 'ai_calls', 'ai_notes']) {
      const columns = source.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
      if (!columns.length) throw new Error('Snapshot schema is incomplete');
      const names = columns.map(c => `"${c.name.replaceAll('"', '""')}"`).join(',');
      const insert = db.prepare(`INSERT INTO "${table}" (${names}) VALUES (${columns.map(() => '?').join(',')})`);
      for (const row of source.prepare(`SELECT ${names} FROM "${table}"`).iterate()) insert.run(...columns.map(c => row[c.name]));
    }
    const settings = source.prepare("SELECT key, value FROM settings WHERE key IN ('ai_agent', 'ai_model', 'ai_max_calls_per_day')").all() as { key: string; value: string }[];
    for (const { key, value } of settings) setSetting(db, key, value);
    for (const entry of schema.filter(e => e.type === 'view' || e.type === 'trigger')) db.exec(entry.sql);
    source.exec('COMMIT');
    return db;
  } catch (error) { db.close(); throw error; } finally { source.close(); }
}

type ManifestSession = { sessionId: string; confirmationHash: string; inputHash: string; agent: string; model: string | null; bin: string; args: string[]; metadata: unknown };
type Result = { sessionId: string } & Exclude<DiagnosisResult, { status: 'confirmation_required' }>;
export async function evaluateDiagnoses(opts: { evalRoot: string; snapshotPath: string; outputDir: string; confirmationHash?: string; runner?: DiagnosisRunner; env?: NodeJS.ProcessEnv }): Promise<{ status: 'preview' | 'complete'; manifest: { version: number; sessions: ManifestSession[] }; manifestHash: string; results: Result[] }> {
  const root = realpathSync(opts.evalRoot); const snapshot = realpathSync(opts.snapshotPath); const output = realpathSync(opts.outputDir);
  const protectedDirs = [join(homedir(), '.local/share/agentlens'), join(homedir(), '.local/state/agentlens')].map(p => resolve(p));
  if (!inside(root, snapshot) || !inside(root, output) || protectedDirs.some(p => snapshot === p || inside(p, snapshot) || output === p || inside(p, output) || root === p || inside(p, root))) throw new Error('Snapshot and output must be isolated inside the evaluation directory');
  if (['preview.json', 'results.json', 'results.md'].some(name => join(output, name) === snapshot)) throw new Error('Output cannot replace the snapshot');
  const db = privateSnapshot(snapshot);
  try {
    const ids = worstSessions(db, 10);
    if (ids.length !== 10) throw new Error('Snapshot must contain at least ten sessions with findings');
    const previews = ids.map(id => {
      const prepared = prepareDiagnosis(db, id);
      if (prepared.status !== 'ready') throw new Error(`Cannot prepare all diagnoses: ${prepared.code}`);
      return prepared.preview;
    });
    const manifest = { version: 1, sessions: previews.map((p, i) => ({ sessionId: publicId(ids[i]), confirmationHash: p.confirmationHash, inputHash: p.inputHash, agent: p.agent, model: p.model === null ? null : clean(p.model), bin: p.bin, args: p.args.slice(0, -1).map(clean), metadata: JSON.parse(JSON.stringify(sessionDigest(db, ids[i]), (_key, value: unknown) => typeof value === 'string' ? redact(value) : value)) })) };
    const manifestHash = hash(manifest);
    const env = opts.env ?? process.env;
    if (opts.confirmationHash !== undefined && (env.AGENTLENS_EVAL_AI !== '1' || opts.confirmationHash !== manifestHash)) throw new Error('Execution requires explicit opt-in and the exact current manifest hash');
    if (opts.confirmationHash !== undefined && !opts.runner && ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'].some(key => process.env[key])) throw new Error('Remove API credentials and endpoint overrides before execution');
    artifact(output, 'preview.json', JSON.stringify({ manifestHash, manifest }, null, 2) + '\n', snapshot);
    const results: Result[] = [];
    if (opts.confirmationHash === undefined) return { status: 'preview', manifest, manifestHash, results };
    setSetting(db, 'ai_enabled', 'true');
    for (let i = 0; i < ids.length; i++) {
      const result = await diagnoseSession(db, ids[i], { confirm: previews[i].confirmationHash, runner: opts.runner });
      if (result.status === 'confirmation_required') results.push({ sessionId: publicId(ids[i]), status: 'error', code: 'AI_RUN_FAILED', message: 'Diagnosis confirmation changed' });
      else if (result.status === 'ok') {
        const diagnosis = JSON.parse(JSON.stringify(result.diagnosis, (_key, value: unknown) => typeof value === 'string' ? clean(value.replaceAll(previews[i].prompt, '[REDACTED]')) : value));
        results.push({ sessionId: publicId(ids[i]), status: 'ok', cached: result.cached, diagnosis });
      } else results.push({ sessionId: publicId(ids[i]), status: 'error', code: result.code, message: clean(result.message) });
    }
    const md = ['# Diagnosis evaluation', '', 'AI-generated diagnoses and token estimates are unverified; external judging is separate.', ''];
    for (const result of results) {
      md.push(`## Session ${result.sessionId}`, '');
      md.push(result.status === 'ok' ? renderDiagnosisMarkdown(result.diagnosis) : `${result.code}: ${result.message}`, '');
    }
    artifact(output, 'results.json', JSON.stringify({ manifestHash, results }, null, 2) + '\n', snapshot);
    artifact(output, 'results.md', md.join('\n'), snapshot);
    return { status: 'complete', manifest, manifestHash, results };
  } finally { db.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 && args.length !== 4) throw new Error('Usage: node scripts/eval-diagnose.ts <eval-root> <snapshot.db> <output-dir> [manifest-hash]');
  const result = await evaluateDiagnoses({ evalRoot: args[0], snapshotPath: args[1], outputDir: args[2], confirmationHash: args[3] });
  console.log(`${result.status}: manifest ${result.manifestHash}`);
  if (result.results.some(r => r.status !== 'ok')) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Evaluation failed; check the snapshot, isolation, settings, opt-in and manifest hash.'); process.exitCode = 1; });
