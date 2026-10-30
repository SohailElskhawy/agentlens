import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, setSetting, upsertProject, upsertRecommendations } from '../src/db.ts';
import { startServer } from '../src/server.ts';
import { generateFixPrompt } from '../src/fix-prompts.ts';
import type { Recommendation } from '../src/types.ts';
import type { DiagnosisRunner } from '../src/ai/diagnose.ts';

let runnerCalls = 0;
let runnerResponse: { ok: boolean; text: string } = {
  ok: true,
  text: JSON.stringify({ prompt: 'Tailored AI fix prompt: add npm test:unit script to avoid Bash retry loops.' }),
};
const fakeRunner: DiagnosisRunner = async () => {
  runnerCalls++;
  return runnerResponse;
};

const db = openDb(':memory:');
const server = await startServer(db, 0, '127.0.0.1', { aiRunner: fakeRunner });
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
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(resData) });
          } catch {
            resolve({ status: res.statusCode!, body: resData });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('generateFixPrompt covers core detector rules cleanly without raw prompts', () => {
  const rules = [
    'hot_files',
    'retry_loop',
    'large_tool_output',
    'context_growth',
    'repeated_prompt',
    'model_fit',
    'cache_miss',
    'handoff',
    'subagent_share',
    'quota_pressure',
    'instruction_overhead',
    'unused_mcp',
    'duplicate_config',
    'config_conflict',
  ];

  for (const rule of rules) {
    const prompt = generateFixPrompt({
      rule,
      agent: 'claude',
      projectName: 'my-proj',
      evidence: { file: 'src/index.ts', tool: 'Bash', resultBytes: 250000 },
    });
    assert.ok(prompt.length > 20, `Rule ${rule} should produce a detailed prompt`);
    assert.doesNotMatch(prompt, /undefined/, `Prompt for ${rule} should not have undefined text`);
  }
});

test('GET and POST /api/settings manages allow_agent_launch state', async () => {
  const res1 = await get('/api/settings');
  assert.equal(res1.status, 200);

  const postRes = await post('/api/settings', { allowAgentLaunch: true });
  assert.equal(postRes.status, 200);
  assert.equal(postRes.body.settings.allow_agent_launch, 'true');

  const res2 = await get('/api/settings');
  assert.equal(res2.status, 200);
  assert.equal(res2.body.settings.allow_agent_launch, 'true');

  // Reset to false for safety
  await post('/api/settings', { allowAgentLaunch: false });
});

test('POST /api/fix/prompt returns generated prompt', async () => {
  const res = await post('/api/fix/prompt', {
    rule: 'hot_files',
    agent: 'claude',
    evidence: { file: 'package.json' },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.prompt.includes('package.json'));
});

test('POST /api/fix/run blocks execution when allow_agent_launch is false (403)', async () => {
  setSetting(db, 'allow_agent_launch', 'false');
  const projId = upsertProject(db, process.cwd(), 'token-analyzer');

  const res = await post('/api/fix/run', {
    agent: 'claude',
    prompt: 'Add summary of types.ts',
    projectId: projId,
  });

  assert.equal(res.status, 403);
  assert.match(res.body.error, /Permission denied/);
});

test('POST /api/fix/run rejects unknown project (400)', async () => {
  setSetting(db, 'allow_agent_launch', 'true');

  const res = await post('/api/fix/run', {
    agent: 'claude',
    prompt: 'Add summary of types.ts',
    projectId: 999999,
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unknown project/);
  setSetting(db, 'allow_agent_launch', 'false');
});

test('POST /api/fix/run rejects missing required fields (400)', async () => {
  const res = await post('/api/fix/run', {
    agent: 'claude',
  });
  assert.equal(res.status, 400);
});

test('POST /api/fix/run auto-accepts recommendation when run', async () => {
  process.env.AGENTLENS_FIX_BIN_OVERRIDE = 'echo';
  setSetting(db, 'allow_agent_launch', 'true');
  const projId = upsertProject(db, process.cwd(), 'token-analyzer');

  const rec: Recommendation = {
    id: 'rec:hot_files:test',
    findingRule: 'hot_files',
    projectId: projId,
    action: 'improve',
    title: 'Consolidate file re-reads',
    body: 'Add summary',
    status: 'open',
  };
  upsertRecommendations(db, [rec]);

  const res = await post('/api/fix/run', {
    agent: 'claude',
    prompt: 'Add summary',
    projectId: projId,
    recommendationId: rec.id,
    headless: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.mode, 'headless');

  const checkRow = db.prepare('SELECT status, accepted_at FROM recommendations WHERE id = ?').get(rec.id) as any;
  assert.ok(checkRow.status === 'accepted' || checkRow.status === 'measuring');
  assert.ok(checkRow.accepted_at > 0);

  delete process.env.AGENTLENS_FIX_BIN_OVERRIDE;
  setSetting(db, 'allow_agent_launch', 'false');
});

test('POST /api/fix/prompt?ai=1 falls back to generateFixPrompt when AI is disabled, unconfirmed, fails, returns invalid output, or hits daily cap', async () => {
  const input = {
    rule: 'retry_loop',
    agent: 'claude',
    evidence: { tool: 'Bash', count: 3 },
  };
  const expectedFallback = generateFixPrompt(input);

  // 1. AI disabled
  setSetting(db, 'ai_enabled', 'false');
  setSetting(db, 'ai_agent', 'claude');
  setSetting(db, 'ai_max_calls_per_day', '20');
  runnerCalls = 0;

  const disabledRes = await post('/api/fix/prompt?ai=1', input);
  assert.equal(disabledRes.status, 200);
  assert.equal(disabledRes.body.ok, true);
  assert.equal(disabledRes.body.source, 'fallback');
  assert.equal(disabledRes.body.aiError, 'AI_DISABLED');
  assert.equal(disabledRes.body.prompt, expectedFallback);
  assert.equal(runnerCalls, 0);

  // 2. Unconfirmed when AI enabled
  setSetting(db, 'ai_enabled', 'true');
  const unconfirmedRes = await post('/api/fix/prompt?ai=1', input);
  assert.equal(unconfirmedRes.status, 200);
  assert.equal(unconfirmedRes.body.ok, true);
  assert.equal(unconfirmedRes.body.source, 'fallback');
  assert.equal(unconfirmedRes.body.aiStatus, 'confirmation_required');
  assert.equal(unconfirmedRes.body.prompt, expectedFallback);
  assert.match(unconfirmedRes.body.preview?.confirmationHash ?? '', /^[a-f0-9]{64}$/);
  assert.equal(runnerCalls, 0);

  const confirmHash = unconfirmedRes.body.preview.confirmationHash;

  // 3. Runner fails
  runnerResponse = { ok: false, text: 'CLI error' };
  const failedRes = await post('/api/fix/prompt?ai=1', { ...input, confirm: confirmHash });
  assert.equal(failedRes.status, 200);
  assert.equal(failedRes.body.ok, true);
  assert.equal(failedRes.body.source, 'fallback');
  assert.equal(failedRes.body.aiError, 'AI_RUN_FAILED');
  assert.equal(failedRes.body.prompt, expectedFallback);
  assert.equal(runnerCalls, 1);

  // 4. Invalid output
  runnerResponse = { ok: true, text: 'not valid json output' };
  const invalidRes = await post('/api/fix/prompt?ai=1', { ...input, confirm: confirmHash });
  assert.equal(invalidRes.status, 200);
  assert.equal(invalidRes.body.ok, true);
  assert.equal(invalidRes.body.source, 'fallback');
  assert.equal(invalidRes.body.aiError, 'AI_INVALID_OUTPUT');
  assert.equal(invalidRes.body.prompt, expectedFallback);
  assert.equal(runnerCalls, 2);

  // 5. Daily cap reached
  setSetting(db, 'ai_max_calls_per_day', '0');
  const capRes = await post('/api/fix/prompt?ai=1', { ...input, confirm: confirmHash });
  assert.equal(capRes.status, 200);
  assert.equal(capRes.body.ok, true);
  assert.equal(capRes.body.source, 'fallback');
  assert.equal(capRes.body.aiError, 'AI_DAILY_LIMIT');
  assert.equal(capRes.body.prompt, expectedFallback);
  assert.equal(runnerCalls, 2);

  setSetting(db, 'ai_max_calls_per_day', '20');
  setSetting(db, 'ai_enabled', 'false');
});

test('POST /api/fix/prompt?ai=1 preview excludes raw prompt text and unwhitelisted fields', async () => {
  setSetting(db, 'ai_enabled', 'false');
  setSetting(db, 'ai_agent', 'claude');
  runnerCalls = 0;

  const res = await post('/api/fix/prompt?ai=1', {
    rule: 'retry_loop',
    evidence: {
      tool: 'Bash',
      count: 4,
      rawPrompt: 'SECRET_USER_PROMPT_TEXT',
      transcript: 'PRIVATE_CODE_BLOCK',
    },
    prompt: 'DO_NOT_LEAK',
    preview: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.source, 'fallback');
  assert.equal(res.body.aiStatus, 'confirmation_required');
  assert.equal(typeof res.body.preview?.prompt, 'string');
  assert.ok(res.body.preview.prompt.includes('Bash'));
  assert.ok(res.body.preview.prompt.includes('4'));
  assert.ok(!res.body.preview.prompt.includes('SECRET_USER_PROMPT_TEXT'));
  assert.ok(!res.body.preview.prompt.includes('PRIVATE_CODE_BLOCK'));
  assert.ok(!res.body.preview.prompt.includes('DO_NOT_LEAK'));
  assert.equal(runnerCalls, 0);
});

test('POST /api/fix/prompt?ai=1 executes confirmed AI run and reuses cache on subsequent calls', async () => {
  setSetting(db, 'ai_enabled', 'true');
  setSetting(db, 'ai_agent', 'claude');
  setSetting(db, 'ai_max_calls_per_day', '20');
  runnerCalls = 0;
  const tailored = 'Tailored AI fix prompt: add npm test:unit script to avoid Bash retry loops.';
  runnerResponse = { ok: true, text: JSON.stringify({ prompt: tailored }) };

  const input = {
    rule: 'retry_loop',
    agent: 'claude',
    evidence: { tool: 'Bash', count: 5 },
  };

  // First call without confirm returns confirmation_required
  const step1 = await post('/api/fix/prompt?ai=1', input);
  assert.equal(step1.status, 200);
  assert.equal(step1.body.ok, true);
  assert.equal(step1.body.source, 'fallback');
  assert.equal(step1.body.aiStatus, 'confirmation_required');
  assert.equal(step1.body.prompt, generateFixPrompt(input));
  assert.equal(runnerCalls, 0);

  const confirmHash = step1.body.preview.confirmationHash;
  assert.match(confirmHash, /^[a-f0-9]{64}$/);

  // Second call with confirm invokes runner once and returns tailored prompt
  const step2 = await post('/api/fix/prompt?ai=1', { ...input, confirm: confirmHash });
  assert.equal(step2.status, 200);
  assert.equal(step2.body.ok, true);
  assert.equal(step2.body.source, 'ai');
  assert.equal(step2.body.cached, false);
  assert.equal(step2.body.prompt, tailored);
  assert.equal(runnerCalls, 1);

  // Third call without confirm returns cached tailored prompt without invoking runner again
  const step3 = await post('/api/fix/prompt?ai=1', input);
  assert.equal(step3.status, 200);
  assert.equal(step3.body.ok, true);
  assert.equal(step3.body.source, 'ai');
  assert.equal(step3.body.cached, true);
  assert.equal(step3.body.prompt, tailored);
  assert.equal(runnerCalls, 1);

  setSetting(db, 'ai_enabled', 'false');
});
