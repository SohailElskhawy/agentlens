import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { opencode } from '../src/adapters/opencode.ts';
import { scanInstructions } from '../src/audit/scanners/instruction.ts';
import { scanMcpConfigs } from '../src/audit/scanners/mcp.ts';
import { scanPluginConfigs } from '../src/audit/scanners/plugin.ts';
import { scanSkills } from '../src/audit/scanners/skill.ts';

test('opencode adapter: discovers database in macOS Library/Application Support', () => {
  const tmpHome = join(process.cwd(), 'scratch/tmp-mac-opencode');
  const macDbDir = join(tmpHome, 'Library/Application Support/opencode');
  mkdirSync(macDbDir, { recursive: true });
  writeFileSync(join(macDbDir, 'opencode.db'), '');

  try {
    const root = opencode.root(tmpHome);
    const discovered = opencode.discover(root);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0], join(macDbDir, 'opencode.db'));
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('opencode adapter: handles coexisting data roots deterministically (Review Focus 4)', () => {
  const tmpHome = join(process.cwd(), 'scratch/tmp-coexist-opencode');
  const linuxDir = join(tmpHome, '.local/share/opencode');
  const macDir = join(tmpHome, 'Library/Application Support/opencode');
  mkdirSync(linuxDir, { recursive: true });
  mkdirSync(macDir, { recursive: true });
  writeFileSync(join(linuxDir, 'opencode.db'), '');
  writeFileSync(join(macDir, 'opencode.db'), '');

  try {
    const root = opencode.root(tmpHome);
    const discovered = opencode.discover(root);
    assert.equal(discovered.length, 1);
    assert.ok(discovered[0].includes('opencode.db'));
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('audit scanners: detects OpenCode instructions, MCPs, and skills in macOS/Windows config roots', () => {
  const tmpHome = join(process.cwd(), 'scratch/tmp-opencode-audit');
  const macConfigDir = join(tmpHome, 'Library/Application Support/opencode');
  mkdirSync(join(macConfigDir, 'skills/deploy'), { recursive: true });
  writeFileSync(join(macConfigDir, 'AGENTS.md'), '# macOS Agent Instructions');
  writeFileSync(join(macConfigDir, 'opencode.json'), JSON.stringify({
    mcpServers: {
      tester: { command: 'node', args: ['test.js'] }
    },
    plugins: ['lint-plugin']
  }));
  writeFileSync(join(macConfigDir, 'skills/deploy/SKILL.md'), '---\nname: deploy\n---\nDeploy instructions');

  try {
    const instructions = scanInstructions([], tmpHome);
    const macInstr = instructions.find((i) => i.agent === 'opencode');
    assert.ok(macInstr);
    assert.ok(macInstr.path.includes('Library/Application Support/opencode/AGENTS.md'));

    const mcps = scanMcpConfigs([], tmpHome);
    const macMcp = mcps.find((m) => m.name === 'tester');
    assert.ok(macMcp);

    const plugins = scanPluginConfigs([], tmpHome);
    const macPlug = plugins.find((p) => p.name === 'lint-plugin');
    assert.ok(macPlug);

    const skills = scanSkills([], tmpHome);
    const macSkill = skills.find((s) => s.name === 'deploy');
    assert.ok(macSkill);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
