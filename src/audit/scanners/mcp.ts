import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CHARS_PER_TOKEN } from '../constants.ts';
import type { RawConfigItem } from '../../types.ts';

/**
 * Parses `[mcp_servers.<name>]` sections from a TOML string without external dependencies.
 */
export function parseTomlMcpServers(content: string): Record<string, Record<string, any>> {
  const servers: Record<string, Record<string, any>> = {};
  const lines = content.split('\n');
  let currentServer: string | null = null;
  let currentSubkey: string | null = null;

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[([a-zA-Z0-9_\.\-]+)\]$/);
    if (sectionMatch) {
      const section = sectionMatch[1];
      if (section.startsWith('mcp_servers.')) {
        const parts = section.slice('mcp_servers.'.length).split('.');
        currentServer = parts[0];
        currentSubkey = parts.length > 1 ? parts.slice(1).join('.') : null;
        if (!servers[currentServer]) servers[currentServer] = {};
        if (currentSubkey && !servers[currentServer][currentSubkey]) {
          servers[currentServer][currentSubkey] = {};
        }
      } else {
        currentServer = null;
        currentSubkey = null;
      }
      continue;
    }

    if (currentServer) {
      const kvMatch = line.match(/^([a-zA-Z0-9_\-]+)\s*=\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        let val: any = kvMatch[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        } else if (val === 'true') val = true;
        else if (val === 'false') val = false;
        else if (!isNaN(Number(val))) val = Number(val);

        if (currentSubkey) {
          servers[currentServer][currentSubkey][key] = val;
        } else {
          servers[currentServer][key] = val;
        }
      }
    }
  }

  return servers;
}

export function scanMcp(
  home: string,
  projects: { id: number; root: string; name: string }[]
): RawConfigItem[] {
  const items: RawConfigItem[] = [];

  // 1. Claude Code (.claude.json global + .mcp.json project)
  const claudeGlobalPath = join(home, '.claude.json');
  try {
    if (existsSync(claudeGlobalPath)) {
      const data = JSON.parse(readFileSync(claudeGlobalPath, 'utf-8'));
      if (data.mcpServers && typeof data.mcpServers === 'object') {
        for (const [name, cfg] of Object.entries(data.mcpServers)) {
          const cfgStr = JSON.stringify(cfg);
          items.push({
            agent: 'claude',
            projectId: null,
            kind: 'mcp',
            name,
            sourcePath: claudeGlobalPath,
            tokens: Math.ceil(cfgStr.length / CHARS_PER_TOKEN),
            details: cfg as any,
          });
        }
      }
    }
  } catch {}

  // 2. Codex config.toml
  const codexPath = join(home, '.codex/config.toml');
  try {
    if (existsSync(codexPath)) {
      const content = readFileSync(codexPath, 'utf-8');
      const servers = parseTomlMcpServers(content);
      for (const [name, cfg] of Object.entries(servers)) {
        const cfgStr = JSON.stringify(cfg);
        items.push({
          agent: 'codex',
          projectId: null,
          kind: 'mcp',
          name,
          sourcePath: codexPath,
          tokens: Math.ceil(cfgStr.length / CHARS_PER_TOKEN),
          details: cfg,
        });
      }
    }
  } catch {}

  // 3. OpenCode opencode.json
  const opencodePath = join(home, '.config/opencode/opencode.json');
  try {
    if (existsSync(opencodePath)) {
      const data = JSON.parse(readFileSync(opencodePath, 'utf-8'));
      const mcpObj = data.mcp || data.mcpServers;
      if (mcpObj && typeof mcpObj === 'object') {
        for (const [name, cfg] of Object.entries(mcpObj)) {
          const cfgStr = JSON.stringify(cfg);
          items.push({
            agent: 'opencode',
            projectId: null,
            kind: 'mcp',
            name,
            sourcePath: opencodePath,
            tokens: Math.ceil(cfgStr.length / CHARS_PER_TOKEN),
            details: cfg as any,
          });
        }
      }
    }
  } catch {}

  // 4. Antigravity MCP directory
  const antigravityDirs = [
    join(home, '.gemini/antigravity-cli/mcp'),
    join(home, '.gemini/antigravity/mcp'),
  ];
  for (const dir of antigravityDirs) {
    try {
      if (existsSync(dir) && statSync(dir).isDirectory()) {
        for (const serverDir of readdirSync(dir)) {
          const fullPath = join(dir, serverDir);
          if (statSync(fullPath).isDirectory()) {
            let schemaTokens = 100; // base estimate
            try {
              let chars = 0;
              for (const f of readdirSync(fullPath)) {
                if (f.endsWith('.json') || f.endsWith('.md')) {
                  chars += readFileSync(join(fullPath, f), 'utf-8').length;
                }
              }
              if (chars > 0) schemaTokens = Math.ceil(chars / CHARS_PER_TOKEN);
            } catch {}

            items.push({
              agent: 'antigravity',
              projectId: null,
              kind: 'mcp',
              name: serverDir,
              sourcePath: fullPath,
              tokens: schemaTokens,
              details: { directory: fullPath },
            });
          }
        }
      }
    } catch {}
  }

  // 5. Per-project MCP configs (.mcp.json, .claude.json)
  for (const p of projects) {
    for (const file of ['.mcp.json', '.claude.json']) {
      const pPath = join(p.root, file);
      try {
        if (existsSync(pPath)) {
          const data = JSON.parse(readFileSync(pPath, 'utf-8'));
          if (data.mcpServers && typeof data.mcpServers === 'object') {
            for (const [name, cfg] of Object.entries(data.mcpServers)) {
              const cfgStr = JSON.stringify(cfg);
              items.push({
                agent: 'claude',
                projectId: p.id,
                kind: 'mcp',
                name,
                sourcePath: pPath,
                tokens: Math.ceil(cfgStr.length / CHARS_PER_TOKEN),
                details: cfg as any,
              });
            }
          }
        }
      } catch {}
    }
  }

  return items;
}
