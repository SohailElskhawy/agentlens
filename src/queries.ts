import type { DB } from './db.ts';
import type { Filter } from './types.ts';
import { checkHealth } from './health.ts';
import { costOf, PRICES_AS_OF } from './pricing.ts';

export interface Totals {
  input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; reasoning: number;
  tokens: number; cost: number; unpricedTokens: number;
}
type Row = Record<string, any>;

const SUMS = `sum(e.input) AS input, sum(e.output) AS output, sum(e.cache_read) AS cacheRead,
  sum(e.cache_write) AS cacheWrite, sum(e.cache_write_1h) AS cacheWrite1h, sum(e.reasoning) AS reasoning`;
const FROM = 'FROM events e LEFT JOIN sessions s ON s.id = e.session_id';
const plain = (rows: unknown[]) => rows.map((r) => ({ ...(r as Row) })); // node:sqlite rows have a null prototype

function where(f: Filter & { sessionId?: string }) {
  const c: string[] = [];
  const params: Record<string, string | number> = {};
  if (f.from != null) { c.push('e.ts >= $from'); params.from = f.from; }
  if (f.to != null) { c.push('e.ts < $to'); params.to = f.to; }
  if (f.agent) { c.push('e.agent = $agent'); params.agent = f.agent; }
  if (f.projectId != null) { c.push('s.project_id = $projectId'); params.projectId = f.projectId; }
  if (f.sessionId) { c.push('e.session_id = $sessionId'); params.sessionId = f.sessionId; }
  return { sql: c.map((x) => ` AND ${x}`).join(''), params };
}

const zero = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, tokens: 0, cost: 0, unpricedTokens: 0 });

function add(t: Totals, r: Row) {
  const u = { input: r.input ?? 0, output: r.output ?? 0, cacheRead: r.cacheRead ?? 0, cacheWrite: r.cacheWrite ?? 0, cacheWrite1h: r.cacheWrite1h ?? 0 };
  for (const k of Object.keys(u) as (keyof typeof u)[]) t[k] += u[k];
  t.reasoning += r.reasoning ?? 0;
  const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
  t.tokens += tokens;
  const c = costOf(r.model, u);
  if (c == null) t.unpricedTokens += tokens;
  else t.cost += c;
}

/**
 * Token totals and estimated cost per group. Cost needs the model, so rows are grouped by (dims..., model)
 * and folded per dims in JS. `dims` maps output field -> SQL expression: only pass literals, never user input.
 */
function grouped(db: DB, f: Filter & { sessionId?: string }, dims: Record<string, string>): (Row & Totals)[] {
  const w = where(f);
  const keys = Object.keys(dims);
  const select = keys.map((k) => `${dims[k]} AS ${k}, `).join('');
  const groupBy = [...keys.map((_, i) => i + 1), keys.length + 1].join(', '); // ordinals: avoids ambiguous aliases like "agent"
  const rows = db.prepare(`SELECT ${select}e.model AS model, ${SUMS} ${FROM} WHERE e.kind = 'assistant'${w.sql} GROUP BY ${groupBy}`).all(w.params) as Row[];
  const out = new Map<string, Row & Totals>();
  for (const r of rows) {
    const id = JSON.stringify(keys.map((k) => r[k]));
    let g = out.get(id);
    if (!g) { g = { ...Object.fromEntries(keys.map((k) => [k, r[k]])), ...zero() }; out.set(id, g); }
    add(g, r);
  }
  return [...out.values()];
}

export function summary(db: DB, f: Filter) {
  const w = where(f);
  const { n } = db.prepare(`SELECT count(DISTINCT e.session_id) AS n ${FROM} WHERE 1 = 1${w.sql}`).get(w.params) as { n: number };
  return { totals: grouped(db, f, {})[0] ?? zero(), byAgent: grouped(db, f, { agent: 'e.agent' }), sessions: n, pricesAsOf: PRICES_AS_OF };
}

export const daily = (db: DB, f: Filter) =>
  grouped(db, f, { day: `date(e.ts / 1000, 'unixepoch', 'localtime')`, agent: 'e.agent' })
    .sort((a, b) => a.day.localeCompare(b.day) || a.agent.localeCompare(b.agent));

