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
