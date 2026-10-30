import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { detectAnomalies } from '../src/anomaly.ts';
import { openDb, upsertEvents, upsertProject, upsertSessions } from '../src/db.ts';
import type { DB } from '../src/db.ts';
import { startServer } from '../src/server.ts';
import { writeSummary } from '../src/summary.ts';
import type { Agent } from '../src/types.ts';
import { tmp } from './helpers.ts';

const NOW = new Date(2026, 9, 20, 15, 0, 0).getTime(); // local 2026-10-20 15:00
const atDay = (now: number, daysAgo: number, hour = 12) => {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

let seq = 0;
function seed(db: DB, o: { project?: string; agent?: Agent; session?: string; ts: number; tokens?: number; extra?: Record<string, number> }) {
  const project = o.project ?? 'a';
  const agent = o.agent ?? 'claude';
  const session = o.session ?? `${project}-${agent}-s`;
  const pid = upsertProject(db, `/work/${project}`, project);
  upsertSessions(db, [{ id: session, agent, cwd: `/work/${project}`, projectId: pid }]);
  upsertEvents(db, [{ id: `e${seq++}`, agent, sessionId: session, ts: o.ts, kind: 'assistant', model: 'm', input: o.tokens ?? 0, ...o.extra }]);
  return pid;
}
const baseline = (db: DB, tokens: number, days: number[], o: { project?: string; agent?: Agent; now?: number } = {}) => {
  for (const d of days) seed(db, { ...o, ts: atDay(o.now ?? NOW, d), tokens });
};
const D1_7 = [1, 2, 3, 4, 5, 6, 7];

test('empty db: no anomalies, reports the evaluated day', () => {
  const r = detectAnomalies(openDb(':memory:'), {}, NOW);
  assert.deepEqual(r.anomalies, []);
  assert.equal(r.day, '2026-10-20');
  assert.equal(r.partialDay, true);
  assert.equal(r.asOf, NOW);
  assert.equal(r.minTokens, 1_000_000);
  assert.equal(r.ratio, 2.5);
});

test('spike: flags a day >= 2.5x trailing median and >= 1M tokens', () => {
  const db = openDb(':memory:');
  baseline(db, 400_000, D1_7);
  seed(db, { ts: atDay(NOW, 0, 10), tokens: 1_200_000 });
  const [a, ...rest] = detectAnomalies(db, {}, NOW).anomalies;
  assert.equal(rest.length, 0);
  assert.equal(a.day, '2026-10-20');
  assert.equal(a.project, 'a');
  assert.equal(a.agent, 'claude');
  assert.equal(a.tokens, 1_200_000);
  assert.equal(a.baselineMedian, 400_000);
  assert.equal(a.baselineSamples, 7);
  assert.equal(a.ratio, 3);
});

test('non-spike: 2x median, or 2.5x but under 1M, is not flagged', () => {
  const db = openDb(':memory:');
  baseline(db, 600_000, D1_7);
  seed(db, { ts: atDay(NOW, 0, 10), tokens: 1_200_000 });
  baseline(db, 100_000, D1_7, { project: 'small' });
  seed(db, { project: 'small', ts: atDay(NOW, 0, 10), tokens: 900_000 });
  assert.deepEqual(detectAnomalies(db, {}, NOW).anomalies, []);
});

test('sparse history: needs 3 non-empty baseline days; empty days are not zeros', () => {
  const db = openDb(':memory:');
  seed(db, { ts: atDay(NOW, 0, 10), tokens: 5_000_000 });
  assert.deepEqual(detectAnomalies(db, {}, NOW).anomalies, [], 'no baseline');
  baseline(db, 100_000, [2, 5]);
  assert.deepEqual(detectAnomalies(db, {}, NOW).anomalies, [], 'two samples');
  baseline(db, 300_000, [7]);
  const [a] = detectAnomalies(db, {}, NOW).anomalies;
  assert.equal(a.baselineSamples, 3);
  assert.equal(a.baselineMedian, 100_000); // median of 100k,100k,300k, not of 7 days with zero-filled gaps
});

test('baseline ignores today, days older than 7, and even counts use the mean of the middle two', () => {
  const db = openDb(':memory:');
  baseline(db, 10_000_000, [8, 9]); // outside the trailing window
  baseline(db, 200_000, [1, 2]);
  baseline(db, 400_000, [3, 4]);
  seed(db, { ts: atDay(NOW, 0, 9), tokens: 900_000 });
  seed(db, { ts: atDay(NOW, 0, 11), tokens: 100_000 }); // same day: summed
  const [a] = detectAnomalies(db, {}, NOW).anomalies;
  assert.equal(a.baselineSamples, 4);
  assert.equal(a.baselineMedian, 300_000);
  assert.equal(a.tokens, 1_000_000);
});

test('projects and agents are separate series', () => {
  const db = openDb(':memory:');
  baseline(db, 400_000, D1_7, { project: 'a', agent: 'claude' });
  baseline(db, 2_000_000, D1_7, { project: 'a', agent: 'codex' });
  baseline(db, 2_000_000, D1_7, { project: 'b', agent: 'claude' });
  seed(db, { project: 'a', agent: 'claude', ts: atDay(NOW, 0, 10), tokens: 1_500_000 });
  seed(db, { project: 'a', agent: 'codex', ts: atDay(NOW, 0, 10), tokens: 1_500_000 });
  seed(db, { project: 'b', agent: 'claude', ts: atDay(NOW, 0, 10), tokens: 1_500_000 });
  const r = detectAnomalies(db, {}, NOW).anomalies;
  assert.deepEqual(r.map((a) => [a.project, a.agent]), [['a', 'claude']]);
});

test('threshold equality is inclusive on both the ratio and the token floor', () => {
  const db = openDb(':memory:');
  baseline(db, 400_000, D1_7);
  seed(db, { ts: atDay(NOW, 0, 10), tokens: 999_999 });
  assert.equal(detectAnomalies(db, {}, NOW).anomalies.length, 0);
  seed(db, { ts: atDay(NOW, 0, 11), tokens: 1 }); // exactly 1,000,000 = 2.5 x 400,000
  const [a] = detectAnomalies(db, {}, NOW).anomalies;
  assert.equal(a.tokens, 1_000_000);
  assert.equal(a.ratio, 2.5);
});

test('counts input+output+cache_read+cache_write once; ignores reasoning and cache_write_1h; excludes future events', () => {
  const db = openDb(':memory:');
  baseline(db, 100_000, D1_7);
  seed(db, { ts: atDay(NOW, 0, 10), extra: { input: 100_000, output: 200_000, cacheRead: 300_000, cacheWrite: 400_000, cacheWrite1h: 400_000, reasoning: 150_000 } });
  seed(db, { ts: NOW + 3600_000, tokens: 50_000_000 }); // later today, not yet happened
  seed(db, { ts: atDay(NOW, -1), tokens: 50_000_000 }); // tomorrow
  const [a] = detectAnomalies(db, {}, NOW).anomalies;
  assert.equal(a.tokens, 1_000_000 + 0); // input (tokens=0 default) + components above
  assert.equal(detectAnomalies(db, {}, NOW - 3600_000 * 6).anomalies.length, 0); // 09:00: nothing yet today
});

test('top contributors: up to 3 sessions, largest first, structured metadata only', () => {
  const db = openDb(':memory:');
  baseline(db, 400_000, D1_7);
  const t = atDay(NOW, 0, 9);
  seed(db, { session: 's-small', ts: t, tokens: 100_000 });
  seed(db, { session: 's-big', ts: t, tokens: 600_000 });
  seed(db, { session: 's-big', ts: t + 60_000, tokens: 100_000 });
  seed(db, { session: 's-mid', ts: t, tokens: 300_000 });
  seed(db, { session: 's-tiny', ts: t, tokens: 10_000 });
  seed(db, { project: 'other', session: 's-other', ts: t, tokens: 9_000_000 }); // different series
  const [a] = detectAnomalies(db, {}, NOW).anomalies;
  assert.deepEqual(a.topSessions, [
    { sessionId: 's-big', tokens: 700_000, events: 2, firstTs: t, lastTs: t + 60_000 },
    { sessionId: 's-mid', tokens: 300_000, events: 1, firstTs: t, lastTs: t },
    { sessionId: 's-small', tokens: 100_000, events: 1, firstTs: t, lastTs: t },
  ]);
});

// Runs fn with process.env.TZ set (node re-reads it immediately, SQLite 'localtime' follows).
function inZone<T>(zone: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = zone;
  try { return fn(); } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
}

test('DST fall-back: 25-hour day sums once; window starts at local midnight, not 7*24h back', () => {
  inZone('America/New_York', () => {
    const at = (m: number, d: number, h: number, min = 0) => new Date(2026, m, d, h, min).getTime();
    const now = at(10, 2, 15); // Mon 2026-11-02 15:00 EST, day after the Nov 1 25-hour day
    const db = openDb(':memory:');
    seed(db, { ts: at(9, 25, 23, 30), tokens: 9_000_000 }); // Oct 25: outside the 7-day window
    seed(db, { ts: at(9, 26, 0, 30), tokens: 400_000 });    // 00:30 EDT = 23:30 EST-hours before a naive now-168h cut
    seed(db, { ts: at(9, 28, 12), tokens: 400_000 });
    seed(db, { ts: at(10, 1, 0, 30), tokens: 150_000 });    // 00:30 EDT
    seed(db, { ts: Date.UTC(2026, 10, 1, 5, 30), tokens: 150_000 }); // 01:30 EDT (first 1am)
    seed(db, { ts: Date.UTC(2026, 10, 1, 6, 30), tokens: 100_000 }); // 01:30 EST (second 1am)
    seed(db, { ts: at(10, 2, 0, 0), tokens: 1_000_000 });   // exactly local midnight: today
    seed(db, { ts: at(10, 1, 23, 59), tokens: 1 });         // last minute of yesterday: baseline
    const [a] = detectAnomalies(db, {}, now).anomalies;
    assert.equal(a.day, '2026-11-02');
    assert.equal(a.tokens, 1_000_000);
    assert.equal(a.baselineSamples, 3); // Oct 26, Oct 28, Nov 1
    assert.equal(a.baselineMedian, 400_000); // Nov 1 = 150k+150k+100k+1 = 400,001 summed once; median of 400k, 400k, 400,001
    assert.deepEqual(a.topSessions.map((t) => t.tokens), [1_000_000]);
  });
});

test('DST spring-forward: 23-hour day; window excludes the hour a 168h cut would pull in', () => {
  inZone('America/New_York', () => {
    const at = (m: number, d: number, h: number, min = 0) => new Date(2026, m, d, h, min).getTime();
    const now = at(2, 9, 15); // Mon 2026-03-09 15:00 EDT, day after Mar 8 (23 hours)
    const db = openDb(':memory:');
    seed(db, { ts: at(2, 1, 23, 30), tokens: 9_000_000 }); // Mar 1 23:30 EST: outside (naive now-168h would include it)
    seed(db, { ts: at(2, 2, 0, 30), tokens: 400_000 });    // Mar 2 00:30: inside
    seed(db, { ts: at(2, 5, 12), tokens: 400_000 });
    seed(db, { ts: at(2, 8, 0, 30), tokens: 200_000 });    // EST, before the jump
    seed(db, { ts: at(2, 8, 3, 30), tokens: 200_000 });    // EDT, after the jump (2:xx does not exist)
    seed(db, { ts: at(2, 9, 8), tokens: 1_000_000 });
    const [a] = detectAnomalies(db, {}, now).anomalies;
    assert.equal(a.baselineSamples, 3);
    assert.equal(a.baselineMedian, 400_000);
    assert.equal(a.tokens, 1_000_000);
  });
});

test('DST: evaluating on the transition day itself keeps all of its events in "today"', () => {
  inZone('America/New_York', () => {
    const now = Date.UTC(2026, 10, 1, 20, 0); // 15:00 EST on the 25-hour day
    const db = openDb(':memory:');
    for (const d of [2, 3, 4]) seed(db, { ts: new Date(2026, 9, 32 - d, 12).getTime(), tokens: 400_000 }); // Oct 30, 29, 28
    seed(db, { ts: new Date(2026, 10, 1, 0, 30).getTime(), tokens: 300_000, session: 'early' });   // 00:30 EDT
    seed(db, { ts: Date.UTC(2026, 10, 1, 5, 30), tokens: 300_000, session: 'first-1am' });         // 01:30 EDT
    seed(db, { ts: Date.UTC(2026, 10, 1, 6, 30), tokens: 400_000, session: 'second-1am' });        // 01:30 EST
    const [a] = detectAnomalies(db, {}, now).anomalies;
    assert.equal(a.tokens, 1_000_000);
    assert.deepEqual(a.topSessions.map((t) => t.sessionId), ['second-1am', 'early', 'first-1am']);
    assert.equal(a.topSessions.reduce((n, t) => n + t.tokens, 0), a.tokens);
  });
});

test('null-project series: sessions without a project and events without a session row are flagged with contributors', () => {
  const db = openDb(':memory:');
  const raw = (ts: number, session: string, tokens: number, withSession: boolean) => {
    if (withSession) upsertSessions(db, [{ id: session, agent: 'claude', projectId: null }]);
    upsertEvents(db, [{ id: `n${seq++}`, agent: 'claude', sessionId: session, ts, kind: 'assistant', model: 'm', input: tokens }]);
  };
  for (const d of D1_7) raw(atDay(NOW, d), 'nb', 400_000, true);
  raw(atDay(NOW, 0, 9), 'no-project', 700_000, true);
  raw(atDay(NOW, 0, 10), 'orphan', 500_000, false); // no sessions row at all
  baseline(db, 400_000, D1_7, { project: 'named' });
  seed(db, { project: 'named', session: 'named-s', ts: atDay(NOW, 0, 9), tokens: 1_500_000 });
  const r = detectAnomalies(db, {}, NOW).anomalies;
  const nul = r.find((a) => a.projectId === null)!;
  assert.equal(nul.project, null);
  assert.equal(nul.tokens, 1_200_000);
  assert.deepEqual(nul.topSessions.map((t) => [t.sessionId, t.tokens]), [['no-project', 700_000], ['orphan', 500_000]]);
  assert.deepEqual(r.find((a) => a.projectId !== null)!.topSessions.map((t) => t.sessionId), ['named-s']); // not polluted by null series
});

test('from/to bounds: from inclusive, to exclusive, contributors always sum to the flagged tokens', () => {
  const db = openDb(':memory:');
  baseline(db, 400_000, D1_7);
  const t = atDay(NOW, 0, 9);
  seed(db, { session: 'a', ts: t, tokens: 600_000 });
  seed(db, { session: 'b', ts: t + 1000, tokens: 400_000 });
  seed(db, { session: 'c', ts: t + 2000, tokens: 800_000 });
  seed(db, { session: 'd', ts: t + 3000, tokens: 700_000 });
  const sum = (a: { topSessions: { tokens: number }[] }) => a.topSessions.reduce((n, s) => n + s.tokens, 0);
  // `to` is exclusive: the event stamped exactly `to` is in neither the total nor the contributors
  const [a] = detectAnomalies(db, { to: t + 2000 }, NOW).anomalies;
  assert.equal(a.tokens, 1_000_000);
  assert.deepEqual(a.topSessions.map((s) => s.sessionId), ['a', 'b']);
  assert.equal(a.baselineSamples, 7);
  const [b] = detectAnomalies(db, { to: t + 2001 }, NOW).anomalies;
  assert.deepEqual(b.topSessions.map((s) => s.sessionId), ['c', 'a', 'b']);
  assert.equal(sum(b), b.tokens);
  const [all] = detectAnomalies(db, {}, NOW).anomalies;
  assert.equal(all.tokens, 2_500_000);
  assert.deepEqual(all.topSessions.map((s) => s.sessionId), ['c', 'd', 'a']); // top 3 of 4, 'b' dropped
  assert.equal(detectAnomalies(db, { to: t }, NOW).anomalies.length, 0, 'to == first event: nothing today');
  // `from` is inclusive and clips the baseline: noon of day 3 keeps days 1..3, one ms later leaves two samples
  const f3 = atDay(NOW, 3);
  const [c] = detectAnomalies(db, { from: f3 }, NOW).anomalies;
  assert.equal(c.baselineSamples, 3);
  assert.equal(c.tokens, 2_500_000);
  assert.equal(detectAnomalies(db, { from: f3 + 1 }, NOW).anomalies.length, 0);
  assert.equal(detectAnomalies(db, { from: atDay(NOW, 0, 0) }, NOW).anomalies.length, 0, 'from at today clips away the baseline');
  assert.equal(detectAnomalies(db, { from: NOW + 1 }, NOW).anomalies.length, 0, 'from in the future: nothing');
});

test('top contributors: ties break by session id, and the filter narrows them like the series', () => {
  const db = openDb(':memory:');
  baseline(db, 400_000, D1_7);
  baseline(db, 400_000, D1_7, { agent: 'codex' });
  const t = atDay(NOW, 0, 9);
  for (const s of ['s-d', 's-b', 's-c', 's-a']) seed(db, { session: s, ts: t, tokens: 300_000 });
  seed(db, { agent: 'codex', session: 'x-codex', ts: t, tokens: 5_000_000 });
  const [a] = detectAnomalies(db, { agent: 'claude' }, NOW).anomalies;
  assert.deepEqual(a.topSessions.map((s) => s.sessionId), ['s-a', 's-b', 's-c']);
  assert.deepEqual(detectAnomalies(db, { agent: 'codex' }, NOW).anomalies[0].topSessions.map((s) => s.sessionId), ['x-codex']);
});

test('API filters: project and agent narrow the series like other endpoints', async () => {
  const db = openDb(':memory:');
  const now = Date.now();
  for (const [project, agent] of [['a', 'claude'], ['b', 'claude'], ['a', 'codex']] as const) {
    baseline(db, 400_000, D1_7, { project, agent, now });
    seed(db, { project, agent, ts: now - 1, tokens: 1_500_000 });
  }
  const server = await startServer(db, 0);
  after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const get = (path: string) => new Promise<any>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    }).on('error', reject).end();
  });
  const all = await get('/api/anomalies');
  assert.equal(all.status, 200);
  assert.equal(all.body.anomalies.length, 3);
  const pid = (db.prepare(`SELECT id FROM projects WHERE name = 'b'`).get() as { id: number }).id;
  const one = await get(`/api/anomalies?project=${pid}`);
  assert.deepEqual(one.body.anomalies.map((a: any) => [a.project, a.agent]), [['b', 'claude']]);
  const codex = await get('/api/anomalies?agent=codex');
  assert.deepEqual(codex.body.anomalies.map((a: any) => [a.project, a.agent]), [['a', 'codex']]);
});

