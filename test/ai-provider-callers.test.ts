import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDb, setSetting, upsertEvents, upsertProject, upsertSessions } from '../src/db.ts';
import { diagnoseSession } from '../src/ai/diagnose.ts';
import { explainAnomaly } from '../src/ai/explain.ts';
import { enrichRecommendations } from '../src/ai/recommendations.ts';
import { rewriteInstructions } from '../src/ai/instruction-rewrite.ts';
import { tailorFixPrompt } from '../src/ai/fix-prompt.ts';
import { PROVIDER_ISOLATION } from '../src/ai/runner.ts';
import { tmp, put } from './helpers.ts';

test('all AI callers reject providers marked unsupported before consent or reservation', async t => {
  const db = openDb(':memory:');
  const project = upsertProject(db, '/private/project', 'project');
  upsertSessions(db, [{ id: 's', agent: 'claude', projectId: project, cwd: '/private/project' }]);
  for (let d = 0; d <= 7; d++) upsertEvents(db, [{ id: `e${d}`, sessionId: 's', agent: 'claude', ts: new Date(2026, 9, 20 - d, 18).getTime(), kind: 'assistant', input: d ? 400_000 : 1_500_000 }]);
  setSetting(db, 'ai_enabled', 'true');
  const file = put(join(tmp(), 'AGENTS.md'), '# Rules\n- Keep this rule.\n');
  let calls = 0;
  const runner = async () => { calls++; return { ok: true, text: '{}' }; };
  const now = new Date(2026, 9, 22, 12).getTime();
  const original = PROVIDER_ISOLATION.claude.supported;
  try {
    PROVIDER_ISOLATION.claude.supported = false;
    for (const agent of ['claude', 'codex', 'gemini', 'opencode']) {
      setSetting(db, 'ai_agent', agent);
      for (const [name, run] of [
        ['diagnosis', () => diagnoseSession(db, 's', { runner })],
        ['explanation', () => explainAnomaly(db, '2026-10-20', 'project', { now, runner })],
        ['recommendations', () => enrichRecommendations(db, [], { runner })],
        ['rewrite', () => rewriteInstructions(db, file, { runner })],
        ['fix prompt', () => tailorFixPrompt(db, {}, { runner })],
      ] as const) {
        await t.test(`${agent}: ${name}`, async () => {
          const result = await run();
          if ('aiError' in result) assert.equal(result.aiError, 'AI_PROVIDER_UNSUPPORTED');
          else if ('message' in result && !('code' in result)) assert.equal(result.message, 'AI_PROVIDER_UNSUPPORTED');
          else assert.equal(result.status === 'error' && result.code, 'AI_PROVIDER_UNSUPPORTED');
        });
      }
    }
    assert.equal(calls, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM ai_calls').get() as { n: number }).n, 0);
  } finally {
    PROVIDER_ISOLATION.claude.supported = original;
    db.close();
  }
});
