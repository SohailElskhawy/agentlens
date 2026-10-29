import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertEvents, upsertProject, upsertSessions, getFindings } from '../src/db.ts';
import { detectRetryLoops } from '../src/analyze/retry_loop.ts';
import { detectHotFiles } from '../src/analyze/hot_files.ts';
import { detectLargeToolOutput } from '../src/analyze/large_tool_output.ts';
import { runDetectors } from '../src/analyze/runner.ts';

test('detectRetryLoops detects repeated identical tool calls and error retries', () => {
  const db = openDb(':memory:');
  const pId = upsertProject(db, '/work/repo', 'repo');
  upsertSessions(db, [{ id: 's1', agent: 'claude', cwd: '/work/repo', projectId: pId }]);

  const now = Date.now();
  upsertEvents(db, [
    // 3 identical Bash calls
    { id: 'e1', agent: 'claude', sessionId: 's1', ts: now + 100, kind: 'tool_call', tool: 'Bash', argsHash: 'args_bash_test', isError: false },
    { id: 'e2', agent: 'claude', sessionId: 's1', ts: now + 200, kind: 'tool_call', tool: 'Bash', argsHash: 'args_bash_test', isError: false },
    { id: 'e3', agent: 'claude', sessionId: 's1', ts: now + 300, kind: 'tool_call', tool: 'Bash', argsHash: 'args_bash_test', isError: false },
    // 1 unique Read call
    { id: 'e4', agent: 'claude', sessionId: 's1', ts: now + 400, kind: 'tool_call', tool: 'Read', argsHash: 'args_read_once', isError: false },
  ]);

  const findings = detectRetryLoops(db);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'retry_loop');
  assert.equal(findings[0].sessionId, 's1');
  assert.equal(findings[0].projectId, pId);
  assert.equal(findings[0].evidence.tool, 'Bash');
  assert.equal(findings[0].evidence.count, 3);
  assert.ok(findings[0].estTokensWeek > 0);
});

test('detectHotFiles detects files read repeatedly across turns', () => {
  const db = openDb(':memory:');
  const pId = upsertProject(db, '/work/repo', 'repo');
  upsertSessions(db, [{ id: 's1', agent: 'claude', cwd: '/work/repo', projectId: pId }]);

  const now = Date.now();
  upsertEvents(db, [
    { id: 'e1', agent: 'claude', sessionId: 's1', ts: now + 100, kind: 'tool_call', tool: 'ReadFile', argsHash: 'hash_config_json' },
    { id: 'e2', agent: 'claude', sessionId: 's1', ts: now + 200, kind: 'tool_call', tool: 'ReadFile', argsHash: 'hash_config_json' },
    { id: 'e3', agent: 'claude', sessionId: 's1', ts: now + 300, kind: 'tool_call', tool: 'ReadFile', argsHash: 'hash_config_json' },
    { id: 'e4', agent: 'claude', sessionId: 's1', ts: now + 400, kind: 'tool_call', tool: 'ReadFile', argsHash: 'hash_config_json' },
  ]);

  const findings = detectHotFiles(db);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'hot_files');
  assert.equal(findings[0].evidence.reads, 4);
  assert.ok(findings[0].estTokensWeek >= 6000);
});

test('detectLargeToolOutput detects massive tool responses', () => {
  const db = openDb(':memory:');
  const pId = upsertProject(db, '/work/repo', 'repo');
  upsertSessions(db, [{ id: 's1', agent: 'claude', cwd: '/work/repo', projectId: pId }]);

  const now = Date.now();
  upsertEvents(db, [
    // Normal output 4KB
    { id: 'e1:result', agent: 'claude', sessionId: 's1', ts: now + 100, kind: 'tool_result', resultBytes: 4096 },
    // Outlier output 120KB
    { id: 'e2:result', agent: 'claude', sessionId: 's1', ts: now + 200, kind: 'tool_result', resultBytes: 120_000 },
  ]);

  const findings = detectLargeToolOutput(db);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'large_tool_output');
  assert.equal(findings[0].evidence.resultBytes, 120_000);
  assert.ok(findings[0].estTokensWeek > 25_000);
});

test('runDetectors executes all detectors and upserts into database', () => {
  const db = openDb(':memory:');
  const pId = upsertProject(db, '/work/repo', 'repo');
  upsertSessions(db, [{ id: 's1', agent: 'claude', cwd: '/work/repo', projectId: pId }]);

  const now = Date.now();
  upsertEvents(db, [
    // Retry loop
    { id: 'e1', agent: 'claude', sessionId: 's1', ts: now + 100, kind: 'tool_call', tool: 'Bash', argsHash: 'cmd1' },
    { id: 'e2', agent: 'claude', sessionId: 's1', ts: now + 200, kind: 'tool_call', tool: 'Bash', argsHash: 'cmd1' },
    { id: 'e3', agent: 'claude', sessionId: 's1', ts: now + 300, kind: 'tool_call', tool: 'Bash', argsHash: 'cmd1' },
    // Large tool output
    { id: 'e4:result', agent: 'claude', sessionId: 's1', ts: now + 400, kind: 'tool_result', resultBytes: 80_000 },
  ]);

  const findings = runDetectors(db);
  assert.ok(findings.length >= 2);

  const persisted = getFindings(db);
  assert.equal(persisted.length, findings.length);
});

test('runDetectors calibrates to trailing-week tokens and lowers estimates after window rollover', () => {
  const db = openDb(':memory:');
  const pId = upsertProject(db, '/work/repo', 'repo');
  upsertSessions(db, [{ id: 's1', agent: 'claude', cwd: '/work/repo', projectId: pId }]);
  const now = 1_793_000_000_000;
  upsertEvents(db, [
    { id: 'e1', agent: 'claude', sessionId: 's1', ts: now - 2000, kind: 'tool_result', resultBytes: 4096, input: 5000 },
    { id: 'e2', agent: 'claude', sessionId: 's1', ts: now - 1000, kind: 'tool_result', resultBytes: 120_000, input: 5000 },
  ]);

  const run1 = runDetectors(db, { now });
  const big1 = run1.find((f) => f.rule === 'large_tool_output');
  assert.ok(big1, 'large_tool_output fires');
  assert.ok(big1.estTokensWeek <= 10_000, 'estimate capped by the session trailing-week tokens (2 x 5000)');

  const stored1 = getFindings(db);
  assert.equal(stored1.find((f) => f.id === big1.id)?.estTokensWeek, big1.estTokensWeek, 'persisted equals returned');

  const run2 = runDetectors(db, { now }); // same fixed now: deterministic ids and estimates
  assert.deepEqual(
    run2.map((f) => [f.id, f.estTokensWeek]),
    run1.map((f) => [f.id, f.estTokensWeek]),
  );

  runDetectors(db, { now: now + 8 * 7 * 86_400_000 }); // trailing week rolled past all events
  const stored3 = getFindings(db);
  assert.equal(stored3.length, stored1.length, 'rollover does not delete findings');
  assert.equal(stored3.find((f) => f.id === big1.id)?.estTokensWeek, 0, 'previously higher persisted estimate decreases');
});