test('API: omitted from still sees the 7-day baseline; to-only and from-today behave like detectAnomalies', async () => {
  const db = openDb(':memory:');
  const now = Date.now();
  baseline(db, 400_000, D1_7, { now });
  seed(db, { ts: now - 1, tokens: 1_500_000 });
  const server = await startServer(db, 0);
  after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const get = (path: string) => new Promise<any>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject).end();
  });
  const bare = await get('/api/anomalies');
  assert.equal(bare.anomalies.length, 1);
  assert.equal(bare.anomalies[0].baselineSamples, 7);
  assert.equal((await get(`/api/anomalies?to=${now + 86_400_000}`)).anomalies[0].baselineSamples, 7, 'future to is clamped, not widened');
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  assert.equal((await get(`/api/anomalies?from=${midnight.getTime()}`)).anomalies.length, 0, 'from=today leaves no baseline');
  assert.equal((await get('/api/anomalies?from=')).anomalies.length, 1, 'blank from is omitted');
});

test('writeSummary includes anomalies', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  baseline(db, 400_000, D1_7, { now });
  seed(db, { ts: now - 1, tokens: 1_500_000 });
  const path = join(tmp(), 'summary.json');
  writeSummary(db, path);
  const s = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(s.anomalies.anomalies.length, 1);
  assert.equal(s.anomalies.anomalies[0].baselineSamples, 7);
  assert.equal(typeof s.anomalies.day, 'string');
});
