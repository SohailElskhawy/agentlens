import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setCursor, upsertEvents } from '../src/db.ts';
import { checkHealth } from '../src/health.ts';

test('checkHealth returns healthy status on clean db', () => {
  const db = openDb(':memory:');
  const h = checkHealth(db);
  assert.equal(h.status, 'healthy');
  assert.equal(h.warnings.length, 0);
  assert.deepEqual(h.sources, []);
  assert.deepEqual(h.events, []);
});

test('checkHealth flags warnings when cursors report bad lines', () => {
  const db = openDb(':memory:');
  setCursor(db, '/path/to/log.jsonl', 'claude', { offset: 100, state: {} }, 5);
  const h = checkHealth(db);
  assert.equal(h.status, 'warning');
  assert.ok(h.warnings.some((w) => w.includes('claude') && w.includes('5 bad lines')));
});

test('checkHealth detects crossCheck drift against ccusage daily totals', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  const dateStr = (db.prepare("SELECT date('now', 'localtime') AS d").get() as { d: string }).d;

  // Ingest 100,000 tokens for claude
  upsertEvents(db, [
    {
      id: 'e1',
      agent: 'claude',
      sessionId: 's1',
      ts: now,
      kind: 'assistant',
      input: 50_000,
      output: 50_000,
    },
  ]);

  // Mock ccusage daily output with drift > 5% (reports 80,000 tokens -> 20% diff)
  const mockRunner = (agent: string) => {
    if (agent === 'claude') {
      return {
        daily: [
          {
            date: dateStr,
            totalTokens: 80_000,
          },
        ],
      };
    }
    return { daily: [] };
  };

  const h = checkHealth(db, mockRunner);
  assert.equal(h.status, 'warning');
  assert.ok(h.crossCheck);
  assert.ok(h.crossCheck.length > 0);
  const match = h.crossCheck.find((c) => c.agent === 'claude' && c.date === dateStr);
  assert.ok(match);
  assert.equal(match.agentlensTokens, 100_000);
  assert.equal(match.ccusageTokens, 80_000);
  assert.equal(match.warning, true);
  assert.ok(h.warnings.some((w) => w.includes('drift') && w.includes('20.0%')));
});
