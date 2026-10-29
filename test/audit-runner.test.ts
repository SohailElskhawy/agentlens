import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, upsertProject, upsertSessions, upsertEvents, upsertFindings, getAuditItems, getFindings, getRecommendations, updateRecommendationStatus } from '../src/db.ts';
import { runAudit } from '../src/audit/runner.ts';
import { CONFIDENCE_WEIGHTS } from '../src/analyze/constants.ts';
import type { NormalizedEvent } from '../src/types.ts';

test('runAudit calculates overhead, unused configs, duplicates, and conflicts', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-audit-runner-'));

  try {
    const home = join(tmp, 'home');
    const work = join(tmp, 'work/conflicted-project');
    mkdirSync(join(home, '.claude/skills/shared-skill'), { recursive: true });
    mkdirSync(join(home, '.codex/skills/shared-skill'), { recursive: true });
    mkdirSync(join(work, 'docs'), { recursive: true });

    const db = openDb(':memory:');
    const projId = upsertProject(db, work, 'conflicted-project');
    // Session with trailing-week activity gives the project a calibration budget of 150 (100 + 50)
    upsertSessions(db, [{ id: 's1', agent: 'claude', projectId: projId }]);

    // 1. Heavy instructions (> 4,000 tokens) to trigger instruction_bloat
    const heavyClaudeMd = '# Heavy Instructions\n' + 'A'.repeat(20_000); // 5,000 tokens
    writeFileSync(join(work, 'CLAUDE.md'), heavyClaudeMd);
    writeFileSync(join(work, 'AGENTS.md'), '# Agents config\nRun pnpm install to install dependencies.');
    writeFileSync(join(work, 'docs/setup.md'), '# Setup\nRun npm install --save to install packages.');

    // 2. Claude config with 1 used MCP and 1 unused MCP
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          active_server: { command: 'run' },
          stale_server: { command: 'run' },
        },
      })
    );

    // 3. Shared skill in both Claude and Codex to trigger duplicate_config
    writeFileSync(join(home, '.claude/skills/shared-skill/SKILL.md'), '---\nname: shared-skill\n---\nSkill.');
    writeFileSync(join(home, '.codex/skills/shared-skill/SKILL.md'), '---\nname: shared-skill\n---\nSkill.');

    // Add session and tool event for active_server
    const now = Date.now();
    const event: NormalizedEvent = {
      id: 'e1',
      agent: 'claude',
      sessionId: 's1',
      ts: now - 3600_000,
      kind: 'tool_call',
      tool: 'mcp__active_server__query',
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
    };
    upsertEvents(db, [event]);

    // Stale detector finding with an inflated estimate: must be capped by calibration, never deleted
    upsertFindings(db, [{
      id: 'retry_loop:stale',
      rule: 'retry_loop',
      projectId: null,
      sessionId: 's1',
      evidence: { tool: 'Bash', count: 4, argsHash: 'stale' },
      confidence: 'high',
      confidenceReason: 'stale seed',
      estTokensWeek: 999_999,
      firstSeen: now - 86_400_000,
      lastSeen: now - 86_400_000,
    }]);

    // Run audit
    const result = runAudit(db, home);
    assert.ok(result.items.length >= 4);

    // Check database persistence of audit items
    const dbItems = getAuditItems(db);
    assert.equal(dbItems.length, result.items.length);

    // Verify active vs unused MCP
    const activeMcp = dbItems.find((i) => i.name === 'active_server');
    assert.ok(activeMcp);
    assert.equal(activeMcp?.status, 'active');
    assert.equal(activeMcp?.invocations30d, 1);

    const staleMcp = dbItems.find((i) => i.name === 'stale_server');
    assert.ok(staleMcp);
    assert.equal(staleMcp?.status, 'unused');
    assert.equal(staleMcp?.invocations30d, 0);

    // Verify duplicate skill detection
    const dupSkills = dbItems.filter((i) => i.name === 'shared-skill');
    assert.equal(dupSkills.length, 2);
    assert.ok(dupSkills.some((s) => s.status === 'duplicate'));

    // Check findings emitted. instruction_bloat (project-scoped, raw estimate ~5000) is calibrated
    // down to the project's trailing-week tokens: session s1 = 100 input + 50 output = 150.
    const findings = getFindings(db);
    const bloatFinding = findings.find((f) => f.rule === 'instruction_bloat');
    assert.ok(bloatFinding, 'Should emit instruction_bloat finding');
    assert.equal(bloatFinding?.estTokensWeek, 150, 'calibrated to the project trailing-week budget');

    // Stale finding survives with a capped (not maximal) estimate
    const staleFinding = findings.find((f) => f.id === 'retry_loop:stale');
    assert.ok(staleFinding, 'stale finding remains after audit calibration');
    assert.equal(staleFinding?.estTokensWeek, 150, 'capped to its session trailing-week tokens');

    const unusedFinding = findings.find((f) => f.rule === 'unused_config' && f.evidence?.name === 'stale_server');
    assert.ok(unusedFinding, 'Should emit unused_config for stale_server');

    const dupFinding = findings.find((f) => f.rule === 'duplicate_config' && f.evidence?.name === 'shared-skill');
    assert.ok(dupFinding, 'Should emit duplicate_config for shared-skill');

    const conflictFinding = findings.find((f) => f.rule === 'config_conflict');
    assert.ok(conflictFinding, 'Should emit config_conflict for conflicting package managers');

    // Check recommendations synthesized
    const recs = getRecommendations(db);
    assert.ok(recs.length >= 3);
    const staleRec = recs.find((r) => r.findingRule === 'unused_config');
    assert.ok(staleRec);
    assert.equal(staleRec?.action, 'remove');
    assert.equal(staleRec?.actionSnippet, 'claude mcp remove stale_server');
    assert.equal(staleRec?.score, Math.round((unusedFinding?.estTokensWeek ?? 0) * CONFIDENCE_WEIGHTS[unusedFinding!.confidence]),
      'audit path recomputes recommendation scores from calibrated estimates');

    const retryRec = recs.find((r) => r.id.includes('retry_loop:stale'));
    assert.ok(retryRec);
    updateRecommendationStatus(db, retryRec.id, 'accepted');
    db.prepare('UPDATE recommendations SET result = ? WHERE id = ?').run(JSON.stringify({ note: 'saved' }), retryRec.id);
    db.prepare('UPDATE findings SET est_tokens_week = 999999 WHERE id = ?').run('retry_loop:stale');
    const second = runAudit(db, home);
    const refreshed = getRecommendations(db).find((r) => r.id === retryRec.id);
    assert.ok(refreshed);
    assert.equal(refreshed.status, 'accepted');
    assert.ok(refreshed.acceptedAt);
    assert.deepEqual(refreshed.result, { note: 'saved' });
    assert.equal(refreshed.score, Math.round(150 * CONFIDENCE_WEIGHTS.high));
    assert.equal(getFindings(db).find((f) => f.id === 'retry_loop:stale')?.confidence, 'high');
    for (const f of second.findings) assert.equal(getFindings(db).find((stored) => stored.id === f.id)?.estTokensWeek, f.estTokensWeek);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
