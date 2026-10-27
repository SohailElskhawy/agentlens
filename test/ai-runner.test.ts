import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_TIMEOUT_MS, TEMP_DIR_NAME, detectAgents, runAnalyst } from '../src/ai/runner.ts';
import type { AnalystAgent, AnalystExec } from '../src/ai/runner.ts';

const prompt = '{"toolCalls":42,"label":"$(touch nope); --help"}';
const originalOverride = process.env.AGENTLENS_AI_BIN_OVERRIDE;
beforeEach(() => { delete process.env.AGENTLENS_AI_BIN_OVERRIDE; });
afterEach(() => {
  if (originalOverride === undefined) delete process.env.AGENTLENS_AI_BIN_OVERRIDE;
  else process.env.AGENTLENS_AI_BIN_OVERRIDE = originalOverride;
});

const commands: Array<{ agent: AnalystAgent; args: string[]; stdout: string }> = [
  { agent: 'claude', args: ['-p', prompt, '--output-format', 'json', '--no-session-persistence', '--tools', ''], stdout: '{"result":"analysis"}' },
  { agent: 'gemini', args: ['-p', prompt, '-o', 'json', '--approval-mode', 'plan'], stdout: '{"response":"analysis"}' },
  { agent: 'opencode', args: ['run', '--standalone', prompt], stdout: 'analysis' },
];

for (const { agent, args, stdout } of commands) {
  test(`${agent} uses the requested argv and extracts analysis`, async () => {
    let calls = 0;
    const exec: AnalystExec = async (bin, actualArgs, options) => {
      calls++;
      assert.equal(bin, agent);
      assert.deepEqual(actualArgs, args);
      assert.equal(options.cwd, join(tmpdir(), 'agentlens-ai'));
      assert.ok(existsSync(options.cwd!));
      assert.equal(options.timeout, 120_000);
      assert.equal(options.maxBuffer, 10 * 1024 * 1024);
      assert.equal(options.shell, false);
      if (agent === 'opencode') {
        assert.equal(JSON.parse(options.env!.OPENCODE_CONFIG_CONTENT!).permission, 'deny');
      }
      return { stdout, stderr: 'startup diagnostics' };
    };
    const result = await runAnalyst(prompt, { agent, exec });
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.text, 'analysis');
    assert.equal(result.agent, agent);
    assert.equal(result.error, undefined);
    assert.ok(result.durationMs >= 0);
  });
}

test('exports the default timeout and fixed temp directory name', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 120_000);
  assert.equal(TEMP_DIR_NAME, 'agentlens-ai');
});

test('claude adds a model only when supplied', async () => {
  const result = await runAnalyst(prompt, {
    agent: 'claude', model: 'test-model',
    exec: async (_bin, args) => {
      assert.deepEqual(args, [...commands[0].args, '--model', 'test-model']);
      return { stdout: '{"result":"analysis"}', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
});

test('codex reads its unique -o file instead of stdout and removes it', async () => {
  const paths: string[] = [];
  const exec: AnalystExec = async (bin, args, options) => {
    assert.equal(bin, 'codex');
    assert.deepEqual(args.slice(0, 6), ['exec', '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '-o']);
    assert.equal(args[7], prompt);
    assert.equal(args.length, 8);
    assert.equal(dirname(dirname(args[6])), options.cwd);
    paths.push(args[6]);
    writeFileSync(args[6], 'file analysis');
    return { stdout: 'progress, not the answer', stderr: '' };
  };
  const results = await Promise.all([
    runAnalyst(prompt, { agent: 'codex', exec }),
    runAnalyst(prompt, { agent: 'codex', exec }),
  ]);
  assert.notEqual(paths[0], paths[1]);
  for (const result of results) {
    assert.equal(result.ok, true);
    assert.equal(result.text, 'file analysis');
  }
  for (const path of paths) assert.equal(existsSync(dirname(path)), false);
});

test('binary override mirrors fix-runner and receives only the prompt', async () => {
  process.env.AGENTLENS_AI_BIN_OVERRIDE = '/fake/analyst';
  const result = await runAnalyst(prompt, {
    agent: 'claude', model: 'ignored-model',
    exec: async (bin, args) => {
      assert.equal(bin, '/fake/analyst');
      assert.deepEqual(args, [prompt]);
      return { stdout: '{"result":"overridden"}', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'overridden');
});

for (const [name, error] of [
  ['timeout', Object.assign(new Error('execution timed out'), { killed: true, signal: 'SIGTERM' })],
  ['non-zero exit', Object.assign(new Error('command failed'), { code: 1, stderr: 'failure diagnostics' })],
  ['missing binary', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })],
] as const) {
  test(`${name} returns an error without throwing`, async () => {
    const result = await runAnalyst(prompt, {
      agent: 'claude', timeout: 25,
      exec: async (_bin, _args, options) => {
        assert.equal(options.timeout, 25);
        throw error;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.text, '');
    assert.equal(result.agent, 'claude');
    assert.equal(result.error, error.message);
    assert.ok(result.durationMs >= 0);
  });
}

for (const agent of ['claude', 'gemini'] as const) {
  test(`${agent} rejects malformed JSON and missing or erroneous answers`, async () => {
    for (const stdout of ['not json', 'null', '{}', '{"result":42,"response":42}',
      '{"is_error":true,"result":"failed"}', '{"error":{"message":"failed"},"response":"failed"}']) {
      const result = await runAnalyst(prompt, {
        agent, exec: async () => ({ stdout, stderr: '' }),
      });
      assert.equal(result.ok, false, stdout);
      assert.equal(result.text, '');
      assert.ok(result.error);
    }
  });
}

test('codex fails if the output file is absent and cleans up on failure', async () => {
  for (const fail of [false, true]) {
    let output = '';
    const result = await runAnalyst(prompt, {
      agent: 'codex',
      exec: async (_bin, args) => {
        output = args[6];
        if (fail) {
          writeFileSync(output, 'partial analysis');
          throw new Error('command failed');
        }
        return { stdout: 'must not fall back to logs', stderr: '' };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.text, '');
    assert.ok(result.error);
    assert.equal(existsSync(dirname(output)), false);
  }
});

test('empty output is an error', async () => {
  const result = await runAnalyst(prompt, {
    agent: 'opencode', exec: async () => ({ stdout: '  \n', stderr: '' }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('detectAgents lists only CLIs found on PATH without running agents', async () => {
  const checked: string[] = [];
  const agents = await detectAgents(async (bin, args) => {
    assert.equal(bin, 'which');
    checked.push(args[0]);
    if (args[0] === 'codex' || args[0] === 'gemini') throw new Error('not found');
    return { stdout: `/fake/${args[0]}\n`, stderr: '' };
  });
  assert.deepEqual(checked, ['claude', 'codex', 'gemini', 'opencode']);
  assert.deepEqual(agents, ['claude', 'opencode']);
  assert.deepEqual(await detectAgents(async () => { throw new Error('not found'); }), []);
});
