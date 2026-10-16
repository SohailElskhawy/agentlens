import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, upsertFindings, upsertRecommendations } from '../src/db.ts';
import { startServer } from '../src/server.ts';
import type { Finding, Recommendation } from '../src/types.ts';

const db = openDb(':memory:');
const server = await startServer(db, 0);
const port = (server.address() as AddressInfo).port;
after(() => {
  server.close();
  db.close();
});

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
    }).on('error', reject).end();
  });
}

function post(path: string, payload: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let resData = '';
        res.on('data', (c) => (resData += c));
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(resData) }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('GET /api/findings returns findings and totalEstWeeklySavings', async () => {
  const f: Finding = {
    id: 'f1',
    rule: 'context_growth',
    projectId: null,
    sessionId: 's1',
    evidence: { peakTokens: 120_000 },
    confidence: 'high',
    confidenceReason: 'Peak 120k',
    estTokensWeek: 90_000,
    firstSeen: 1000,
    lastSeen: 2000,
  };
  upsertFindings(db, [f]);

  const res = await get('/api/findings');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.findings));
  assert.equal(res.body.findings.length, 1);
  assert.equal(res.body.findings[0].id, 'f1');
  assert.equal(res.body.totalEstWeeklySavings, 90_000);
});

test('GET /api/recommendations and POST /api/recommendations/:id/status updates status', async () => {
  const recId = 'rec:context_growth:global:f1';
  const rec: Recommendation = {
    id: recId,
    findingRule: 'context_growth',
    projectId: null,
    action: 'improve',
    title: 'Run /compact',
    body: 'Run /compact periodically',
    status: 'open',
  };
  upsertRecommendations(db, [rec]);

  const res1 = await get('/api/recommendations');
  assert.equal(res1.status, 200);
  assert.ok(Array.isArray(res1.body.recommendations));
  assert.equal(res1.body.recommendations[0].id, recId);
  assert.equal(res1.body.recommendations[0].status, 'open');

  // Test URL-encoded ID
  const updateRes = await post(`/api/recommendations/${encodeURIComponent(recId)}/status`, { status: 'accepted' });
  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.body.ok, true);
  assert.equal(updateRes.body.status, 'accepted');

  const res2 = await get('/api/recommendations');
  assert.equal(res2.body.recommendations[0].status, 'accepted');

  // Test invalid status returns 400
  const badStatusRes = await post(`/api/recommendations/${encodeURIComponent(recId)}/status`, { status: 'hacked_status' });
  assert.equal(badStatusRes.status, 400);

  // Test unknown ID returns 404
  const notFoundRes = await post('/api/recommendations/rec%3Anot%3Afound/status', { status: 'dismissed' });
  assert.equal(notFoundRes.status, 404);
});
