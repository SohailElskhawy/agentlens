import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { DB } from '../db.ts';
import { generateFixPrompt, type FixPromptContext } from '../fix-prompts.ts';
import { MAX_BOUNDED_READ_BYTES } from './constants.ts';
import { confirmedAnalysis, type AnalysisPreview } from './confirmed.ts';
import type { DiagnosisErrorCode, DiagnosisRunner } from './diagnose.ts';
import { aiStatus } from './gate.ts';
import { redact } from './payload.ts';
import { buildAnalystCommand, getProviderIsolation, type AnalystAgent } from './runner.ts';

export type TailorFixPromptPreview = {
  agent: AnalystAgent;
  model: string | null;
  prompt: string;
  confirmationHash: string;
};

export type TailorFixPromptResult =
  | { ok: true; prompt: string; source: 'ai'; cached: boolean }
  | { ok: true; prompt: string; source: 'fallback'; aiStatus: 'confirmation_required'; preview: TailorFixPromptPreview }
  | { ok: true; prompt: string; source: 'fallback'; aiError: DiagnosisErrorCode };

const safeId = (s: unknown, max = 100): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= max && /^[\w.:-]+$/.test(s) && redact(s) === s;

const safeVal = (s: unknown, max = 100): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= max && /^[\w./:-]+$/.test(s) && !s.startsWith('~/') && redact(s) === s;

