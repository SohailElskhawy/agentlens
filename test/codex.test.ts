import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { codex } from '../src/adapters/codex.ts';
import { tmp, put, jsonl } from './helpers.ts';

const ID = '01a14053-9cd4-7a63-8d1d-89bf3480152f';
const t = (s: number) => `2026-10-15T10:00:${String(s).padStart(2, '0')}.000Z`;
const usage = { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 1050 };
const head = [
  { timestamp: t(0), type: 'session_meta', payload: { id: ID, cwd: '/work/app' } },
  { timestamp: t(1), type: 'turn_context', payload: { model: 'gpt-6.1-sol', cwd: '/work/app' } },
];
const rest = [
  { timestamp: t(2), type: 'event_msg', payload: { type: 'user_message', message: 'secret codex prompt' } },
  { timestamp: t(3), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: null } },
  { timestamp: t(4), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"cmd":"ls"}' } },
  { timestamp: t(5), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'abc' } },
  { timestamp: t(6), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'x' } },
  { timestamp: t(7), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: [{ type: 'input_text', text: 'ok' }] } },
  { timestamp: t(8), type: 'event_msg', payload: {
    type: 'token_count',
    info: { total_token_usage: usage, last_token_usage: usage },
    rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1792098588 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1792650545 } },
  } },
];

test('codex adapter: incremental read keeps model and cwd, subtracts cached input, records quota', () => {
  const home = tmp();
  const file = put(join(home, `.codex/sessions/2026/10/15/rollout-2026-10-15T10-00-00-${ID}.jsonl`), jsonl(...head));
  const first = codex.read(file, { offset: 0, state: {} });
  appendFileSync(file, jsonl(...rest));
  const r = codex.read(file, first.cursor);

  const turn = r.events.find((e) => e.kind === 'assistant')!;
  assert.deepEqual(
    { id: turn.id, sessionId: turn.sessionId, model: turn.model, input: turn.input, cacheRead: turn.cacheRead, output: turn.output, reasoning: turn.reasoning },
    { id: `codex:${ID}:1050`, sessionId: ID, model: 'gpt-6.1-sol', input: 400, cacheRead: 600, output: 50, reasoning: 20 },
  );
  assert.deepEqual(r.sessions, [{ id: ID, agent: 'codex', cwd: '/work/app' }]);
  assert.deepEqual(r.quotas.map((q) => [q.window, q.usedPct, q.resetsAt, q.ts]), [
    ['5h', 12.5, 1792098588000, Date.parse(t(8))],
    ['7d', 40, 1792650545000, Date.parse(t(8))],
  ]);
  assert.deepEqual(r.events.filter((e) => e.kind === 'tool_call').map((e) => [e.id, e.tool]), [['codex:c1', 'shell'], ['codex:c2', 'exec']]);
  assert.deepEqual(r.events.filter((e) => e.kind === 'tool_result').map((e) => [e.id, e.resultBytes]), [
    ['codex:c1:result', 3],
    ['codex:c2:result', Buffer.byteLength(JSON.stringify([{ type: 'input_text', text: 'ok' }]))],
  ]);
  assert.equal(r.events.filter((e) => e.kind === 'user').length, 1);
  assert.ok(!JSON.stringify(r).includes('secret codex prompt'));
});

test('codex discover walks the dated session tree', () => {
  const home = tmp();
  const f = put(join(home, `.codex/sessions/2026/10/15/rollout-x-${ID}.jsonl`), '');
  put(join(home, '.codex/sessions/2026/10/15/notes.txt'), '');
  assert.deepEqual(codex.discover(codex.root(home)), [f]);
});

test('codex root ignores an ambient CODEX_HOME unless home is the real home', () => {
  const home = tmp();
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = '/nonexistent/cx';
  try {
    assert.equal(codex.root(home), join(home, '.codex', 'sessions'));
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});

test('codex: record types the adapter ignores are not parsed; wanted records around them still ingest', () => {
  const home = tmp();
  const file = put(join(home, `.codex/sessions/2026/10/15/rollout-2026-10-15T10-00-00-${ID}.jsonl`),
    jsonl(head[0], rest[2])
    + jsonl({ timestamp: t(9), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'reasoning', summary: 'y'.repeat(999) } } })
    + jsonl(rest[3], rest[4]));
  const r = codex.read(file, { offset: 0, state: {} });
  assert.deepEqual(r.events.map((e) => [e.id, e.kind]), [
    ['codex:c1', 'tool_call'],
    ['codex:c1:result', 'tool_result'],
    ['codex:c2', 'tool_call'],
  ]);
  assert.ok(!JSON.stringify(r).includes('yyyy'));
});

test('codex: a line whose head shows no type marker is parsed anyway (no silent data loss)', () => {
  const home = tmp();
  const line = JSON.stringify({ junk: 'z'.repeat(400), ...rest[6] });
  const file = put(join(home, `.codex/sessions/2026/10/15/rollout-2026-10-15T10-00-00-${ID}.jsonl`), jsonl(head[0]) + line + '\n');
  const r = codex.read(file, { offset: 0, state: {} });
  assert.equal(r.events.filter((e) => e.kind === 'assistant').length, 1);
  assert.equal(r.sessions[0].cwd, '/work/app');
});

test('codex: a non-object JSON line is counted and skipped; later records still ingest', () => {
  const home = tmp();
  const file = put(join(home, `.codex/sessions/2026/10/15/rollout-2026-10-15T10-00-00-${ID}.jsonl`),
    jsonl(head[0]) + 'null\n' + jsonl(head[1], rest[2], rest[3]));
  const r = codex.read(file, { offset: 0, state: {} });
  assert.equal(r.errors, 1);
  assert.deepEqual(r.events.map((e) => e.id), ['codex:c1', 'codex:c1:result']);
  assert.equal(r.sessions[0].cwd, '/work/app');
});
