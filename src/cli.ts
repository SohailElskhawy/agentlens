#!/usr/bin/env node
import { existsSync, mkdirSync, watch, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { ADAPTERS, ingest } from './ingest.ts';
import { costOf } from './pricing.ts';
import { projectName, projectRoot } from './project.ts';
import { startServer } from './server.ts';
import { drainQuotaSpool, formatStatusline, spoolQuota, writeSummary } from './summary.ts';
import { runAudit } from './audit/runner.ts';

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
  status              show terminal summary for current project or --project <path>
  audit               audit agent instructions, MCPs, skills, and plugins
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
  status: () => {
    let projectArg: string | undefined;
    for (let i = 3; i < process.argv.length; i++) {
      if (process.argv[i] === '--project' && process.argv[i + 1]) {
        projectArg = process.argv[i + 1];
        i++;
      }
    }
    const targetPath = projectArg ?? process.cwd();
    const root = projectRoot(targetPath);
    const name = projectName(root);

    if (!existsSync(DB_PATH)) {
      console.log(`No database found at ${DB_PATH}. Run 'agentlens ingest' first.`);
      return;
    }

    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const proj = db.prepare('SELECT id FROM projects WHERE root = ?').get(root) as { id: number } | undefined;
    const projId = proj?.id;

    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const todayTs = midnight.getTime();
    const sevenDaysTs = Date.now() - 7 * 86400_000;

    function getUsage(fromTs: number) {
      if (projId == null) return { tokens: 0, cost: 0 };
      const sql = `SELECT e.model,
                    coalesce(sum(e.input), 0) AS input,
                    coalesce(sum(e.output), 0) AS output,
                    coalesce(sum(e.cache_read), 0) AS cacheRead,
                    coalesce(sum(e.cache_write), 0) AS cacheWrite,
                    coalesce(sum(e.cache_write_1h), 0) AS cacheWrite1h
             FROM events e
             JOIN sessions s ON s.id = e.session_id
             WHERE s.project_id = ? AND e.ts >= ?
             GROUP BY e.model`;
      const rows = db.prepare(sql).all(projId, fromTs) as {
        model: string | null;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cacheWrite1h: number;
      }[];

      let tokens = 0;
      let cost: number | null = 0;
      for (const r of rows) {
        const u = {
          input: r.input,
          output: r.output,
          cacheRead: r.cacheRead,
          cacheWrite: r.cacheWrite,
          cacheWrite1h: r.cacheWrite1h,
        };
        tokens += r.input + r.output + r.cacheRead + r.cacheWrite;
        const c = costOf(r.model, u);
        if (c == null) cost = null;
        else if (cost != null) cost += c;
      }
      return { tokens, cost };
    }

    const todayUsage = getUsage(todayTs);
    const weekUsage = getUsage(sevenDaysTs);

    const quotaRows = db.prepare(`
      SELECT agent, win, used_pct AS usedPct, resets_at AS resetsAt
      FROM quota_snapshots q
      WHERE ts = (SELECT max(ts) FROM quota_snapshots WHERE agent = q.agent AND win = q.win)
      ORDER BY agent, win
    `).all() as { agent: string; win: string; usedPct: number; resetsAt: number }[];

    const formatCost = (c: number | null) => (c == null ? 'unpriced' : `$${c.toFixed(2)}`);

    console.log(`\n==================================================`);
    console.log(`Project: ${name} (${root})`);
    console.log(`==================================================\n`);
    console.log(`Tokens (measured):`);
    console.log(`  Today: ${todayUsage.tokens.toLocaleString()} tokens`);
    console.log(`  7-day: ${weekUsage.tokens.toLocaleString()} tokens\n`);
    console.log(`API-equivalent cost (estimated):`);
    console.log(`  Today: ${formatCost(todayUsage.cost)}`);
    console.log(`  7-day: ${formatCost(weekUsage.cost)}\n`);
    console.log(`Quota used (reported by agent):`);
    if (quotaRows.length === 0) {
      console.log(`  n/a`);
    } else {
      for (const q of quotaRows) {
        const agentName = q.agent.charAt(0).toUpperCase() + q.agent.slice(1);
        const minsLeft = Math.max(0, Math.round((q.resetsAt - Date.now()) / 60_000));
        const resetStr = minsLeft >= 60 ? `${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m` : `${minsLeft}m`;
        console.log(`  ${agentName} ${q.win}: ${Math.round(q.usedPct)}% (resets in ${resetStr})`);
      }
    }
    console.log(`==================================================\n`);
  },
  audit: () => {
    let projectArg: string | undefined;
    for (let i = 3; i < process.argv.length; i++) {
      if (process.argv[i] === '--project' && process.argv[i + 1]) {
        projectArg = process.argv[i + 1];
        i++;
      }
    }
    const targetPath = projectArg ?? process.cwd();
    const root = projectRoot(targetPath);
    const name = projectName(root);

    const db = openDb(DB_PATH);
    const proj = db.prepare('SELECT id FROM projects WHERE root = ?').get(root) as { id: number } | undefined;
    const projId = proj?.id;

    // Run audit to collect fresh configuration inventory
    const { items } = runAudit(db, HOME);
    const filteredItems = projId != null ? items.filter((i) => i.projectId === projId || i.projectId === null) : items;

    const instructions = filteredItems.filter((i) => i.kind === 'instruction');
    const toolsAndMcps = filteredItems.filter((i) => i.kind !== 'instruction');
    const fixedTokens = instructions.reduce((sum, i) => sum + i.tokens, 0);

    const activeCount = filteredItems.filter((i) => i.status === 'active').length;
    const unusedCount = filteredItems.filter((i) => i.status === 'unused').length;
    const dupCount = filteredItems.filter((i) => i.status === 'duplicate').length;
    const conflictCount = filteredItems.filter((i) => i.status === 'conflict').length;

    console.log(`\n==================================================`);
    console.log(`Configuration Audit: ${name} (${root})`);
    console.log(`==================================================\n`);
    console.log(`Overview:`);
    console.log(`  Fixed instruction overhead: ${fixedTokens.toLocaleString()} tokens per session`);
    console.log(`  Configured items: ${filteredItems.length} total (${activeCount} active, ${unusedCount} unused, ${dupCount} duplicate, ${conflictCount} conflict)\n`);

    if (instructions.length > 0) {
      console.log(`Instruction Files:`);
      for (const inst of instructions) {
        console.log(`  - [${inst.agent}] ${inst.name} (${inst.tokens.toLocaleString()} tokens) -> ${inst.sourcePath}`);
      }
      console.log('');
    }

    if (toolsAndMcps.length > 0) {
      console.log(`Tools, MCPs & Skills:`);
      for (const t of toolsAndMcps) {
        const statusBadge = t.status === 'active' ? '[active]' : `[${t.status.toUpperCase()}]`;
        const invStr = t.invocations30d > 0 ? `${t.invocations30d} calls in 30d` : '0 calls (stale)';
        console.log(`  - ${statusBadge} [${t.agent}] ${t.kind.toUpperCase()}: ${t.name} (${invStr})`);
      }
      console.log('');
    }

    const issues = filteredItems.filter((i) => i.status === 'duplicate' || i.status === 'conflict');
    if (issues.length > 0) {
      console.log(`Flagged Duplicates & Conflicts:`);
      for (const issue of issues) {
        console.log(`  ! [${issue.status.toUpperCase()}] ${issue.name}: ${issue.sourcePath}`);
      }
      console.log('');
    }
    console.log(`==================================================\n`);
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