export const models = (db: DB, f: Filter) => grouped(db, f, { name: 'e.model', agent: 'e.agent' }).sort((a, b) => b.tokens - a.tokens);

export function projects(db: DB, f: Filter) {
  const w = where(f);
  const meta = new Map((db.prepare(`
    SELECT s.project_id AS projectId, p.name, p.root, count(DISTINCT e.session_id) AS sessions, max(e.ts) AS lastActive,
      group_concat(DISTINCT e.agent) AS agents
    ${FROM} JOIN projects p ON p.id = s.project_id WHERE 1 = 1${w.sql} GROUP BY s.project_id`).all(w.params) as Row[])
    .map((r) => [r.projectId, { ...r }]));

  const settingsRows = db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'budget_%'`).all() as Array<{ key: string; value: string }>;
  const budgets = new Map<string, string>();
  for (const s of settingsRows) budgets.set(s.key, s.value);

  return grouped(db, f, { projectId: 's.project_id' })
    .filter((g) => meta.has(g.projectId))
    .map((g) => {
      const budgetTokens = Number(budgets.get(`budget_tokens_${g.projectId}`)) || undefined;
      const budgetCost = Number(budgets.get(`budget_cost_${g.projectId}`)) || undefined;
      const budgetPct = budgetTokens ? Math.round((g.tokens / budgetTokens) * 100) : undefined;
      return {
        ...meta.get(g.projectId),
        ...g,
        budgetTokens,
        budgetCost,
        budgetPct,
      } as Row;
    })
    .sort((a, b) => b.tokens - a.tokens);
}

// ponytail: totals are computed for every session in range, then joined to the page; fine at thousands of sessions.
export function sessions(db: DB, f: Filter, limit = 200) {
  const w = where(f);
  const rows = db.prepare(`
    SELECT e.session_id AS id, e.agent, s.parent_id AS parentId, p.name AS project, min(e.ts) AS started, max(e.ts) AS ended,
      sum(e.kind = 'assistant') AS turns, sum(e.kind = 'tool_call') AS toolCalls
    ${FROM} LEFT JOIN projects p ON p.id = s.project_id WHERE 1 = 1${w.sql}
    GROUP BY e.session_id ORDER BY ended DESC LIMIT $limit`).all({ ...w.params, limit }) as Row[];
  const totals = new Map(grouped(db, f, { id: 'e.session_id' }).map((g) => [g.id, g]));
  return rows.map((r): Row & Totals => ({ ...r, ...(totals.get(r.id) ?? zero()) })); // annotated: spreading Row with the Totals fallback would drop Row's index signature
}

export function sessionDetail(db: DB, id: string) {
  const s = db.prepare(`SELECT s.id, s.agent, s.cwd, s.parent_id AS parentId, p.name AS project, p.root
    FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?`).get(id) as Row | undefined;
  if (!s) return null;
  return {
    ...s,
    totals: grouped(db, { sessionId: id }, {})[0] ?? zero(),
    turns: plain(db.prepare(`SELECT ts, model, input + cache_read + cache_write AS context, output
      FROM events WHERE session_id = ? AND kind = 'assistant' ORDER BY ts`).all(id)),
    tools: plain(db.prepare(`SELECT c.tool, count(*) AS calls, coalesce(sum(r.result_bytes), 0) AS resultBytes, coalesce(sum(r.is_error), 0) AS errors
      FROM events c LEFT JOIN events r ON r.id = c.id || ':result'
      WHERE c.session_id = ? AND c.kind = 'tool_call' GROUP BY c.tool ORDER BY calls DESC`).all(id)),
    children: plain(db.prepare('SELECT id, agent FROM sessions WHERE parent_id = ? ORDER BY id').all(id)),
  };
}

import { computeQuotaForecasts } from './quota-forecast.ts';

export function quota(db: DB, f: Filter) {
  const p = { from: f.from ?? 0, to: f.to ?? Number.MAX_SAFE_INTEGER, agent: f.agent ?? '' };
  const agentSql = `($agent = '' OR agent = $agent)`;
  const forecasts = computeQuotaForecasts(db).filter((fc) => !p.agent || fc.agent === p.agent);
  return {
    latest: plain(db.prepare(`SELECT agent, win, used_pct AS usedPct, resets_at AS resetsAt, ts FROM quota_snapshots q
      WHERE ts = (SELECT max(ts) FROM quota_snapshots WHERE agent = q.agent AND win = q.win) AND ${agentSql}
      ORDER BY agent, win`).all({ agent: p.agent })),
    timeline: plain(db.prepare(`SELECT agent, win, ts, used_pct AS usedPct FROM quota_snapshots
      WHERE ts >= $from AND ts < $to AND ${agentSql} ORDER BY ts`).all(p)),
    limitHits: plain(db.prepare(`SELECT agent, win, resets_at AS resetsAt, min(ts) AS firstHit FROM quota_snapshots
      WHERE used_pct >= 100 AND ts >= $from AND ts < $to AND ${agentSql}
      GROUP BY agent, win, resets_at ORDER BY firstHit DESC`).all(p)),
    forecasts,
  };
}

export function health(db: DB) {
  return checkHealth(db);
}

import { readGitNumstat } from './analyze/outcome_efficiency.ts';

export function outcomeEfficiency(db: DB, f: Filter, gitReader?: typeof readGitNumstat) {
  const reader = gitReader ?? readGitNumstat;
  const projs = projects(db, f);
  return projs.map((p) => {
    const commits = reader(p.root);
    const projSessions = db.prepare(`
      SELECT s.id, s.agent, min(e.ts) AS started, max(e.ts) AS ended,
             sum(e.input + e.output + e.cache_read + e.cache_write) AS tokens
      FROM sessions s
      JOIN events e ON e.session_id = s.id
      WHERE s.project_id = ?
      GROUP BY s.id
    `).all(p.projectId) as Array<{ id: string; agent: string; started: number; ended: number; tokens: number }>;

    let attrCommits = 0;
    let attrLines = 0;
    const byAgentMap = new Map<string, { tokens: number; commits: number; lines: number }>();

    for (const c of commits) {
      const match = projSessions.find((s) => c.ts >= s.started - 60_000 && c.ts <= s.ended + 600_000);
      if (match) {
        attrCommits++;
        const lines = c.added + c.deleted;
        attrLines += lines;
        const ag = byAgentMap.get(match.agent) || { tokens: 0, commits: 0, lines: 0 };
        ag.commits++;
        ag.lines += lines;
        byAgentMap.set(match.agent, ag);
      }
    }

    for (const s of projSessions) {
      const ag = byAgentMap.get(s.agent) || { tokens: 0, commits: 0, lines: 0 };
      ag.tokens += s.tokens;
      byAgentMap.set(s.agent, ag);
    }

    const effCommits = attrCommits > 0 ? attrCommits : commits.length;
    const effLines = attrLines > 0 ? attrLines : commits.reduce((acc, c) => acc + c.added + c.deleted, 0);

    const tokensPerCommit = Math.round(p.tokens / Math.max(1, effCommits));
    const tokensPerChangedLine = Math.round(p.tokens / Math.max(1, effLines));

    const byAgent = Array.from(byAgentMap.entries()).map(([agent, data]) => ({
      agent,
      tokens: data.tokens,
      commits: data.commits,
      linesChanged: data.lines,
      tokensPerCommit: Math.round(data.tokens / Math.max(1, data.commits)),
      tokensPerChangedLine: Math.round(data.tokens / Math.max(1, data.lines)),
    }));

    const dayMap = new Map<string, { commits: number; lines: number }>();
    for (const c of commits) {
      const day = new Date(c.ts).toISOString().slice(0, 10);
      const dm = dayMap.get(day) || { commits: 0, lines: 0 };
      dm.commits++;
      dm.lines += c.added + c.deleted;
      dayMap.set(day, dm);
    }
    const trend = Array.from(dayMap.entries())
      .map(([date, d]) => ({ date, commits: d.commits, linesChanged: d.lines }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      projectId: p.projectId,
      name: p.name,
      root: p.root,
      tokens: p.tokens,
      commits: effCommits,
      linesChanged: effLines,
      tokensPerCommit,
      tokensPerChangedLine,
      byAgent,
      trend,
    };
  });
}
