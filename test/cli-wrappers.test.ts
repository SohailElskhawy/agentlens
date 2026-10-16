import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('bin/agentlens.cmd exists and contains proper node invocation with flags', () => {
  const cmdPath = join(process.cwd(), 'bin/agentlens.cmd');
  assert.ok(existsSync(cmdPath), 'bin/agentlens.cmd must exist');
  const content = readFileSync(cmdPath, 'utf-8');
  assert.ok(content.includes('@echo off'));
  assert.ok(content.includes('node --no-warnings=ExperimentalWarning'));
  assert.ok(content.includes('cli.ts'));
  assert.ok(content.includes('%*'));
});

test('bin/agentlens.ps1 exists and contains PowerShell script execution syntax', () => {
  const ps1Path = join(process.cwd(), 'bin/agentlens.ps1');
  assert.ok(existsSync(ps1Path), 'bin/agentlens.ps1 must exist');
  const content = readFileSync(ps1Path, 'utf-8');
  assert.ok(content.includes('node --no-warnings=ExperimentalWarning'));
  assert.ok(content.includes('cli.ts'));
  assert.ok(content.includes('@args'));
});

test('getStatuslineSnippet: outputs agentlens.cmd on Windows and agentlens on POSIX', async () => {
  const { getStatuslineSnippet } = await import('../src/cli.ts');
  const winSnippet = getStatuslineSnippet('win32');
  assert.ok(winSnippet.includes('"command": "agentlens.cmd statusline"'));

  const linuxSnippet = getStatuslineSnippet('linux');
  assert.ok(linuxSnippet.includes('"command": "agentlens statusline"'));

  const macSnippet = getStatuslineSnippet('darwin');
  assert.ok(macSnippet.includes('"command": "agentlens statusline"'));
});

test('getStatuslineSnippet: defaults to process.platform when called without args', async () => {
  const { getStatuslineSnippet } = await import('../src/cli.ts');
  const defaultSnippet = getStatuslineSnippet();
  const expectedCmd = process.platform === 'win32' ? 'agentlens.cmd statusline' : 'agentlens statusline';
  assert.ok(defaultSnippet.includes(`"command": "${expectedCmd}"`));
});

test('help text describes install-service in platform-agnostic terms', () => {
  const out = execFileSync(process.execPath, ['--no-warnings', CLI, 'help'], { encoding: 'utf8' });
  assert.match(out, /install-service\s+install background service \(systemd, launchd, or scheduled task\) so serve starts at login/);
});
