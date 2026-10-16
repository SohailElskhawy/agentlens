import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CHARS_PER_TOKEN } from '../constants.ts';
import type { RawConfigItem } from '../../types.ts';

function stripComment(str: string): string {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"' && !inSingle && (i === 0 || str[i - 1] !== '\\')) {
      inDouble = !inDouble;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '#' && !inDouble && !inSingle) {
      return str.slice(0, i).trim();
    }
  }
  return str.trim();
}

function parseSectionParts(path: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if ((ch === '"' || ch === "'") && !inQuote) {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === quoteChar && inQuote) {
      inQuote = false;
    } else if (ch === '.' && !inQuote) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/**
 * Parses `[mcp_servers.<name>]` sections from a TOML string without external dependencies.
 */
export function parseTomlMcpServers(content: string): Record<string, Record<string, any>> {
  const servers: Record<string, Record<string, any>> = {};
  const lines = content.split('\n');
  let currentServer: string | null = null;
  let currentSubkey: string | null = null;

  for (let line of lines) {
    line = stripComment(line);
    if (!line) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      const inner = line.slice(1, -1).trim();
      if (inner.startsWith('mcp_servers.')) {
        const rest = inner.slice('mcp_servers.'.length).trim();
        const parts = parseSectionParts(rest);
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
      const eqIdx = line.indexOf('=');
      if (eqIdx !== -1) {
        let rawKey = line.slice(0, eqIdx).trim();
        let rawVal: any = line.slice(eqIdx + 1).trim();
        if ((rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith("'") && rawKey.endsWith("'"))) {
          rawKey = rawKey.slice(1, -1);
        }
        if ((rawVal.startsWith('"') && rawVal.endsWith('"')) || (rawVal.startsWith("'") && rawVal.endsWith("'"))) {
          rawVal = rawVal.slice(1, -1);
        } else if (rawVal === 'true') {
          rawVal = true;
        } else if (rawVal === 'false') {
          rawVal = false;
        } else if (!isNaN(Number(rawVal)) && rawVal !== '') {
          rawVal = Number(rawVal);
        }

        if (currentSubkey) {
          servers[currentServer][currentSubkey][rawKey] = rawVal;
        } else {
          servers[currentServer][rawKey] = rawVal;
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
