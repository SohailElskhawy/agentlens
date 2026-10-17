import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OMARCHY_PLUGIN_ID = 'agentlens.bar-widget';

export interface OmarchyPluginOptions {
  targetDir?: string;
  shellConfigPath?: string;
  enable?: boolean;
  runShellCommands?: boolean;
}

export interface OmarchyPluginStatus {
  pluginId: string;
  sourceDir: string;
  installedDir: string;
  installed: boolean;
  manifestValid: boolean;
  enabledInShellConfig: boolean;
  omarchyCliAvailable: boolean;
}

export function getOmarchyPluginSourceDir(): string {
  return fileURLToPath(new URL('../plugins/omarchy/agentlens.bar-widget', import.meta.url));
}

function defaultPluginsDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(xdgConfig, 'omarchy', 'plugins');
}

function defaultShellConfigPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(xdgConfig, 'omarchy', 'shell.json');
}

function findOmarchyBin(name: 'omarchy' | 'omarchy-shell'): string | null {
  const sysPath = `/usr/share/omarchy/bin/${name}`;
  if (existsSync(sysPath)) return sysPath;
  try {
    const out = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function validateManifestFile(manifestPath: string): boolean {
  if (!existsSync(manifestPath)) return false;
  try {
    const data = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return (
      data &&
      data.schemaVersion === 1 &&
      data.id === OMARCHY_PLUGIN_ID &&
      Array.isArray(data.kinds) &&
      data.kinds.includes('bar-widget') &&
      typeof data.entryPoints?.barWidget === 'string'
    );
  } catch {
    return false;
  }
}

function isEnabledInShellJson(shellConfigPath: string): boolean {
  if (!existsSync(shellConfigPath)) return false;
  try {
    const raw = readFileSync(shellConfigPath, 'utf8');
    const cfg = JSON.parse(raw);
    const layout = cfg?.bar?.layout;
    if (layout && typeof layout === 'object') {
      for (const section of ['left', 'center', 'right']) {
        const list = layout[section];
        if (Array.isArray(list) && list.some((entry: any) => entry && entry.id === OMARCHY_PLUGIN_ID)) {
          return true;
        }
      }
    }
    if (Array.isArray(cfg?.plugins) && cfg.plugins.some((entry: any) => entry && entry.id === OMARCHY_PLUGIN_ID)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function getOmarchyPluginStatus(opts: OmarchyPluginOptions = {}): OmarchyPluginStatus {
  const sourceDir = getOmarchyPluginSourceDir();
  const targetDir = opts.targetDir ?? defaultPluginsDir();
  const shellConfigPath = opts.shellConfigPath ?? defaultShellConfigPath();
  const installedDir = join(targetDir, OMARCHY_PLUGIN_ID);
  const manifestPath = join(installedDir, 'manifest.json');
  const barWidgetPath = join(installedDir, 'BarWidget.qml');
  const panelPath = join(installedDir, 'Panel.qml');
  const modelPath = join(installedDir, 'Model.js');

  const installed =
    existsSync(manifestPath) &&
    existsSync(barWidgetPath) &&
    existsSync(panelPath) &&
    existsSync(modelPath);

  return {
    pluginId: OMARCHY_PLUGIN_ID,
    sourceDir,
    installedDir,
    installed,
    manifestValid: installed && validateManifestFile(manifestPath),
    enabledInShellConfig: isEnabledInShellJson(shellConfigPath),
    omarchyCliAvailable: findOmarchyBin('omarchy') !== null,
  };
}

export function installOmarchyPlugin(
  opts: OmarchyPluginOptions = {},
): OmarchyPluginStatus & { validationOutput?: string; enabled?: boolean } {
  const sourceDir = getOmarchyPluginSourceDir();
  const targetDir = opts.targetDir ?? defaultPluginsDir();
  const installedDir = join(targetDir, OMARCHY_PLUGIN_ID);
  const runShell = opts.runShellCommands !== false;

  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceDir, installedDir, { recursive: true, force: true });

  let validationOutput: string | undefined;
  let enabled = false;

  if (runShell) {
    const omarchyBin = findOmarchyBin('omarchy');
    const omarchyShellBin = findOmarchyBin('omarchy-shell');

    if (omarchyBin) {
      try {
        const out = execFileSync(omarchyBin, ['plugin', 'validate', installedDir], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        validationOutput = out || 'ok';
      } catch (e: any) {
        validationOutput = e?.stdout?.toString?.() || e?.message || String(e);
      }
    }

    if (omarchyShellBin) {
      try {
        execFileSync(omarchyShellBin, ['shell', 'rescanPlugins'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {}
    }

    if (opts.enable && omarchyBin) {
      try {
        execFileSync(omarchyBin, ['plugin', 'enable', OMARCHY_PLUGIN_ID], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        enabled = true;
      } catch {}
    }

    const shellConfigPath = opts.shellConfigPath ?? defaultShellConfigPath();
    if (omarchyBin && (enabled || isEnabledInShellJson(shellConfigPath))) {
      try {
        execFileSync(omarchyBin, ['restart', 'shell'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {}
    }
  }

  const status = getOmarchyPluginStatus(opts);
  return {
    ...status,
    validationOutput,
    enabled: enabled || status.enabledInShellConfig,
  };
}

export function uninstallOmarchyPlugin(opts: OmarchyPluginOptions = {}): { removed: boolean; installedDir: string } {
  const targetDir = opts.targetDir ?? defaultPluginsDir();
  const installedDir = join(targetDir, OMARCHY_PLUGIN_ID);
  const runShell = opts.runShellCommands !== false;

  if (runShell) {
    const omarchyBin = findOmarchyBin('omarchy');
    const omarchyShellBin = findOmarchyBin('omarchy-shell');
    if (omarchyBin) {
      try {
        execFileSync(omarchyBin, ['plugin', 'disable', OMARCHY_PLUGIN_ID], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {}
    }
    if (omarchyShellBin) {
      try {
        execFileSync(omarchyShellBin, ['shell', 'rescanPlugins'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {}
    }
  }

  const existed = existsSync(installedDir);
  if (existed) {
    rmSync(installedDir, { recursive: true, force: true });
  }
  return { removed: existed, installedDir };
}
