import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, upsertProject, upsertEvents, getAuditItems, getFindings, getRecommendations } from '../src/db.ts';
import { runAudit } from '../src/audit/runner.ts';
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

    // Check findings emitted
    const findings = getFindings(db);
    const bloatFinding = findings.find((f) => f.rule === 'instruction_bloat');
    assert.ok(bloatFinding, 'Should emit instruction_bloat finding');
    assert.ok(bloatFinding?.estTokensWeek > 0);

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
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
