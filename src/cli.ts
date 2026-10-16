#!/usr/bin/env node
import { existsSync, mkdirSync, watch, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { ADAPTERS, ingest } from './ingest.ts';
import { startServer } from './server.ts';
import { drainQuotaSpool, formatStatusline, spoolQuota, writeSummary } from './summary.ts';

const env = process.env;
const HOME = env.AGENTLENS_SOURCE_HOME ?? homedir();
const DATA_DIR = env.AGENTLENS_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'agentlens');
const STATE_DIR = env.AGENTLENS_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'agentlens');
const DB_PATH = join(DATA_DIR, 'agentlens.db');
const SUMMARY_PATH = join(STATE_DIR, 'summary.json');
const SPOOL_PATH = join(STATE_DIR, 'claude-quota.jsonl');
const PORT = Number(env.AGENTLENS_PORT ?? 4711);

const HELP = `Usage: agentlens <command>

  serve               ingest continuously and serve the dashboard on http://127.0.0.1:${PORT}
  ingest              one-shot ingest of new agent log data, then exit
  statusline          process Claude Code statusline stdin, spool quota, and print status
  install-statusline  show configuration instructions for Claude Code statusline
  install-service     write a systemd user unit so serve starts at login (you enable it)
  help                show this message

Data: ${DB_PATH}`;

async function serve() {
  const db = openDb(DB_PATH);
  let running = false;
  let again = false;
  // One ingest at a time; a trigger during a run schedules exactly one follow-up run.
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        drainQuotaSpool(db, SPOOL_PATH);
        await ingest(db, HOME);
        writeSummary(db, SUMMARY_PATH);
      } while (again);
    } catch (e) {
      console.error('agentlens: ingest failed:', e);
    } finally {
      running = false;
    }
  };
  let server;
  try {
    server = await startServer(db, PORT);
  } catch (e) {
    console.error(`agentlens: cannot listen on 127.0.0.1:${PORT}: ${(e as Error).message}`);
    process.exit(1);
  }
  console.log(`agentlens dashboard: http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await run();

  // Throttle, not debounce: agents write continuously during a session, and a debounce would never fire.
  let timer: NodeJS.Timeout | undefined;
  const soon = () => {
    timer ??= setTimeout(() => {
      timer = undefined;
      run();
    }, 2000);
  };
  for (const a of ADAPTERS) {
    const root = a.root(HOME);
    if (existsSync(root)) {
      try {
        watch(root, { recursive: true }, soon);
      } catch (e) {
        console.error(`agentlens: cannot watch ${root}, relying on polling:`, (e as Error).message);
      }
    }
  }
  setInterval(run, 60_000); // fallback for missed watch events and for roots created after startup
}

function installService() {
  const dir = join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd/user');
  const path = join(dir, 'agentlens.service');
  // ponytail: pins the current node binary path; re-run install-service after upgrading node.
  const unit = `[Unit]
Description=agentlens: local AI agent usage monitor

[Service]
ExecStart="${process.execPath}" --no-warnings=ExperimentalWarning "${fileURLToPath(import.meta.url)}" serve
Restart=on-failure
Nice=10
IOSchedulingClass=idle
MemoryMax=200M

[Install]
WantedBy=default.target
`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, unit);
  console.log(`wrote ${path}
enable it with:  systemctl --user daemon-reload && systemctl --user enable --now agentlens
(optional) keep it running without an active login:  loginctl enable-linger $USER`);
}

const commands: Record<string, () => unknown> = {
  serve,
  async ingest() {
    const db = openDb(DB_PATH);
    drainQuotaSpool(db, SPOOL_PATH);
    const s = await ingest(db, HOME);
    writeSummary(db, SUMMARY_PATH);
    console.log(
      `${s.read}/${s.files} files read, ${s.events} events, ${s.errors} bad lines, ${s.skipped} oversized lines skipped`,
    );
  },
  statusline: async () => {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    spoolQuota(SPOOL_PATH, input);
    const out = formatStatusline(SUMMARY_PATH, process.cwd());
    process.stdout.write(out + '\n');
  },
  'install-statusline': () => {
    console.log(`Add this to ~/.claude/settings.json or project .claude/settings.json:

{
  "statusLine": {
    "command": "agentlens statusline"
  }
}
`);
  },
  'install-service': installService,
  help: () => console.log(HELP),
};

const cmd = process.argv[2] ?? 'help';
const fn = commands[cmd];
if (!fn) {
  console.error(`agentlens: unknown command "${cmd}"\n\n${HELP}`);
  process.exit(1);
}
await fn();
