import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformPaths } from './paths.ts';

export interface ServiceConfigResult {
  platform: NodeJS.Platform;
  targetPath: string;
  content: string;
  enableCommand: string;
  auxiliaryPath?: string;
  auxiliaryContent?: string;
}

export function generateServiceConfig(
  platform: NodeJS.Platform,
  options: {
    nodePath: string;
    cliPath: string;
    stateDir: string;
    home: string;
    env?: NodeJS.ProcessEnv;
  }
): ServiceConfigResult {
  const defaultHome = homedir();
  const isCustomHome = options.home !== defaultHome;
  const useAmbientEnv = !isCustomHome || options.env !== undefined;
  const env = options.env ?? (useAmbientEnv ? process.env : {});

  if (platform === 'darwin') {
    const targetPath = join(options.home, 'Library/LaunchAgents/com.agentlens.plist');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.agentlens</string>
	<key>ProgramArguments</key>
	<array>
		<string>${options.nodePath}</string>
		<string>--no-warnings=ExperimentalWarning</string>
		<string>${options.cliPath}</string>
		<string>serve</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${join(options.stateDir, 'agentlens.log')}</string>
	<key>StandardErrorPath</key>
	<string>${join(options.stateDir, 'agentlens.err')}</string>
</dict>
</plist>
`;
    return {
      platform,
      targetPath,
      content,
      enableCommand: `launchctl load -w "${targetPath}"`,
    };
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? join(options.home, 'AppData', 'Local');
    const targetPath = join(localAppData, 'agentlens', 'agentlens-service.cmd');
    const content = `@echo off\r\n"${options.nodePath}" --no-warnings=ExperimentalWarning "${options.cliPath}" serve %*\r\n`;
    return {
      platform,
      targetPath,
      content,
      enableCommand: `schtasks /create /tn "agentlens" /tr "\"${options.nodePath}\" --no-warnings=ExperimentalWarning \"${options.cliPath}\" serve" /sc onlogon /f`,
      auxiliaryPath: targetPath,
      auxiliaryContent: content,
    };
  }

  // Linux and other Unix-like systems
  const targetDir = env.XDG_CONFIG_HOME
    ? join(env.XDG_CONFIG_HOME, 'systemd/user')
    : join(options.home, '.config/systemd/user');
  const targetPath = join(targetDir, 'agentlens.service');
  const content = `[Unit]
Description=agentlens: local AI agent usage monitor

[Service]
ExecStart="${options.nodePath}" --no-warnings=ExperimentalWarning "${options.cliPath}" serve
Restart=on-failure
Nice=10
IOSchedulingClass=idle
MemoryMax=200M

[Install]
WantedBy=default.target
`;
  return {
    platform,
    targetPath,
    content,
    enableCommand: 'systemctl --user daemon-reload && systemctl --user enable --now agentlens',
  };
}

export function installService(options?: {
  platform?: NodeJS.Platform;
  home?: string;
  execPath?: string;
  cliPath?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
}): { success: boolean; message: string } {
  const platform = options?.platform ?? process.platform;
  const env = options?.env;
  const defaultHome = homedir();
  const home = options?.home ?? process.env.AGENTLENS_SOURCE_HOME ?? defaultHome;
  const execPath = options?.execPath ?? process.execPath;
  const cliPath = options?.cliPath ?? join(dirname(fileURLToPath(import.meta.url)), 'cli.ts');
  const stateDir = options?.stateDir ?? getPlatformPaths(home, env ?? process.env, platform).stateDir;

  const config = generateServiceConfig(platform, {
    nodePath: execPath,
    cliPath,
    stateDir,
    home,
    env,
  });

  try {
    mkdirSync(dirname(config.targetPath), { recursive: true });
    writeFileSync(config.targetPath, config.content, 'utf8');

    if (config.auxiliaryPath && config.auxiliaryContent && config.auxiliaryPath !== config.targetPath) {
      mkdirSync(dirname(config.auxiliaryPath), { recursive: true });
      writeFileSync(config.auxiliaryPath, config.auxiliaryContent, 'utf8');
    }

    let message = `wrote ${config.targetPath}\n`;
    if (config.auxiliaryPath && config.auxiliaryPath !== config.targetPath) {
      message += `wrote ${config.auxiliaryPath}\n`;
    }
    message += `enable it with:  ${config.enableCommand}`;
    if (platform === 'linux') {
      message += `\n(optional) keep it running without an active login:  loginctl enable-linger $USER`;
    } else if (platform === 'darwin') {
      message += `\n(optional) to unload:  launchctl unload -w "${config.targetPath}"`;
    } else if (platform === 'win32') {
      message += `\n(optional) to run manually:  schtasks /run /tn "agentlens"`;
    }

    return {
      success: true,
      message,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    let message = `Failed to install service configuration: ${errorMsg}\n\nManual setup instructions:\n`;
    message += `1. Create ${config.targetPath} with:\n${config.content}\n\n`;
    if (config.auxiliaryPath && config.auxiliaryPath !== config.targetPath) {
      message += `2. Create ${config.auxiliaryPath} with:\n${config.auxiliaryContent}\n\n`;
    }
    message += `3. Enable command:\n   ${config.enableCommand}\n`;
    return {
      success: false,
      message,
    };
  }
}
