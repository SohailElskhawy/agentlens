import type { DB } from './db.ts';
import { getFindings, getRecommendations } from './db.ts';
import { daily, sessions } from './queries.ts';
import type { Filter } from './types.ts';

export interface ExportOptions {
  format?: 'csv' | 'json';
  type?: 'sessions' | 'daily' | 'findings' | 'all';
  from?: number;
  to?: number;
  projectId?: number;
  agent?: string;
  limit?: number;
}

export function escapeCsv(val: any): string {
  if (val == null) return '';
  const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function rowsToCsv(headers: string[], rows: Record<string, any>[]): string {
  const headLine = headers.map(escapeCsv).join(',');
  const lines = [headLine];
  for (const r of rows) {
    const line = headers.map((h) => escapeCsv(r[h])).join(',');
    lines.push(line);
  }
  return lines.join('\n');
}

export function exportSessions(db: DB, filter: Filter, limit = 5000) {
  const sess = sessions(db, filter, limit);
  return sess.map((s) => ({
    id: s.id,
    agent: s.agent,
    project: s.project ?? '',
    parentId: s.parentId ?? '',
    started: s.started ? new Date(s.started).toISOString() : '',
    ended: s.ended ? new Date(s.ended).toISOString() : '',
    turns: s.turns ?? 0,
    toolCalls: s.toolCalls ?? 0,
    tokens: s.tokens ?? 0,
    cost: s.cost ?? 0,
    input: s.input ?? 0,
    output: s.output ?? 0,
    cacheRead: s.cacheRead ?? 0,
    cacheWrite: s.cacheWrite ?? 0,
    reasoning: s.reasoning ?? 0,
  }));
}

export function exportDaily(db: DB, filter: Filter) {
  const totals = daily(db, filter);
  return totals.map((d) => ({
    day: d.day,
    agent: d.agent,
    tokens: d.tokens ?? 0,
    cost: d.cost ?? 0,
    input: d.input ?? 0,
    output: d.output ?? 0,
    cacheRead: d.cacheRead ?? 0,
    cacheWrite: d.cacheWrite ?? 0,
    reasoning: d.reasoning ?? 0,
  }));
}

export function exportFindings(db: DB, filter: Filter) {
  const findings = getFindings(db, filter);
  return findings.map((f) => ({
    id: f.id,
    rule: f.rule,
    agent: f.evidence?.agent ?? '',
    projectId: f.projectId ?? '',
    confidence: f.confidence,
    confidenceReason: f.confidenceReason,
    estTokensWeek: f.estTokensWeek ?? 0,
    lastSeen: f.lastSeen ? new Date(f.lastSeen).toISOString() : '',
    evidence: JSON.stringify(f.evidence ?? {}),
  }));
}

export function exportData(db: DB, opts: ExportOptions): string {
  const format = opts.format ?? 'json';
  const type = opts.type ?? (format === 'csv' ? 'sessions' : 'all');
  const filter: Filter = {
    from: opts.from,
    to: opts.to,
    projectId: opts.projectId,
    agent: opts.agent as any,
  };

  if (format === 'json') {
    if (type === 'sessions') {
      return JSON.stringify(exportSessions(db, filter, opts.limit), null, 2);
    }
    if (type === 'daily') {
      return JSON.stringify(exportDaily(db, filter), null, 2);
    }
    if (type === 'findings') {
      return JSON.stringify(exportFindings(db, filter), null, 2);
    }
    return JSON.stringify(
      {
        sessions: exportSessions(db, filter, opts.limit),
        daily: exportDaily(db, filter),
        findings: exportFindings(db, filter),
      },
      null,
      2
    );
  }

  // CSV format
  if (type === 'daily') {
    const rows = exportDaily(db, filter);
    const headers = ['day', 'agent', 'tokens', 'cost', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];
    return rowsToCsv(headers, rows);
  }
  if (type === 'findings') {
    const rows = exportFindings(db, filter);
    const headers = ['id', 'rule', 'agent', 'projectId', 'confidence', 'confidenceReason', 'estTokensWeek', 'lastSeen', 'evidence'];
    return rowsToCsv(headers, rows);
  }
  // sessions or default
  const rows = exportSessions(db, filter, opts.limit);
  const headers = [
    'id', 'agent', 'project', 'parentId', 'started', 'ended', 'turns', 'toolCalls',
    'tokens', 'cost', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning',
  ];
  return rowsToCsv(headers, rows);
}

export function generatePrometheusMetrics(db: DB): string {
  const lines: string[] = [];

  // 1. Token counters by agent and kind
  lines.push('# HELP agentlens_tokens_total Total tokens processed by agent and kind.');
  lines.push('# TYPE agentlens_tokens_total counter');
  const tokenRows = db.prepare(`
    SELECT agent,
           sum(input) AS input,
           sum(output) AS output,
           sum(cache_read) AS cache_read,
           sum(cache_write) AS cache_write,
           sum(reasoning) AS reasoning
    FROM events
    WHERE kind = 'assistant'
    GROUP BY agent
  `).all() as Array<{
    agent: string;
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    reasoning: number;
  }>;

  for (const r of tokenRows) {
    lines.push(`agentlens_tokens_total{agent="${r.agent}",kind="input"} ${r.input || 0}`);
    lines.push(`agentlens_tokens_total{agent="${r.agent}",kind="output"} ${r.output || 0}`);
    lines.push(`agentlens_tokens_total{agent="${r.agent}",kind="cache_read"} ${r.cache_read || 0}`);
    lines.push(`agentlens_tokens_total{agent="${r.agent}",kind="cache_write"} ${r.cache_write || 0}`);
    lines.push(`agentlens_tokens_total{agent="${r.agent}",kind="reasoning"} ${r.reasoning || 0}`);
  }

  // 2. Session counters by agent
  lines.push('# HELP agentlens_sessions_total Total sessions ingested by agent.');
  lines.push('# TYPE agentlens_sessions_total counter');
  const sessionRows = db.prepare(`
    SELECT agent, count(*) AS count FROM sessions GROUP BY agent
  `).all() as Array<{ agent: string; count: number }>;
  for (const r of sessionRows) {
    lines.push(`agentlens_sessions_total{agent="${r.agent}"} ${r.count || 0}`);
  }

  // 3. Quota usage gauge
  lines.push('# HELP agentlens_quota_used_percent Current quota usage percent.');
  lines.push('# TYPE agentlens_quota_used_percent gauge');
  const quotaRows = db.prepare(`
    SELECT agent, win, used_pct FROM quota_snapshots q1
    WHERE ts = (SELECT max(ts) FROM quota_snapshots q2 WHERE q2.agent = q1.agent AND q2.win = q1.win)
  `).all() as Array<{ agent: string; win: string; used_pct: number }>;
  for (const r of quotaRows) {
    lines.push(`agentlens_quota_used_percent{agent="${r.agent}",window="${r.win}"} ${r.used_pct || 0}`);
  }

  // 4. Active findings by rule
  lines.push('# HELP agentlens_findings_active Active token waste findings count.');
  lines.push('# TYPE agentlens_findings_active gauge');
  const findingRows = db.prepare(`
    SELECT rule, count(*) AS count FROM findings GROUP BY rule
  `).all() as Array<{ rule: string; count: number }>;
  for (const r of findingRows) {
    lines.push(`agentlens_findings_active{rule="${r.rule}"} ${r.count || 0}`);
  }

  // 5. Recommendations by status
  lines.push('# HELP agentlens_recommendations_count Recommendations count by status.');
  lines.push('# TYPE agentlens_recommendations_count gauge');
  const recRows = db.prepare(`
    SELECT status, count(*) AS count FROM recommendations GROUP BY status
  `).all() as Array<{ status: string; count: number }>;
  for (const r of recRows) {
    lines.push(`agentlens_recommendations_count{status="${r.status}"} ${r.count || 0}`);
  }

  return lines.join('\n') + '\n';
}
