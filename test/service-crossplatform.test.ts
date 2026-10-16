import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { generateServiceConfig, installService } from '../src/service.ts';

test('generateServiceConfig: Linux produces valid systemd user service', () => {
  const res = generateServiceConfig('linux', {
    nodePath: '/usr/bin/node',
    cliPath: '/app/src/cli.ts',
    stateDir: '/home/user/.local/state/agentlens',
    home: '/home/user',
  });
  assert.equal(res.platform, 'linux');
  assert.equal(res.targetPath, '/home/user/.config/systemd/user/agentlens.service');
  assert.ok(res.content.includes('[Unit]'));
  assert.ok(res.content.includes('ExecStart="/usr/bin/node" --no-warnings=ExperimentalWarning "/app/src/cli.ts" serve'));
  assert.ok(res.enableCommand.includes('systemctl --user daemon-reload'));
});

test('generateServiceConfig: macOS produces valid launchd plist', () => {
  const res = generateServiceConfig('darwin', {
    nodePath: '/opt/homebrew/bin/node',
    cliPath: '/Users/macuser/agentlens/src/cli.ts',
    stateDir: '/Users/macuser/Library/Caches/agentlens',
    home: '/Users/macuser',
  });
  assert.equal(res.platform, 'darwin');
  assert.equal(res.targetPath, '/Users/macuser/Library/LaunchAgents/com.agentlens.plist');
  assert.ok(res.content.includes('<key>Label</key>'));
  assert.ok(res.content.includes('<string>com.agentlens</string>'));
  assert.ok(res.content.includes('/opt/homebrew/bin/node'));
  assert.ok(res.content.includes('/Users/macuser/Library/Caches/agentlens/agentlens.log'));
  assert.ok(res.enableCommand.includes('launchctl load -w'));
});

test('generateServiceConfig: Windows quotes paths with spaces (Review Focus 2)', () => {
  const res = generateServiceConfig('win32', {
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    cliPath: 'C:\\Users\\John Doe\\agentlens\\src\\cli.ts',
    stateDir: 'C:\\Users\\John Doe\\AppData\\Local\\agentlens\\state',
    home: 'C:\\Users\\John Doe',
    env: { LOCALAPPDATA: 'C:\\Users\\John Doe\\AppData\\Local' },
  });
  assert.equal(res.platform, 'win32');
  assert.ok(res.enableCommand.includes('schtasks /create /tn "agentlens"'));
  assert.ok(res.enableCommand.includes('"C:\\Program Files\\nodejs\\node.exe"'));
  assert.ok(res.auxiliaryPath);
  assert.ok(res.auxiliaryContent?.includes('"C:\\Program Files\\nodejs\\node.exe"'));
});

test('generateServiceConfig: Windows falls back when LOCALAPPDATA is unset (Review Focus 1)', () => {
  const res = generateServiceConfig('win32', {
    nodePath: 'C:\\nodejs\\node.exe',
    cliPath: 'C:\\agentlens\\src\\cli.ts',
    stateDir: 'C:\\Users\\fakeuser\\AppData\\Local\\agentlens\\state',
    home: 'C:\\Users\\fakeuser',
    env: {},
  });
  assert.equal(res.platform, 'win32');
  assert.ok(res.targetPath.includes('AppData'));
  assert.ok(res.auxiliaryPath?.includes('AppData'));
});

test('installService: writes files to disk cleanly on simulated platforms', () => {
  const tmpHome = join(process.cwd(), 'scratch/tmp-service-test');
  mkdirSync(tmpHome, { recursive: true });

  try {
    const res = installService({
      platform: 'darwin',
      home: tmpHome,
      execPath: '/usr/bin/node',
      cliPath: '/test/cli.ts',
      stateDir: join(tmpHome, 'Library/Caches/agentlens'),
    });
    assert.equal(res.success, true);
    assert.ok(existsSync(join(tmpHome, 'Library/LaunchAgents/com.agentlens.plist')));
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('installService: writes systemd service cleanly on simulated Linux', () => {
  const tmpHome = join(process.cwd(), 'scratch/tmp-service-linux-test');
  mkdirSync(tmpHome, { recursive: true });

  try {
    const res = installService({
      platform: 'linux',
      home: tmpHome,
      execPath: '/usr/bin/node',
      cliPath: '/test/cli.ts',
      stateDir: join(tmpHome, '.local/state/agentlens'),
    });
    assert.equal(res.success, true);
    const servicePath = join(tmpHome, '.config/systemd/user/agentlens.service');
    assert.ok(existsSync(servicePath));
    const content = readFileSync(servicePath, 'utf8');
    assert.ok(content.includes('[Unit]'));
    assert.ok(res.message.includes('systemctl --user daemon-reload'));
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('installService: writes batch script cleanly on simulated Windows', () => {
  const tmpHome = join(process.cwd(), 'scratch/tmp-service-win-test');
  mkdirSync(tmpHome, { recursive: true });

  try {
    const res = installService({
      platform: 'win32',
      home: tmpHome,
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      cliPath: 'C:\\Users\\Test\\agentlens\\src\\cli.ts',
      stateDir: join(tmpHome, 'AppData/Local/agentlens/state'),
      env: { LOCALAPPDATA: join(tmpHome, 'AppData/Local') },
    });
    assert.equal(res.success, true);
    const cmdPath = join(tmpHome, 'AppData/Local/agentlens/agentlens-service.cmd');
    assert.ok(existsSync(cmdPath));
    const content = readFileSync(cmdPath, 'utf8');
    assert.ok(content.includes('@echo off'));
    assert.ok(content.includes('"C:\\Program Files\\nodejs\\node.exe"'));
    assert.ok(res.message.includes('schtasks /create'));
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('installService: handles file write failures gracefully (Review Focus 5)', () => {
  const unwriteableDir = join(process.cwd(), 'scratch/tmp-unwriteable-dir');
  mkdirSync(unwriteableDir, { recursive: true });
  chmodSync(unwriteableDir, 0o444);

  try {
    const res = installService({
      platform: 'linux',
      home: unwriteableDir,
      execPath: '/usr/bin/node',
      cliPath: '/test/cli.ts',
      stateDir: '/tmp',
    });
    // On Linux running as non-root, writing inside a 0444 directory fails with EACCES
    // If running as root in docker, chmod may not prevent writes, so verify safe handling
    if (!res.success) {
      assert.ok(res.message.includes('Failed to install service configuration'));
      assert.ok(res.message.includes('Manual setup instructions:'));
    } else {
      assert.equal(typeof res.message, 'string');
    }
  } finally {
    try {
      chmodSync(unwriteableDir, 0o777);
      rmSync(unwriteableDir, { recursive: true, force: true });
    } catch {
      // cleanup best effort
    }
  }
});
