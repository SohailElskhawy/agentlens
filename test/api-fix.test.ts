import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, setSetting, upsertProject, upsertRecommendations } from '../src/db.ts';
import { startServer } from '../src/server.ts';
import { generateFixPrompt } from '../src/fix-prompts.ts';
import type { Recommendation } from '../src/types.ts';

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
