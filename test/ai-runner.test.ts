import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { DEFAULT_TIMEOUT_MS, TEMP_DIR_NAME, detectAgents, runAnalyst } from '../src/ai/runner.ts';
import type { AnalystExec } from '../src/ai/runner.ts';

const prompt = '{"toolCalls":42,"label":"$(touch nope); --help"}';

test('exports the default timeout and temporary directory prefix', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 120_000);
  assert.equal(TEMP_DIR_NAME, 'agentlens-ai');
});

test('claude extracts analysis and uses the default execution limits', async () => {
  let calls = 0;
  const exec: AnalystExec = async (bin, args, options) => {
    calls++;
    assert.equal(bin, 'claude');
    assert.deepEqual(args.slice(-2), ['--', prompt]);
    assert.equal(options.timeout, DEFAULT_TIMEOUT_MS);
    assert.equal(options.maxBuffer, 10 * 1024 * 1024);
    assert.equal(options.shell, false);
    assert.ok(existsSync(options.cwd!));
    return { stdout: '{"result":"analysis"}', stderr: 'startup diagnostics' };
  };
  const result = await runAnalyst(prompt, { agent: 'claude', exec });
  assert.equal(calls, 1);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.text, 'analysis');
  assert.equal(result.agent, 'claude');
  assert.equal(result.error, undefined);
  assert.ok(result.durationMs >= 0);
});

test('concurrent invocations use distinct private directories and remove them', async () => {
  const paths: string[] = [];
  const exec: AnalystExec = async (_bin, _args, options) => {
    const cwd = String(options.cwd);
    paths.push(cwd);
    if (process.platform !== 'win32') assert.equal(statSync(cwd).mode & 0o777, 0o700);
    return { stdout: '{"result":"analysis"}', stderr: '' };
  };
  const results = await Promise.all([
    runAnalyst(prompt, { agent: 'claude', exec }),
    runAnalyst(prompt, { agent: 'claude', exec }),
  ]);
  assert.equal(paths.length, 2);
  assert.notEqual(paths[0], paths[1]);
  for (const result of results) assert.equal(result.ok, true, result.error);
  for (const path of paths) assert.equal(existsSync(path), false);
});

test('claude rejects malformed JSON and missing or erroneous answers', async () => {
  for (const stdout of ['not json', 'null', '{}', '{"result":42}',
    '{"is_error":true,"result":"failed"}', '{"error":{"message":"failed"}}']) {
    const result = await runAnalyst(prompt, { agent: 'claude', exec: async () => ({ stdout, stderr: '' }) });
    assert.equal(result.ok, false, stdout);
    assert.equal(result.text, '');
    assert.ok(result.error);
  }
});

test('failed executions clean up their private directory', async () => {
  let cwd = '';
  const result = await runAnalyst(prompt, { agent: 'claude', exec: async (_bin, _args, options) => {
    cwd = String(options.cwd);
    throw new Error('command failed');
  }});
  assert.equal(result.ok, false);
  assert.equal(result.text, '');
  assert.ok(result.error);
  assert.equal(existsSync(cwd), false);
});

test('empty output is an error', async () => {
  const result = await runAnalyst(prompt, { agent: 'claude', exec: async () => ({ stdout: '{"result":"  "}', stderr: '' }) });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('a binary override cannot bypass the provider safety flags', async () => {
  const original = process.env.AGENTLENS_AI_BIN_OVERRIDE;
  process.env.AGENTLENS_AI_BIN_OVERRIDE = '/fake/analyst';
  try {
    let called = false;
    const result = await runAnalyst(prompt, { agent: 'claude', timeout: 25, exec: async (bin, args, options) => {
      called = true;
      assert.equal(bin, 'claude');
      assert.equal(options.timeout, 25);
      assert.ok(args.includes('--safe-mode'));
      return { stdout: '{"result":"analysis"}', stderr: '' };
    }});
    assert.equal(called, true);
    assert.equal(result.ok, true, result.error);
  } finally {
    if (original === undefined) delete process.env.AGENTLENS_AI_BIN_OVERRIDE;
    else process.env.AGENTLENS_AI_BIN_OVERRIDE = original;
  }
});

test('detectAgents lists only safe CLIs found on the Unix PATH', async () => {
  const checked: string[] = [];
  const agents = await detectAgents(async (bin, args) => {
    assert.equal(bin, 'which');
    checked.push(args[0]);
    return { stdout: `/fake/${args[0]}\n`, stderr: '' };
  }, 'linux');
  assert.deepEqual(checked, ['claude']);
  assert.deepEqual(agents, ['claude']);
  assert.deepEqual(await detectAgents(async () => { throw new Error('not found'); }), []);
});

test('failures never expose command, output, paths, or secrets', async () => {
  for (const [properties, expected] of [
    [{ killed: true, signal: 'SIGTERM' }, 'Analyst timed out'],
    [{ code: 17 }, 'Analyst exited with code 17'],
    [{ code: 'ENOENT' }, 'Analyst executable not found'],
    [{ code: 'EACCES' }, 'Analyst executable permission denied'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'Analyst output exceeded the limit'],
    [{ code: 'private-error-code' }, 'Analyst execution failed'],
  ] as const) {
    const secret = 'private-prompt-output-path-secret';
    const error = Object.assign(new Error(secret), properties, { stdout: secret, stderr: secret, path: secret });
    const result = await runAnalyst(secret, { agent: 'claude', exec: async () => { throw error; } });
    assert.equal(result.error, expected);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  const result = await runAnalyst(prompt, { agent: 'claude', exec: async () => ({ stdout: 'private-invalid-json', stderr: '' }) });
  assert.equal(JSON.stringify(result).includes('private-invalid-json'), false);
});

test('claude isolates its workspace and keeps leading-dash prompts and models as data', async () => {
  for (const model of ['model-name', '--model-secret']) {
    let cwd = '';
    const result = await runAnalyst('--private-prompt', { agent: 'claude', model, exec: async (_bin, args, options) => {
      cwd = String(options.cwd);
      assert.equal(dirname(cwd), tmpdir());
      assert.ok(existsSync(cwd));
      assert.deepEqual(args.slice(-2), ['--', '--private-prompt']);
      assert.ok(args.includes(`--model=${model}`));
      for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(args.includes(flag), flag);
      assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
      return { stdout: '{"result":"analysis"}', stderr: '' };
    }});
    assert.equal(result.ok, true, result.error);
    assert.equal(existsSync(cwd), false);
  }
});

test('providers without isolated read-only controls fail closed', async () => {
  for (const agent of ['codex', 'gemini', 'opencode'] as const) {
    let called = false;
    const result = await runAnalyst(prompt, { agent, exec: async () => { called = true; return { stdout: '', stderr: '' }; } });
    assert.equal(called, false);
    assert.equal(result.ok, false);
    assert.match(result.error!, /not supported/i);
  }
});

test('detectAgents uses the Windows PATH locator and only advertises safe providers', async () => {
  const calls: string[][] = [];
  const found = await detectAgents(async (bin, args) => {
    calls.push([bin, ...args]);
    return { stdout: '', stderr: '' };
  }, 'win32');
  assert.deepEqual(calls, [['where.exe', 'claude']]);
  assert.deepEqual(found, ['claude']);
});
