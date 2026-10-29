import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, setSetting, upsertEvents, upsertProject, upsertSessions } from '../src/db.ts';
import { startServer } from '../src/server.ts';
import { formatLocalDay } from '../src/anomaly.ts';

test('explain endpoint enforces origin and byte limit, consent and cache', async () => {
  const db = openDb(':memory:');
  const pid = upsertProject(db, '/private/work', 'project');
  upsertSessions(db, [{ id: 's', agent: 'claude', projectId: pid, cwd: '/private/work' }]);
  const day = new Date(); day.setDate(day.getDate() - 1); day.setHours(12, 0, 0, 0);
  for (let d = 0; d <= 7; d++) {
    const date = new Date(day); date.setDate(date.getDate() - d);
    upsertEvents(db, [{ id: `e${d}`, sessionId: 's', agent: 'claude', ts: date.getTime(), kind: 'assistant', input: d ? 400_000 : 1_500_000 }]);
  }
  let calls = 0; let sent = '';
  const server = await startServer(db, 0, '127.0.0.1', { aiRunner: async prompt => { calls++; sent = prompt; return { ok: true, text: '{"explanation":"Possible increased usage."}' }; } });
  const port = (server.address() as AddressInfo).port;
  const post = (value: unknown, origin?: string): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/ai/explain', method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) } }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => { let body: any = text; try { body = JSON.parse(text); } catch {} resolve({ status: res.statusCode!, body }); });
    }); req.on('error', reject); req.end(JSON.stringify(value));
  });
  try {
    const input = { date: formatLocalDay(day), project: String(pid), agent: 'claude' };
    assert.equal((await post(input, 'https://evil.example')).status, 403);
    assert.equal((await post({ ...input, pad: 'é'.repeat(9000) })).status, 413);
    assert.equal((await post({ date: 5 })).status, 400);
    assert.equal((await post(input)).status, 403);
    setSetting(db, 'ai_enabled', 'true');
    const preview = (await post(input)).body.preview;
    assert.ok(preview.prompt.length <= 12000); assert.ok(!preview.prompt.includes('/private/work'));
    assert.equal((await post({ ...input, confirm: 'stale' })).body.status, 'confirmation_required');
    assert.equal(calls, 0);
    const result = await post({ ...input, confirm: preview.confirmationHash });
    assert.equal(result.body.status, 'ok'); assert.equal(sent, preview.prompt);
    assert.equal((await post(input)).body.cached, true); assert.equal(calls, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); }
});
