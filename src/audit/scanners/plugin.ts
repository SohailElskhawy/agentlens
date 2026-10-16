import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { getOpenCodeConfigRoots } from '../../paths.ts';
import { CHARS_PER_TOKEN } from '../constants.ts';
import type { RawConfigItem } from '../../types.ts';

export function scanPlugins(
  arg1: string | { id: number; root: string; name: string }[],
  arg2?: string | { id: number; root: string; name: string }[]
): RawConfigItem[] {
  let home: string;
  let projects: { id: number; root: string; name: string }[];
  if (typeof arg1 === 'string') {
    home = arg1;
    projects = Array.isArray(arg2) ? arg2 : [];
  } else {
    projects = Array.isArray(arg1) ? arg1 : [];
    home = typeof arg2 === 'string' ? arg2 : homedir();
  }

  const items: RawConfigItem[] = [];

  // 1. Claude plugins: parse installed_plugins.json or plugin manifest directories
  const installedPluginsPath = join(home, '.claude/plugins/installed_plugins.json');
  try {
    if (existsSync(installedPluginsPath)) {
      const data = JSON.parse(readFileSync(installedPluginsPath, 'utf-8'));
      if (data.plugins && typeof data.plugins === 'object') {
        for (const [pluginId, installs] of Object.entries<any>(data.plugins)) {
          const name = pluginId.includes('@') ? pluginId.split('@')[0] : pluginId;
          const firstInstall = Array.isArray(installs) ? installs[0] : installs;
          items.push({
            agent: 'claude',
            projectId: null,
            kind: 'plugin',
            name,
            sourcePath: firstInstall?.installPath || installedPluginsPath,
            tokens: 100, // base estimate
            details: { pluginId, ...(typeof firstInstall === 'object' ? firstInstall : {}) },
          });
        }
      }
    }
  } catch {}

  // 2. OpenCode plugins in opencode.json across candidate config roots
  const opencodeRoots = getOpenCodeConfigRoots(home);
  const seenOpenCodePlugins = new Set<string>();
  for (const root of opencodeRoots) {
    const opencodeJson = join(root, 'opencode.json');
    try {
      if (existsSync(opencodeJson)) {
        const data = JSON.parse(readFileSync(opencodeJson, 'utf-8'));
        if (Array.isArray(data.plugins)) {
          for (const p of data.plugins) {
            const name = typeof p === 'string' ? p : p.name ?? 'unknown';
            if (seenOpenCodePlugins.has(name)) continue;
            seenOpenCodePlugins.add(name);
            items.push({
              agent: 'opencode',
              projectId: null,
              kind: 'plugin',
              name,
              sourcePath: opencodeJson,
              tokens: 100,
              details: typeof p === 'object' ? p : {},
            });
          }
        }
      }
    } catch {}
  }

  // 3. Antigravity plugins (~/.gemini/config/plugins/*)
  const geminiPluginsDir = join(home, '.gemini/config/plugins');
  try {
    if (existsSync(geminiPluginsDir) && statSync(geminiPluginsDir).isDirectory()) {
      for (const name of readdirSync(geminiPluginsDir)) {
        const fullPath = join(geminiPluginsDir, name);
        items.push({
          agent: 'antigravity',
          projectId: null,
          kind: 'plugin',
          name,
          sourcePath: fullPath,
          tokens: 100,
          details: { directory: fullPath },
        });
      }
    }
  } catch {}

  return items;
}

export const scanPluginConfigs = scanPlugins;