const bounded = (value: unknown, max: number): string =>
  typeof value === 'string' ? redact(value).replace(/~\/(?:[^\s"']+)/g, '[REDACTED]').slice(0, max) : '';

const evidenceKeys: Record<string, string[]> = {
  retry_loop: ['tool', 'count'],
  hot_files: ['reads', 'file', 'target', 'tool'],
  large_tool_output: ['resultBytes', 'tool'],
  repeated_prompt: ['sessionCount'],
  model_fit: ['model', 'outputTokens'],
  handoff: ['previousAgent', 'currentAgent', 'gapMinutes'],
  subagent_share: ['inputTokens', 'outputTokens'],
  quota_pressure: ['agent', 'window', 'usedPct'],
  cross_agent_balance: ['tightAgent', 'altAgent', 'window'],
  instruction_bloat: ['fixedTokens', 'name'],
  instruction_overhead: ['fixedTokens', 'name'],
  unused_config: ['kind', 'name', 'agent'],
  unused_mcp: ['kind', 'name', 'agent'],
  unused_skill: ['kind', 'name', 'agent'],
  unused_plugin: ['kind', 'name', 'agent'],
  duplicate_config: ['kind', 'name', 'sources'],
  conflict_config: ['managers'],
  config_conflict: ['managers'],
};

function readProjectFile(root: string, path: string): string | null {
  let fd: number | undefined;
  try {
    const resolved = realpathSync(path);
    const rel = relative(root, resolved);
    if (!rel || rel.startsWith('..' + '/') || rel === '..' || isAbsolute(rel)) return null;
    fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BOUNDED_READ_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readProjectContext(db: DB, id: number): { dependencies: string[]; scripts: string[]; headings: string[] } | null {
  try {
    const row = db.prepare('SELECT root FROM projects WHERE id = ?').get(id) as { root: string } | undefined;
    if (!row) return null;
    const root = realpathSync(row.root);
    const raw = readProjectFile(root, join(root, 'package.json'));
    let dependencies: string[] = [];
    let scripts: string[] = [];
    if (raw) {
      try {
        const pkg = JSON.parse(raw);
        const names = (obj: unknown) =>
          obj && typeof obj === 'object' && !Array.isArray(obj)
            ? Object.keys(obj).filter(name => /^[\w@/.-]{1,100}$/.test(name) && redact(name) === name).sort()
            : [];
        dependencies = [
          ...new Set([
            ...names(pkg.dependencies),
            ...names(pkg.devDependencies),
            ...names(pkg.peerDependencies),
            ...names(pkg.optionalDependencies),
          ]),
        ].sort().slice(0, 30);
        scripts = names(pkg.scripts).slice(0, 30);
      } catch {}
    }
    const rows = db
      .prepare("SELECT source_path AS path FROM audit_items WHERE project_id = ? AND kind = 'instruction' ORDER BY source_path LIMIT 40")
      .all(id) as { path: string }[];
    const headings: string[] = [];
    for (const item of rows) {
      const text = readProjectFile(root, item.path);
      if (!text) continue;
      let fence = false;
      for (const line of text.split(/\r?\n/)) {
        if (/^\s*(?:```|~~~)/.test(line)) {
          fence = !fence;
          continue;
        }
        if (fence) continue;
        const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
        if (match) headings.push(bounded(match[1], 80));
        if (headings.length >= 40) break;
      }
      if (headings.length >= 40) break;
    }
    return { dependencies, scripts, headings };
  } catch {
    return null;
  }
}

export function parseFixPrompt(text: string): { prompt: string } | null {
  if (typeof text !== 'string' || text.length > 16000) return null;
  const body = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/i.exec(text)?.[1] ?? text;
  try {
    const raw = JSON.parse(body);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.prompt !== 'string') return null;
    const trimmed = raw.prompt.trim();
    if (!trimmed || raw.prompt.length > 4000) return null;
    return { prompt: trimmed };
  } catch {
    return null;
  }
}

export async function tailorFixPrompt(
  db: DB,
  rawInput: unknown,
  opts: { runner?: DiagnosisRunner; confirm?: string; preview?: boolean; now?: number } = {},
): Promise<TailorFixPromptResult> {
  const ctx = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {}) as FixPromptContext & {
    projectId?: unknown;
  };
  const fallback = generateFixPrompt(ctx);
  try {
    const status = aiStatus(db, opts.now);
    if (status.error === 'AI_INVALID_SETTINGS' || !status.agent) {
      return { ok: true, prompt: fallback, source: 'fallback', aiError: 'AI_INVALID_SETTINGS' };
    }
    const agent = status.agent === 'auto' ? 'claude' : status.agent;
    if (!getProviderIsolation(agent).supported) {
      return { ok: true, prompt: fallback, source: 'fallback', aiError: 'AI_PROVIDER_UNSUPPORTED' };
    }

    const rawRule = ctx.rule || ctx.finding?.rule || ctx.recommendation?.findingRule || '';
    const rule = safeId(rawRule, 100) ? rawRule : 'general';
    const safeAgent = safeId(ctx.agent, 100) ? ctx.agent : undefined;
    const projectName = bounded(ctx.projectName, 100) || undefined;
    const title = bounded(ctx.title ?? ctx.recommendation?.title, 300) || undefined;

    const rawEv = (ctx.evidence ?? ctx.finding?.evidence ?? {}) as Record<string, unknown>;
    const evidence: Record<string, string | number | string[]> = {};
    if (rawEv && typeof rawEv === 'object' && !Array.isArray(rawEv)) {
      for (const key of evidenceKeys[rule] ?? []) {
        const value = rawEv[key];
        if (key === 'sources' && Array.isArray(value)) {
          evidence.sources = Math.min(value.length, 1000000000);
        } else if (key === 'managers' && Array.isArray(value)) {
          evidence.managers = value.filter((m): m is string => safeId(m, 50)).slice(0, 10);
        } else if (typeof value === 'number' && Number.isFinite(value)) {
          evidence[key] = Math.max(-1000000000, Math.min(1000000000, value));
        } else if (typeof value === 'string' && safeVal(value, 100)) {
          evidence[key] = value;
        }
      }
    }

    const rawProjectId = ctx.projectId ?? ctx.finding?.projectId ?? ctx.recommendation?.projectId;
    const projectId =
      typeof rawProjectId === 'number' && Number.isSafeInteger(rawProjectId) && rawProjectId > 0 ? rawProjectId : undefined;
    const projectContext = projectId !== undefined ? readProjectContext(db, projectId) : null;

    const safeBaseline = generateFixPrompt({
      rule,
      agent: safeAgent,
      projectName,
      title,
      evidence,
    });
    const baselinePrompt = redact(safeBaseline).slice(0, 600);

    const payload: {
      rule: string;
      agent?: string;
      projectName?: string;
      title?: string;
      evidence: Record<string, string | number | string[]>;
      baselinePrompt: string;
      projectContext?: { dependencies: string[]; scripts: string[]; headings: string[] } | null;
    } = {
      rule,
      ...(safeAgent ? { agent: safeAgent } : {}),
      ...(projectName ? { projectName } : {}),
      ...(title ? { title } : {}),
      evidence,
      baselinePrompt,
      ...(projectContext ? { projectContext } : {}),
    };

    const instruction =
      'Tailor this fix prompt using only the supplied structured evidence and project context; do not invent facts or commands. Return JSON {"prompt":string} with a concise actionable prompt.\n';
    const serialize = () =>
      instruction + redact(JSON.stringify(payload, (_k, v: unknown) => (typeof v === 'string' ? redact(v) : v)));
    let prompt = serialize();
    while (prompt.length > 12000 && payload.projectContext) {
      if (payload.projectContext.headings.length) payload.projectContext.headings.pop();
      else if (payload.projectContext.scripts.length) payload.projectContext.scripts.pop();
      else if (payload.projectContext.dependencies.length) payload.projectContext.dependencies.pop();
      else {
        delete payload.projectContext;
        break;
      }
      prompt = serialize();
    }
    if (prompt.length > 12000) prompt = prompt.slice(0, 12000);

    const inputHash = createHash('sha256').update(prompt).digest('hex');
    const { bin, args } = buildAnalystCommand(prompt, { agent, model: status.model ?? undefined });
    const confirmationHash = createHash('sha256')
      .update(JSON.stringify({ kind: 'fix_prompt', agent, model: status.model, bin, args }))
      .digest('hex');
    const preview: AnalysisPreview = {
      agent,
      model: status.model,
      bin,
      args,
      prompt,
      inputHash,
      confirmationHash,
    };

    if (opts.preview) {
      return {
        ok: true,
        prompt: fallback,
        source: 'fallback',
        aiStatus: 'confirmation_required',
        preview: {
          agent: preview.agent,
          model: preview.model,
          prompt: preview.prompt,
          confirmationHash: preview.confirmationHash,
        },
      };
    }

    if (status.error === 'AI_DISABLED') {
      return { ok: true, prompt: fallback, source: 'fallback', aiError: 'AI_DISABLED' };
    }

    const result = await confirmedAnalysis(db, 'fix_prompt', preview, parseFixPrompt, opts);
    if (result.status === 'ok') {
      return { ok: true, prompt: result.value.prompt, source: 'ai', cached: result.cached };
    }
    if (result.status === 'confirmation_required') {
      return {
        ok: true,
        prompt: fallback,
        source: 'fallback',
        aiStatus: 'confirmation_required',
        preview: {
          agent: preview.agent,
          model: preview.model,
          prompt: preview.prompt,
          confirmationHash: preview.confirmationHash,
        },
      };
    }
    return { ok: true, prompt: fallback, source: 'fallback', aiError: result.code };
  } catch {
    return { ok: true, prompt: fallback, source: 'fallback', aiError: 'AI_RUN_FAILED' };
  }
}
