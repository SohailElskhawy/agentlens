import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CHARS_PER_TOKEN } from '../constants.ts';
import type { RawConfigItem } from '../../types.ts';

export function scanPlugins(
  home: string,
  _projects: { id: number; root: string; name: string }[]
): RawConfigItem[] {
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

  // 2. OpenCode plugins in opencode.json
  const opencodeJson = join(home, '.config/opencode/opencode.json');
  try {
    if (existsSync(opencodeJson)) {
      const data = JSON.parse(readFileSync(opencodeJson, 'utf-8'));
      if (Array.isArray(data.plugins)) {
        for (const p of data.plugins) {
          const name = typeof p === 'string' ? p : p.name ?? 'unknown';
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
