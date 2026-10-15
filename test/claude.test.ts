import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { claude } from '../src/adapters/claude.ts';
import { tmp, put, jsonl, cAssistant, cUser } from './helpers.ts';

function fixture() {
  const home = tmp();
  const file = put(join(home, '.claude/projects/-p/s1.jsonl'),
    jsonl(
      cUser({ uuid: 'u1', content: 'secret prompt text' }),
      cAssistant({ msg: 'm1', out: 10, content: [{ type: 'thinking', thinking: '' }] }),
      cAssistant({ msg: 'm1', out: 50, content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] }),
      cUser({ uuid: 'u2', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello', is_error: false }] }),
      { type: 'attachment', sessionId: 's1' },
    )
    + '{not json\n'
    + jsonl({ ...cAssistant({ msg: 'm9', req: 'r9', session: 's1' }), isSidechain: true, agentId: 'a1' }));
  return { home, file };
}

test('claude adapter normalizes usage, tools, prompts and subagents', () => {
  const { file } = fixture();
  const r = claude.read(file, { offset: 0, state: {} });
  const of = (k: string) => r.events.filter((e) => e.kind === k);

  const m1 = of('assistant').filter((e) => e.id === 'claude:m1:r1');
  assert.equal(m1.length, 2, 'one event per streamed line; the DB merges them');
  assert.deepEqual(
    { model: m1[1].model, input: m1[1].input, output: m1[1].output, cacheRead: m1[1].cacheRead, cacheWrite: m1[1].cacheWrite, cacheWrite1h: m1[1].cacheWrite1h, reasoning: m1[1].reasoning },
    { model: 'claude-opus-5-5', input: 2, output: 50, cacheRead: 100, cacheWrite: 50, cacheWrite1h: 50, reasoning: 3 },
  );

  const [call] = of('tool_call');
  assert.equal(call.id, 'claude:toolu_1');
  assert.equal(call.tool, 'Bash');
  assert.match(call.argsHash!, /^[0-9a-f]{16}$/);

  const [result] = of('tool_result');
  assert.deepEqual({ id: result.id, bytes: result.resultBytes, err: result.isError }, { id: 'claude:toolu_1:result', bytes: 5, err: false });

  const [prompt] = of('user');
  assert.equal(prompt.textLen, 18);
  assert.match(prompt.textHash!, /^[0-9a-f]{16}$/);

  const sub = r.events.find((e) => e.id === 'claude:m9:r9');
  assert.equal(sub?.sessionId, 'a1');
  assert.deepEqual(r.sessions.map((s) => [s.id, s.parentId]), [['s1', undefined], ['a1', 's1']]);
});

test('a malformed line is counted and skipped; the rest of the file still ingests', () => {
  const { file } = fixture();
  const r = claude.read(file, { offset: 0, state: {} });
  assert.equal(r.errors, 1);
  assert.ok(r.events.some((e) => e.id === 'claude:m9:r9'), 'line after the bad one was read');
  assert.equal(r.cursor.offset, statSync(file).size);
});

test('prompt and tool text never leave the adapter', () => {
  const { file } = fixture();
  const out = JSON.stringify(claude.read(file, { offset: 0, state: {} }));
  assert.ok(!out.includes('secret prompt'));
  assert.ok(!out.includes('hello'));
});

test('discover finds main session files and subagent files', () => {
  const { home, file } = fixture();
  const sub = put(join(home, '.claude/projects/-p/s1/subagents/agent-a1.jsonl'), '');
  assert.deepEqual(claude.discover(claude.root(home)).sort(), [file, sub].sort());
  assert.deepEqual(claude.discover(join(home, 'missing')), []);
});

test('root ignores an ambient CLAUDE_CONFIG_DIR unless home is the real home', () => {
  const home = tmp();
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/nonexistent/cc';
  try {
    assert.equal(claude.root(home), join(home, '.claude', 'projects'));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('a non-object JSON line is counted and skipped, and a null content block does not abort the read', () => {
  const home = tmp();
  const file = put(join(home, '.claude/projects/-p/s1.jsonl'),
    jsonl(cAssistant({ msg: 'a1', req: 'ra' }))
    + 'null\n'
    + jsonl(
      cAssistant({ msg: 'b1', req: 'rb', content: [null, { type: 'tool_use', id: 'toolu_9', name: 'Read', input: {} }] }),
      cUser({ uuid: 'u9', content: [null, { type: 'text', text: 'hi' }] }),
    ));
  const r = claude.read(file, { offset: 0, state: {} });
  assert.equal(r.errors, 1);
  assert.ok(r.events.some((e) => e.id === 'claude:a1:ra'));
  assert.ok(r.events.some((e) => e.id === 'claude:b1:rb'));
  assert.ok(r.events.some((e) => e.id === 'claude:toolu_9'));
  assert.ok(r.events.some((e) => e.id === 'claude:u9'));
  assert.equal(r.cursor.offset, statSync(file).size);
});
