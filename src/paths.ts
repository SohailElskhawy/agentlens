import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PlatformPaths {
  dataDir: string;
  stateDir: string;
  reportsDir: string;
  dbPath: string;
  summaryPath: string;
  spoolPath: string;
  candidatesPath: string;
}

export function getPlatformPaths(
  customHome?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): PlatformPaths {
  const defaultHome = homedir();
  const home = customHome ?? env.AGENTLENS_SOURCE_HOME ?? env.AGENTLENS_HOME ?? defaultHome;
  const isCustomHome = (customHome != null && customHome !== defaultHome) || env.AGENTLENS_SOURCE_HOME != null || env.AGENTLENS_HOME != null;
  const useAmbientEnv = !isCustomHome || env !== process.env;

  const legacyDb = join(home, '.local/share/agentlens/agentlens.db');
  const legacyExists = existsSync(legacyDb);

  let dataDir: string;
  if (env.AGENTLENS_DATA_DIR) {
    dataDir = env.AGENTLENS_DATA_DIR;
  } else if (legacyExists) {
    dataDir = join(home, '.local/share/agentlens');
  } else if (platform === 'darwin') {
    dataDir = join(home, 'Library/Application Support/agentlens');
  } else if (platform === 'win32') {
    dataDir = (useAmbientEnv && env.LOCALAPPDATA)
      ? join(env.LOCALAPPDATA, 'agentlens')
      : join(home, 'AppData/Local/agentlens');
  } else {
    dataDir = (useAmbientEnv && env.XDG_DATA_HOME)
      ? join(env.XDG_DATA_HOME, 'agentlens')
      : join(home, '.local/share/agentlens');
  }

  let stateDir: string;
  if (env.AGENTLENS_STATE_DIR) {
    stateDir = env.AGENTLENS_STATE_DIR;
  } else if (legacyExists) {
    stateDir = join(home, '.local/state/agentlens');
  } else if (platform === 'darwin') {
    stateDir = join(home, 'Library/Caches/agentlens');
  } else if (platform === 'win32') {
    stateDir = (useAmbientEnv && env.LOCALAPPDATA)
      ? join(env.LOCALAPPDATA, 'agentlens/state')
      : join(home, 'AppData/Local/agentlens/state');
  } else {
    stateDir = (useAmbientEnv && env.XDG_STATE_HOME)
      ? join(env.XDG_STATE_HOME, 'agentlens')
      : join(home, '.local/state/agentlens');
  }

  return {
    dataDir,
    stateDir,
    reportsDir: join(dataDir, 'reports'),
    dbPath: join(dataDir, 'agentlens.db'),
    summaryPath: join(stateDir, 'summary.json'),
    spoolPath: join(stateDir, 'claude-quota.jsonl'),
    candidatesPath: join(dataDir, 'discovery_candidates.json'),
  };
}

export function getOpenCodeDataRoots(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  const defaultHome = homedir();
  const useAmbientEnv = home === defaultHome || env !== process.env;

  const linuxRoot = (useAmbientEnv && env.XDG_DATA_HOME)
    ? join(env.XDG_DATA_HOME, 'opencode')
    : join(home, '.local/share/opencode');
  const darwinRoot = join(home, 'Library/Application Support/opencode');
  const winRoaming = (useAmbientEnv && env.APPDATA)
    ? join(env.APPDATA, 'opencode')
    : join(home, 'AppData/Roaming/opencode');
  const winLocal = (useAmbientEnv && env.LOCALAPPDATA)
    ? join(env.LOCALAPPDATA, 'opencode')
    : join(home, 'AppData/Local/opencode');

  const candidates: string[] = [];
  if (platform === 'darwin') {
    candidates.push(darwinRoot, linuxRoot, winRoaming, winLocal);
  } else if (platform === 'win32') {
    candidates.push(winRoaming, winLocal, darwinRoot, linuxRoot);
  } else {
    candidates.push(linuxRoot, darwinRoot, winRoaming, winLocal);
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

export function getOpenCodeConfigRoots(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  const defaultHome = homedir();
  const useAmbientEnv = home === defaultHome || env !== process.env;

  const linuxConfig = (useAmbientEnv && env.XDG_CONFIG_HOME)
    ? join(env.XDG_CONFIG_HOME, 'opencode')
    : join(home, '.config/opencode');
  const darwinConfig = join(home, 'Library/Application Support/opencode');
  const winRoaming = (useAmbientEnv && env.APPDATA)
    ? join(env.APPDATA, 'opencode')
    : join(home, 'AppData/Roaming/opencode');
  const winLocal = (useAmbientEnv && env.LOCALAPPDATA)
    ? join(env.LOCALAPPDATA, 'opencode')
    : join(home, 'AppData/Local/opencode');

  const candidates: string[] = [];
  if (platform === 'darwin') {
    candidates.push(darwinConfig, linuxConfig, winRoaming, winLocal);
  } else if (platform === 'win32') {
    candidates.push(winRoaming, winLocal, darwinConfig, linuxConfig);
  } else {
    candidates.push(linuxConfig, darwinConfig, winRoaming, winLocal);
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}
