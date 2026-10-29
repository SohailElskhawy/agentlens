import type { DB } from './db.ts';
import { where } from './queries.ts';
import type { Agent, Filter } from './types.ts';

export const SPIKE_RATIO = 2.5;
export const MIN_SPIKE_TOKENS = 1_000_000;
export const BASELINE_DAYS = 7;
export const MIN_BASELINE_SAMPLES = 3;
const TOP_SESSIONS = 3;

export interface AnomalySession { sessionId: string; tokens: number; events: number; firstTs: number; lastTs: number }
export interface Anomaly {
  day: string;
  projectId: number | null;
  project: string | null;
  agent: Agent;
  tokens: number;
  baselineMedian: number;
  baselineSamples: number;
  ratio: number;
  topSessions: AnomalySession[];
}
export interface AnomalyResult {
  day: string;            // local calendar day being evaluated (the day of `asOf`)
  asOf: number;           // events after this instant are ignored
  partialDay: true;       // `day` is incomplete; it is compared against complete baseline days
  ratio: number;
  minTokens: number;
  baselineDays: number;
  minBaselineSamples: number;
  anomalies: Anomaly[];
}

export function formatLocalDay(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

interface Series { projectId: number | null; agent: Agent; today: number; base: number[] }

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Flags (project, agent) series whose tokens so far on the current local day are >= 2.5x the median of the
 * trailing 7 complete local days and >= 1M. Days with no tokens are not baseline samples, and fewer than 3
 * samples means no flag. `f.agent`/`f.projectId` narrow the series; `f.from`/`f.to` clip the events considered.
 */
export function detectAnomalies(db: DB, f: Filter = {}, now = Date.now()): AnomalyResult {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const windowStart = new Date(todayStart);
  windowStart.setDate(windowStart.getDate() - BASELINE_DAYS);
  const day = formatLocalDay(todayStart);
  const lo = (from: Date) => Math.max(f.from ?? 0, from.getTime());
  const hi = Math.min(f.to ?? Infinity, now + 1); // exclusive; never reads the future

  const w = where({ ...f, from: lo(windowStart), to: hi });
  const rows = db.prepare(`
    SELECT date(e.ts / 1000, 'unixepoch', 'localtime') AS day, s.project_id AS projectId, e.agent AS agent,
      sum(e.input + e.output + e.cache_read + e.cache_write) AS tokens
    FROM events e LEFT JOIN sessions s ON s.id = e.session_id
    WHERE e.kind = 'assistant'${w.sql} GROUP BY 1, 2, 3`).all(w.params) as { day: string; projectId: number | null; agent: Agent; tokens: number }[];

  const series = new Map<string, Series>();
  for (const r of rows) {
    if (r.tokens <= 0) continue;
    const key = `${r.projectId}|${r.agent}`;
    let s = series.get(key);
    if (!s) series.set(key, s = { projectId: r.projectId, agent: r.agent, today: 0, base: [] });
    if (r.day === day) s.today = r.tokens;
    else s.base.push(r.tokens);
  }

  const nameStmt = db.prepare('SELECT name FROM projects WHERE id = ?');

  const flagged: [Series, number][] = [];
  for (const s of series.values()) {
    if (s.base.length < MIN_BASELINE_SAMPLES || s.today < MIN_SPIKE_TOKENS) continue;
    const med = median(s.base);
    if (s.today >= med * SPIKE_RATIO) flagged.push([s, med]);
  }

  // One grouped scan of today's events for all flagged series (not one scan per series); rows arrive largest-first,
  // ties by session id, so the first TOP_SESSIONS rows seen per series are its top contributors.
  const top = new Map<string, AnomalySession[]>();
  if (flagged.length) {
    const t = where({ ...f, from: lo(todayStart), to: hi });
    const sessions = db.prepare(`
      SELECT s.project_id AS projectId, e.agent AS agent, e.session_id AS sessionId,
        sum(e.input + e.output + e.cache_read + e.cache_write) AS tokens, count(*) AS events, min(e.ts) AS firstTs, max(e.ts) AS lastTs
      FROM events e LEFT JOIN sessions s ON s.id = e.session_id
      WHERE e.kind = 'assistant'${t.sql} GROUP BY 1, 2, 3 ORDER BY tokens DESC, e.session_id`).all(t.params) as unknown as (AnomalySession & { projectId: number | null; agent: Agent })[];
    for (const r of sessions) {
      const key = `${r.projectId}|${r.agent}`;
      let list = top.get(key);
      if (!list) top.set(key, list = []);
      if (list.length < TOP_SESSIONS) list.push({ sessionId: r.sessionId, tokens: r.tokens, events: r.events, firstTs: r.firstTs, lastTs: r.lastTs });
    }
  }

  const anomalies: Anomaly[] = [];
  for (const [s, med] of flagged) {
    anomalies.push({
      day, projectId: s.projectId, project: s.projectId == null ? null : (nameStmt.get(s.projectId) as { name: string } | undefined)?.name ?? null,
      agent: s.agent, tokens: s.today, baselineMedian: med, baselineSamples: s.base.length,
      ratio: Number((s.today / med).toFixed(2)), topSessions: top.get(`${s.projectId}|${s.agent}`) ?? [],
    });
  }
  anomalies.sort((a, b) => b.tokens - a.tokens);
  return { day, asOf: now, partialDay: true, ratio: SPIKE_RATIO, minTokens: MIN_SPIKE_TOKENS, baselineDays: BASELINE_DAYS, minBaselineSamples: MIN_BASELINE_SAMPLES, anomalies };
}
