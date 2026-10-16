import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanInstructions } from '../src/audit/scanners/instruction.ts';
import { scanMcp } from '../src/audit/scanners/mcp.ts';
import { scanSkills } from '../src/audit/scanners/skill.ts';
import { scanPlugins } from '../src/audit/scanners/plugin.ts';

test('audit scanners discover instructions, MCPs, skills, and plugins safely', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agentlens-scan-test-'));

  try {
    const home = join(tmp, 'home');
    const work = join(tmp, 'work/my-project');
    mkdirSync(join(home, '.claude/rules'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    mkdirSync(join(home, '.config/opencode'), { recursive: true });
    mkdirSync(join(home, '.gemini/antigravity-cli/mcp/test-mcp'), { recursive: true });
    mkdirSync(join(home, '.gemini/config/skills/gemini-skill'), { recursive: true });
    mkdirSync(join(home, '.claude/skills/claude-skill'), { recursive: true });
    mkdirSync(join(home, '.claude/plugins'), { recursive: true });
    writeFileSync(
      join(home, '.claude/plugins/installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'sample-plugin@official': [{ version: '1.0.0' }],
        },
      })
    );
    mkdirSync(join(work, 'docs'), { recursive: true });

    // Instruction files
    writeFileSync(join(home, '.claude/CLAUDE.md'), '# Global Claude Instructions\nBe concise.');
    writeFileSync(join(home, '.claude/rules/code.md'), '# Code Rule\nAlways write tests.');
    writeFileSync(join(home, '.codex/AGENTS.md'), '# Global Codex Agents\nFollow TDD.');
    writeFileSync(join(work, 'CLAUDE.md'), '# Project Claude Instructions\nUse npm.');
    writeFileSync(join(work, 'docs/architecture.md'), '# Architecture Overview\nMicroservices.');

    const projects = [{ id: 10, root: work, name: 'my-project' }];

    // Test scanInstructions
    const instructions = scanInstructions(home, projects);
    assert.ok(instructions.length >= 5);
    const claudeGlobal = instructions.find((i) => i.name === 'CLAUDE.md' && i.projectId === null);
    assert.ok(claudeGlobal);
    assert.equal(claudeGlobal?.agent, 'claude');
    assert.ok(claudeGlobal?.tokens && claudeGlobal.tokens > 0);

    const projectDoc = instructions.find((i) => i.name === 'architecture.md');
    assert.ok(projectDoc);
    assert.equal(projectDoc?.projectId, 10);

    // MCP configs
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          serena: { command: 'serena-start', args: ['--dev'] },
        },
      })
    );
    writeFileSync(
      join(home, '.codex/config.toml'),
      `
model = "gpt-4"
[  mcp_servers.jev  ] # trailing section comment
"command" = "/usr/local/bin/jev-mcp" # inline comment

[mcp_servers."quoted.name"]
command = "quoted-cmd"

[mcp_servers.node_repl.env]
VAR = "1"
      `
    );
    writeFileSync(
      join(home, '.config/opencode/opencode.json'),
      JSON.stringify({
        mcp: {
          sqlite_viewer: { url: 'http://localhost:8080' },
        },
      })
    );

    // Test scanMcp
    const mcps = scanMcp(home, projects);
    assert.ok(mcps.length >= 5);
    assert.ok(mcps.find((m) => m.name === 'serena' && m.agent === 'claude'));
    const jev = mcps.find((m) => m.name === 'jev' && m.agent === 'codex');
    assert.ok(jev);
    assert.equal(jev?.details?.command, '/usr/local/bin/jev-mcp');
    assert.ok(mcps.find((m) => m.name === 'quoted.name' && m.agent === 'codex'));
    assert.ok(mcps.find((m) => m.name === 'sqlite_viewer' && m.agent === 'opencode'));
    assert.ok(mcps.find((m) => m.name === 'test-mcp' && m.agent === 'antigravity'));

    // Skill files
    writeFileSync(join(home, '.claude/skills/claude-skill/SKILL.md'), '---\nname: claude-skill\n---\nRun reviews.');
    writeFileSync(join(home, '.gemini/config/skills/gemini-skill/SKILL.md'), '---\nname: gemini-skill\n---\nAnalyze code.');

    // Test scanSkills
    const skills = scanSkills(home, projects);
    assert.ok(skills.length >= 2);
    assert.ok(skills.find((s) => s.name === 'claude-skill' && s.agent === 'claude'));
    assert.ok(skills.find((s) => s.name === 'gemini-skill' && s.agent === 'antigravity'));

    // Test scanPlugins
    const plugins = scanPlugins(home, projects);
    assert.ok(plugins.length >= 1);
    assert.ok(plugins.find((p) => p.name === 'sample-plugin' && p.agent === 'claude'));

    // Robustness: Corrupted JSON does not crash scanMcp
    writeFileSync(join(home, '.claude.json'), '{ invalid json ...');
    const safeMcps = scanMcp(home, projects);
    assert.ok(Array.isArray(safeMcps));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
