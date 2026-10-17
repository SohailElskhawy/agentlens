import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getOmarchyPluginSourceDir,
  getOmarchyPluginStatus,
  installOmarchyPlugin,
  uninstallOmarchyPlugin,
} from '../src/omarchy-plugin.ts';
import { tmp } from './helpers.ts';

test('installOmarchyPlugin copies plugin files and validates manifest in custom targetDir', () => {
  const dir = tmp();
  const targetDir = join(dir, 'plugins');
  const shellConfigPath = join(dir, 'shell.json');

  const sourceDir = getOmarchyPluginSourceDir();
  assert.ok(existsSync(join(sourceDir, 'manifest.json')));

  const result = installOmarchyPlugin({
    targetDir,
    shellConfigPath,
    runShellCommands: false,
  });

  assert.equal(result.pluginId, 'agentlens.bar-widget');
  assert.equal(result.installed, true);
  assert.equal(result.manifestValid, true);
  assert.equal(result.enabledInShellConfig, false);
  assert.ok(existsSync(join(result.installedDir, 'manifest.json')));
  assert.ok(existsSync(join(result.installedDir, 'BarWidget.qml')));
  assert.ok(existsSync(join(result.installedDir, 'Panel.qml')));
  assert.ok(existsSync(join(result.installedDir, 'Model.js')));
  assert.ok(existsSync(join(result.installedDir, 'assets', 'icon.svg')));
  assert.ok(existsSync(join(result.installedDir, 'README.md')));
});

test('getOmarchyPluginStatus detects enabledInShellConfig when shell.json contains agentlens.bar-widget', () => {
  const dir = tmp();
  const targetDir = join(dir, 'plugins');
  const shellConfigPath = join(dir, 'shell.json');

  installOmarchyPlugin({ targetDir, shellConfigPath, runShellCommands: false });
  writeFileSync(
    shellConfigPath,
    JSON.stringify({
      version: 1,
      bar: {
        id: 'omarchy.bar',
        layout: {
          left: [],
          center: [],
          right: [{ id: 'agentlens.bar-widget' }],
        },
      },
    }),
  );

  const status = getOmarchyPluginStatus({ targetDir, shellConfigPath });
  assert.equal(status.installed, true);
  assert.equal(status.manifestValid, true);
  assert.equal(status.enabledInShellConfig, true);
});

test('uninstallOmarchyPlugin removes installed plugin directory', () => {
  const dir = tmp();
  const targetDir = join(dir, 'plugins');
  const shellConfigPath = join(dir, 'shell.json');

  installOmarchyPlugin({ targetDir, shellConfigPath, runShellCommands: false });
  const unres = uninstallOmarchyPlugin({ targetDir, shellConfigPath, runShellCommands: false });
  assert.equal(unres.removed, true);
  assert.ok(!existsSync(unres.installedDir));

  const status = getOmarchyPluginStatus({ targetDir, shellConfigPath });
  assert.equal(status.installed, false);
});

test('installed plugin passes omarchy plugin validate when omarchy CLI is available', () => {
  const dir = tmp();
  const targetDir = join(dir, 'plugins');
  const res = installOmarchyPlugin({ targetDir, runShellCommands: false });

  if (existsSync('/usr/share/omarchy/bin/omarchy')) {
    const out = execFileSync('/usr/share/omarchy/bin/omarchy', ['plugin', 'validate', res.installedDir], {
      encoding: 'utf8',
    });
    assert.equal(typeof out, 'string');
  }
});

