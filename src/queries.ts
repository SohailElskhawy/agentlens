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

export function where(f: Filter & { sessionId?: string }) {
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

export interface ToolFailure {
  tool: string; projectId: number | null; project: string | null;
  calls: number; errors: number; retries: number; wastedTokens: number;
}

/**
 * Tool errors and wasted retry tokens per (tool, project). An error is a paired tool_result with
 * is_error (the `:result` id suffix). A retry is a repeat of the identical (session, tool, args_hash)
 * call; its wastedTokens are the assistant tokens spent between the previous attempt and the retry.
 */
export function toolFailures(db: DB, f: Filter = {}) {
  const w = where(f);
  const rows = db.prepare(`
    WITH attempts AS (
      SELECT e.id AS id, e.session_id AS sessionId, e.ts AS ts, e.tool AS tool, s.project_id AS projectId,
        CASE WHEN e.args_hash IS NOT NULL THEN lag(e.ts) OVER (PARTITION BY e.session_id, e.tool, e.args_hash ORDER BY e.ts, e.id) END AS prevTs
      ${FROM} WHERE e.kind = 'tool_call' AND e.tool IS NOT NULL${w.sql}
    )
    SELECT a.tool, a.projectId, count(*) AS calls,
      sum(CASE WHEN r.is_error = 1 THEN 1 ELSE 0 END) AS errors,
      count(a.prevTs) AS retries,
      coalesce(sum((SELECT coalesce(sum(x.input + x.output + x.cache_read + x.cache_write), 0) FROM events x
        WHERE x.session_id = a.sessionId AND x.kind = 'assistant' AND x.ts > a.prevTs AND x.ts <= a.ts)), 0) AS wastedTokens
    FROM attempts a
    LEFT JOIN events r ON r.id = a.id || ':result'
    GROUP BY 1, 2
    ORDER BY errors DESC, wastedTokens DESC, a.tool, a.projectId
  `).all(w.params) as Array<{ tool: string; projectId: number | null; calls: number; errors: number; retries: number; wastedTokens: number }>;

  const nameStmt = db.prepare('SELECT name FROM projects WHERE id = ?');
  const failures: ToolFailure[] = rows.map((r) => ({
    tool: r.tool, projectId: r.projectId ?? null,
    project: r.projectId == null ? null : (nameStmt.get(r.projectId) as { name: string } | undefined)?.name ?? null,
    calls: r.calls, errors: r.errors, retries: r.retries, wastedTokens: r.wastedTokens,
  }));
  const totals = failures.reduce(
    (t, f) => ({ calls: t.calls + f.calls, errors: t.errors + f.errors, retries: t.retries + f.retries, wastedTokens: t.wastedTokens + f.wastedTokens }),
    { calls: 0, errors: 0, retries: 0, wastedTokens: 0 },
  );
  return { failures, totals };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export interface ModelEfficiency {
  name: string;
  sessions: number;
  tokens: number;
  tokensPerSession: number;
  avgTurns: number;
  toolErrorRate: number;
  cacheReadRatio: number;
}

/**
 * Efficiency comparison per model over actual workspace sessions. A session that uses several
 * models is counted once per model; its tool stats are attributed to its primary model
 * (the one with the most tokens in that session, ties broken by name for determinism).
 */
export function modelEfficiency(db: DB, f: Filter = {}): ModelEfficiency[] {
  const w = where(f);
  const turns = db.prepare(`SELECT e.model AS model, e.session_id AS sessionId,
      sum(e.input + e.output + e.cache_read + e.cache_write) AS tokens, sum(e.cache_read) AS cacheRead, count(*) AS turns
    ${FROM} WHERE e.kind = 'assistant'${w.sql} GROUP BY e.model, e.session_id`).all(w.params) as Row[];
  const tools = db.prepare(`SELECT e.session_id AS sessionId, count(*) AS calls,
      coalesce(sum(r.is_error = 1), 0) AS errors
    ${FROM} LEFT JOIN events r ON r.id = e.id || ':result'
    WHERE e.kind = 'tool_call' AND e.tool IS NOT NULL${w.sql} GROUP BY e.session_id`).all(w.params) as Array<{ sessionId: string; calls: number; errors: number }>;

  const primary = new Map<string, { model: string; tokens: number }>();
  for (const t of turns) {
    const model = t.model ?? 'unknown';
    const p = primary.get(t.sessionId);
    if (!p || t.tokens > p.tokens || (t.tokens === p.tokens && model < p.model)) primary.set(t.sessionId, { model, tokens: t.tokens });
  }

  const groups = new Map<string, { model: string; sessions: number; tokens: number; cacheRead: number; turns: number; calls: number; errors: number }>();
  for (const t of turns) {
    const model = t.model ?? 'unknown';
    let g = groups.get(model);
    if (!g) { g = { model, sessions: 0, tokens: 0, cacheRead: 0, turns: 0, calls: 0, errors: 0 }; groups.set(model, g); }
    g.sessions++; g.tokens += t.tokens; g.cacheRead += t.cacheRead; g.turns += t.turns;
  }
  for (const t of tools) {
    const g = groups.get(primary.get(t.sessionId)?.model ?? '') ?? null;
    if (!g) continue;
    g.calls += t.calls; g.errors += t.errors;
  }

  return [...groups.values()].map((g) => ({
    name: g.model, sessions: g.sessions, tokens: g.tokens,
    tokensPerSession: Math.round(g.tokens / g.sessions),
    avgTurns: r3(g.turns / g.sessions),
    toolErrorRate: g.calls ? r3(g.errors / g.calls) : 0,
    cacheReadRatio: g.tokens ? r3(g.cacheRead / g.tokens) : 0,
  })).sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
}

export interface SessionFamily {
  root: string;
  sessions: number;
  childSessions: number;
  totalSessions: number;
  tokens: number;
  cost: number;
  pricedSessions: number;
}

/**
 * Informational attribution: which share of tokens sits in which parent-child session family.
 * A family root is a session with no usable parent (no parent_id, a parent_id with no matching
 * row, or a cycle back to itself on the parent walk); descendants attach to their ancestor root.
 * Cycles are cut when the walk revisits a session on the current path, so cyclic data neither
 * crashes nor hangs; every session lands in exactly one family and is counted once.
 * Cost covers priced models only via costOf; unpriced sessions keep their tokens but cost 0.
 */
export function sessionFamilies(db: DB, f: Filter = {}): SessionFamily[] {
  const w = where(f);
  // Family structure comes from the sessions table; tokens/cost come from filtered events. A session
  // with no events matching the filter contributes no family of its own, but its ancestors' structure
  // is still walked so its tokens land in the right root's family.
  const parents = new Map<string, string | null>();
  for (const r of db.prepare('SELECT id, parent_id AS parentId FROM sessions').all() as Row[]) parents.set(r.id, r.parentId ?? null);
  const rootsSeed: string[] = []; // sessions seen by the filtered events; family list is built from these
  for (const r of db.prepare(`SELECT DISTINCT e.session_id AS id ${FROM} WHERE 1 = 1${w.sql}`).all(w.params) as Row[]) { // events whose session row is missing still count, as their own roots
    if (!parents.has(r.id)) parents.set(r.id, null);
    rootsSeed.push(r.id);
  }

  const rootOf = new Map<string, string>();
  const root = (id: string): string => {
    const cached = rootOf.get(id);
    if (cached !== undefined) return cached;
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur = id;
    let res = '';
    for (;;) {
      const memo = rootOf.get(cur);
      if (memo !== undefined) { res = memo; break; }
      if (onPath.has(cur)) { res = cur; break; } // cycle: cut here, the re-entry point anchors the family
      onPath.add(cur);
      path.push(cur);
      const parent = parents.get(cur);
      if (parent == null || !parents.has(parent)) { res = cur; break; } // no parent row: this session is a root
      cur = parent;
    }
    for (const p of path) rootOf.set(p, res);
    return res;
  };

  const fams = new Map<string, { sessions: number; tokens: number; cost: number; priced: Set<string> }>();
  for (const id of rootsSeed) {
    const r = root(id);
    let g = fams.get(r);
    if (!g) { g = { sessions: 0, tokens: 0, cost: 0, priced: new Set() }; fams.set(r, g); }
    g.sessions++;
  }

  const stats = db.prepare(`
    SELECT e.session_id AS sessionId, e.model AS model, sum(e.input) AS input, sum(e.output) AS output,
      sum(e.cache_read) AS cacheRead, sum(e.cache_write) AS cacheWrite, sum(e.cache_write_1h) AS cacheWrite1h,
      sum(e.input + e.output + e.cache_read + e.cache_write) AS tokens
    ${FROM} WHERE e.kind = 'assistant'${w.sql} GROUP BY e.session_id, e.model`).all(w.params) as Row[];
  for (const s of stats) {
    const r = root(s.sessionId);
    const g = fams.get(r)!;
    g.tokens += s.tokens ?? 0;
    const c = costOf(s.model, {
      input: s.input ?? 0, output: s.output ?? 0, cacheRead: s.cacheRead ?? 0,
      cacheWrite: s.cacheWrite ?? 0, cacheWrite1h: s.cacheWrite1h ?? 0,
    });
    if (c != null) { g.cost += c; g.priced.add(s.sessionId); }
  }

  return [...fams.entries()].map(([rootId, g]): SessionFamily => ({
    root: rootId, sessions: g.sessions, childSessions: g.sessions - 1, totalSessions: g.sessions,
    tokens: g.tokens, cost: g.cost, pricedSessions: g.priced.size,
  })).sort((a, b) => b.tokens - a.tokens || a.root.localeCompare(b.root));
}

export function sessionTimeline(db: DB, id: string) {
  const turns = plain(db.prepare(`
    SELECT id, ts, model, input, output, cache_read AS cacheRead, cache_write AS cacheWrite,
           reasoning, (input + cache_read + cache_write) AS contextSize
    FROM events
    WHERE session_id = ? AND kind = 'assistant'
    ORDER BY ts ASC
  `).all(id)) as Array<{
    id: string;
    ts: number;
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    contextSize: number;
  }>;

  const findingRows = plain(db.prepare(`
    SELECT id, rule, confidence, confidence_reason AS confidenceReason, evidence,
           est_tokens_week AS estTokensWeek, first_seen AS firstSeen, last_seen AS lastSeen
    FROM findings
    WHERE session_id = ?
    ORDER BY last_seen ASC
  `).all(id)) as any[];

  const markers = findingRows.map((f) => {
    const ev = typeof f.evidence === 'string' ? JSON.parse(f.evidence) : f.evidence;
    let bestTurnIdx = 1;
    let minDiff = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < turns.length; i++) {
      const diff = Math.abs(turns[i].ts - (f.lastSeen || f.firstSeen));
      if (diff < minDiff) {
        minDiff = diff;
        bestTurnIdx = i + 1;
      }
    }
    return {
      turnIndex: bestTurnIdx,
      findingId: f.id,
      rule: f.rule,
      confidence: f.confidence,
      confidenceReason: f.confidenceReason,
      evidence: ev,
      estTokensWeek: f.estTokensWeek || 0,
      lastSeen: f.lastSeen,
    };
  });

  return {
    sessionId: id,
    turns: turns.map((t, i) => ({ ...t, turnIndex: i + 1 })),
    markers,
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

    const tokensPerCommit = effCommits > 0 ? Math.round(p.tokens / effCommits) : null;
    const tokensPerChangedLine = effLines > 0 ? Math.round(p.tokens / effLines) : null;

    const byAgent = Array.from(byAgentMap.entries()).map(([agent, data]) => ({
      agent,
      tokens: data.tokens,
      commits: data.commits,
      linesChanged: data.lines,
      tokensPerCommit: data.commits > 0 ? Math.round(data.tokens / data.commits) : null,
      tokensPerChangedLine: data.lines > 0 ? Math.round(data.tokens / data.lines) : null,
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
