#!/usr/bin/env node
import { existsSync, realpathSync, watch } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDb, getRecommendations, setSetting, updateRecommendationStatus } from './db.ts';
import { aiStatus } from './ai/gate.ts';
import { explainAnomaly, prepareExplanation } from './ai/explain.ts';
import { enrichRecommendations } from './ai/recommendations.ts';
import { rewriteInstructions } from './ai/instruction-rewrite.ts';
import { diagnoseSession, prepareDiagnosis, renderDiagnosisMarkdown, worstSessions } from './ai/diagnose.ts';
import type { DiagnosisPreview } from './ai/diagnose.ts';
import { ADAPTERS, ingest } from './ingest.ts';
import { costOf } from './pricing.ts';
import { projectName, projectRoot } from './project.ts';
import { startServer } from './server.ts';
import { drainQuotaSpool, formatStatusline, spoolQuota, writeSummary, type StatuslineFormat } from './summary.ts';
import { runAudit } from './audit/runner.ts';
import { checkWeeklyReportSchedule } from './report-scheduler.ts';
import { generateWeeklyReport } from './report.ts';
import { evaluateRecommendations } from './track.ts';
import { getSavings, snapshotSavings } from './savings.ts';
import { getCuratedCatalog } from './catalog.ts';
import { discoverGitHubCandidates } from './discover.ts';
import { getPlatformPaths } from './paths.ts';
import { installService } from './service.ts';
import { computeQuotaForecasts } from './quota-forecast.ts';
import { checkLiveAlerts } from './alerts.ts';
import { exportData } from './export.ts';
import { formatOptimizeReport, optimizeWorkspace } from './optimize.ts';
import { getOmarchyPluginStatus, installOmarchyPlugin, uninstallOmarchyPlugin } from './omarchy-plugin.ts';
import { generateCheatsheet } from './cheatsheet.ts';
import { subscriptionComparison } from './roi.ts';

const env = process.env;
const HOME = env.AGENTLENS_SOURCE_HOME ?? homedir();
const platformPaths = getPlatformPaths();
const DATA_DIR = platformPaths.dataDir;
const STATE_DIR = platformPaths.stateDir;
const DB_PATH = platformPaths.dbPath;
const SUMMARY_PATH = platformPaths.summaryPath;
const SPOOL_PATH = platformPaths.spoolPath;
const PORT = Number(env.AGENTLENS_PORT ?? 4711);

const HELP = `Usage: agentlens <command>

  serve               ingest continuously and serve the dashboard on http://127.0.0.1:${PORT}
  ingest              one-shot ingest of new agent log data, then exit
  status              show terminal summary for current project or --project <path>
  ai <action>         AI status, enable, disable, or preview <diagnose|session> <id>
  recommend           show recommendations [--ai] [--preview] [--confirm <hash>]
  explain anomaly     explain a detected spike <date> <project> [--agent <agent>] [--preview | --confirm <hash>] [--json]
  diagnose            AI diagnosis of a session <id> or --worst <N> (--project, --json, --preview, --confirm <hash>)
  optimize [path]     workspace hygiene or instruction rewrite (--ai, --preview, --confirm <hash>, --apply, --json)
  cheatsheet [path]   architecture cheat-sheet from hot_files (--project <path>, --top <N>, --json)
  export              export sessions, daily totals, or findings (--format csv|json, --type, --from, --to, --project)
  audit               audit agent instructions, MCPs, skills, and plugins
  report              generate and display weekly usage report (--week, --html, --json)
  track               show improvement tracking for accepted recommendations
  roi                 estimated Claude API/list-price comparison (--plan pro|max5x|max20x, --days <N>, --json)
  savings             compare weekly project metrics (--project <path>, --weeks <N> [default 8], --json, --snapshot)
  accept <id>         accept a recommendation and begin 14-day improvement tracking
  catalog             browse curated AI tools, MCPs, and skills (--json, --rule <rule>)
  discover            opt-in discovery of AI agent tools from GitHub (--query, --dry-run, --json)
  plugin [action]     manage Omarchy Quattro bar-widget plugin (install|status|uninstall, --enable, --dir <path>, --json)
  statusline          process Claude Code statusline stdin, spool quota, and print status
  install-statusline  show configuration instructions for Claude Code statusline
  install-service     install background service (systemd, launchd, or scheduled task) so serve starts at login
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
        try { checkWeeklyReportSchedule(db, HOME); } catch {}
        try { checkLiveAlerts(db); } catch {}
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

const commands: Record<string, () => unknown> = {
  ai: () => {
    const action = process.argv[3]?.startsWith('--') ? 'status' : process.argv[3] ?? 'status';
    if (action === 'preview') {
      const kind = process.argv[4];
      const id = process.argv[5];
      if (!['diagnose', 'session'].includes(kind) || !id) {
        console.error('Usage: agentlens ai preview <diagnose|session> <id>');
        process.exitCode = 1;
        return;
      }
      if (!existsSync(DB_PATH)) {
        console.error('No database found');
        process.exitCode = 1;
        return;
      }
      const db = new DatabaseSync(DB_PATH, { readOnly: true });
      try {
        const prepared = prepareDiagnosis(db, id);
        if (prepared.status === 'error') { console.error(`AI preview: ${prepared.message.toLowerCase()}`); process.exitCode = 1; return; }
        console.log(JSON.stringify(prepared.preview, null, 2));
      } catch {
        console.error('AI preview failed: check session, settings, and supported provider');
        process.exitCode = 1;
      } finally {
        db.close();
      }
      return;
    }
    if (!['status', 'enable', 'disable'].includes(action)) {
      console.error('Usage: agentlens ai <status|enable|disable> [--json]');
      process.exitCode = 1;
      return;
    }
    const db = openDb(DB_PATH);
    try {
      if (action !== 'status') setSetting(db, 'ai_enabled', action === 'enable' ? 'true' : 'false');
      const status = aiStatus(db);
      if (process.argv.includes('--json')) console.log(JSON.stringify(status, null, 2));
      else console.log(`AI: ${status.enabled ? 'enabled' : 'disabled'}\nAgent: ${status.agent ?? 'invalid'}\nModel: ${status.model ?? 'default'}\nCalls today: ${status.callsToday}/${status.maxCallsPerDay ?? 'invalid'}${status.error ? `\nStatus: ${status.error}` : ''}`);
    } finally {
      db.close();
    }
  },
  recommend: async () => {
    let values;
    try { ({ values } = parseArgs({ args: process.argv.slice(3), options: { ai: { type: 'boolean' }, preview: { type: 'boolean' }, confirm: { type: 'string' } } })); }
    catch { console.error('Usage: agentlens recommend [--ai] [--preview] [--confirm <hash>]'); process.exitCode = 1; return; }
    if ((!values.ai && (values.preview || values.confirm)) || (values.preview && values.confirm) || (values.confirm && !/^[a-f0-9]{64}$/.test(values.confirm))) { console.error('Invalid recommendation AI options'); process.exitCode = 1; return; }
    if (!existsSync(DB_PATH)) { console.error('No database found'); process.exitCode = 1; return; }
    const db = values.preview ? new DatabaseSync(DB_PATH, { readOnly: true }) : openDb(DB_PATH);
    try {
      const recs = getRecommendations(db);
      if (!values.ai) { console.log(JSON.stringify(recs, null, 2)); return; }
      const result = await enrichRecommendations(db, recs, { preview: values.preview, confirm: values.confirm });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== 'ok' && !values.preview) process.exitCode = 1;
    } finally { db.close(); }
  },
  explain: async () => {
    const usage = 'Usage: agentlens explain anomaly <YYYY-MM-DD> <project name or ID> [--agent <agent>] [--preview | --confirm <hash>] [--json]';
    let parsed;
    try { parsed = parseArgs({ args: process.argv.slice(3), allowPositionals: true, options: {
      agent: { type: 'string' }, preview: { type: 'boolean' }, confirm: { type: 'string' }, json: { type: 'boolean' },
    } }); } catch { console.error(usage); process.exitCode = 1; return; }
    const { values, positionals } = parsed;
    if (positionals.length !== 3 || positionals[0] !== 'anomaly' || !positionals[2] || (values.agent !== undefined && !values.agent) ||
      (values.preview && values.confirm) || (values.confirm !== undefined && !/^[a-f0-9]{64}$/.test(values.confirm))) {
      console.error(usage); process.exitCode = 1; return;
    }
    if (!existsSync(DB_PATH)) { console.error('No database found'); process.exitCode = 1; return; }
    const db = values.preview ? new DatabaseSync(DB_PATH, { readOnly: true }) : openDb(DB_PATH);
    try {
      const [, date, project] = positionals;
      const result = values.preview ? prepareExplanation(db, date, project, { agent: values.agent }) :
        await explainAnomaly(db, date, project, { agent: values.agent, confirm: values.confirm });
      if (result.status === 'error' || result.status === 'confirmation_required') process.exitCode = 1;
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else if (result.status === 'error') console.error(`${result.code}: ${result.message}`);
      else if (result.status === 'ok') console.log(`${result.explanation}\n\nAI interpretation of structured metadata; causes are unverified.${result.cached ? ' (cached)' : ''}`);
      else {
        const p = result.preview;
        console.log(`Provider: ${p.agent}${p.model ? ` (${p.model})` : ''}\nCommand: ${p.bin} ${p.args.slice(0, -1).join(' ')} -- <prompt>\nConfirmation hash: ${p.confirmationHash}\n--- exact prompt sent ---\n${p.prompt}\n--- end prompt ---`);
        if (result.status === 'confirmation_required') console.error('Confirmation required; review the prompt and rerun with --confirm HASH');
      }
    } catch { console.error('explain failed: check the anomaly and settings'); process.exitCode = 1; }
    finally { db.close(); }
  },
  diagnose: async () => {
    const usage = 'Usage: agentlens diagnose <session-id> | --worst <N> [--project <path>] [--json] [--preview] [--confirm <hash>]...';
    const bad = (message: string) => { console.error(`${message}\n${usage}`); process.exitCode = 1; };
    let parsed;
    try {
      parsed = parseArgs({ args: process.argv.slice(3), allowPositionals: true, options: {
        worst: { type: 'string' }, project: { type: 'string' }, json: { type: 'boolean' }, preview: { type: 'boolean' },
        confirm: { type: 'string', multiple: true },
      } });
    } catch { return bad('Invalid option'); }
    const { values, positionals } = parsed;
    const confirms = values.confirm ?? [];
    if (positionals.length > 1) return bad('Expected exactly one session id');
    if (values.worst !== undefined && positionals.length) return bad('Use either a session id or --worst, not both');
    if (values.worst === undefined && !positionals.length) return bad('Missing session id or --worst');
    if (values.worst !== undefined && !/^[1-9]\d?$/.test(values.worst)) return bad('--worst must be an integer from 1 to 99');
    if (values.project !== undefined && (values.worst === undefined || !values.project.trim())) return bad('--project requires --worst and a path');
    if (values.preview && confirms.length) return bad('--preview cannot be combined with --confirm');
    if (confirms.some(c => !/^[a-f0-9]{64}$/.test(c))) return bad('--confirm expects a 64-character preview hash');
    if (!existsSync(DB_PATH)) { console.error('No database found'); process.exitCode = 1; return; }
    const db = values.preview ? new DatabaseSync(DB_PATH, { readOnly: true }) : openDb(DB_PATH);
    try {
      let ids = positionals;
      if (values.worst !== undefined) {
        let projectId: number | undefined;
        if (values.project) {
          const project = db.prepare('SELECT id FROM projects WHERE root = ?').get(projectRoot(resolve(values.project))) as { id: number } | undefined;
          if (!project) { console.error(`Unknown project: ${values.project}`); process.exitCode = 1; return; }
          projectId = project.id;
        }
        ids = worstSessions(db, Number(values.worst), projectId);
        if (!ids.length) { console.log(values.json ? '[]' : 'No sessions with findings to diagnose.'); return; }
      }
      const showPreview = (p: DiagnosisPreview) => console.log(`Session ${p.sessionId}\nProvider: ${p.agent}${p.model ? ` (${p.model})` : ''}\nCommand: ${p.bin} ${p.args.slice(0, -1).join(' ')} -- <prompt>\nConfirmation hash: ${p.confirmationHash}\n--- exact prompt sent ---\n${p.prompt}\n--- end prompt ---\n`);
      const results: Record<string, unknown>[] = [];
      for (const id of ids) {
        const prepared = prepareDiagnosis(db, id);
        if (values.preview) {
          if (prepared.status === 'error') {
            process.exitCode = 1;
            if (values.json) results.push({ sessionId: id, ...prepared });
            else console.error(`diagnose ${id}: ${prepared.code}: ${prepared.message}`);
          } else if (values.json) results.push({ ...prepared.preview });
          else showPreview(prepared.preview);
          continue;
        }
        const confirm = prepared.status === 'ready' && confirms.includes(prepared.preview.confirmationHash) ? prepared.preview.confirmationHash : undefined;
        const result = await diagnoseSession(db, id, { confirm });
        if (result.status !== 'ok') process.exitCode = 1;
        if (values.json) results.push({ sessionId: id, ...result });
        else if (result.status === 'ok') console.log(`## Session ${id}${result.cached ? ' (cached)' : ''}\n\n${renderDiagnosisMarkdown(result.diagnosis)}\n`);
        else if (result.status === 'confirmation_required') {
          showPreview(result.preview);
          console.error(`diagnose ${id}: confirmation required; review the prompt above, then rerun with --confirm ${result.preview.confirmationHash}`);
        } else console.error(`diagnose ${id}: ${result.code}: ${result.message}`);
      }
      if (values.json) console.log(JSON.stringify(values.worst === undefined ? results[0] : results, null, 2));
    } catch {
      console.error('diagnose failed: check session and settings');
      process.exitCode = 1;
    } finally {
      db.close();
    }
  },
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
    let format: StatuslineFormat = 'default';
    const args = process.argv.slice(3);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--format') {
        const next = args[++i];
        if (next === 'default' || next === 'starship' || next === 'raw') {
          format = next;
        } else {
          console.error('Usage: agentlens statusline [--format default|starship|raw]');
          process.exitCode = 1;
          return;
        }
      } else if (arg.startsWith('--format=')) {
        const val = arg.slice('--format='.length);
        if (val === 'default' || val === 'starship' || val === 'raw') {
          format = val;
        } else {
          console.error('Usage: agentlens statusline [--format default|starship|raw]');
          process.exitCode = 1;
          return;
        }
      }
    }

    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    spoolQuota(SPOOL_PATH, input);
    const out = formatStatusline(SUMMARY_PATH, process.cwd(), format);
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
             WHERE e.kind = 'assistant' AND s.project_id = ? AND e.ts >= ?
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
      const forecasts = computeQuotaForecasts(db);
      for (const q of quotaRows) {
        const agentName = q.agent.charAt(0).toUpperCase() + q.agent.slice(1);
        const minsLeft = Math.max(0, Math.round((q.resetsAt - Date.now()) / 60_000));
        const resetStr = minsLeft >= 60 ? `${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m` : `${minsLeft}m`;
        const f = forecasts.find((x) => x.agent === q.agent && x.window === q.win);
        const forecastStr = f?.willExhaustBeforeReset && f?.message ? ` -- ${f.message}` : '';
        console.log(`  ${agentName} ${q.win}: ${Math.round(q.usedPct)}% (resets in ${resetStr})${forecastStr}`);
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
  optimize: async () => {
    if (process.argv.slice(3).includes('--ai')) {
      try {
        const { values, positionals } = parseArgs({ args: process.argv.slice(3), allowPositionals: true, options: {
          ai: { type: 'boolean' }, preview: { type: 'boolean' }, confirm: { type: 'string' }, apply: { type: 'boolean' }, json: { type: 'boolean' },
        } });
        if (positionals.length > 1 || (values.preview && (values.confirm || values.apply)) || (values.confirm && !/^[a-f0-9]{64}$/.test(values.confirm))) throw Error('Invalid AI optimize options');
        const db = openDb(DB_PATH);
        try {
          const result = await rewriteInstructions(db, positionals[0] ?? process.cwd(), { preview: values.preview, confirm: values.confirm, apply: values.apply });
          if (values.json) console.log(JSON.stringify(result, null, 2));
          else if (result.status === 'confirmation_required') console.log(`Confirmation hash: ${result.preview.confirmationHash}\nCommand: ${result.preview.bin} ${result.preview.args.slice(0, -1).join(' ')} <prompt>\n--- exact prompt sent ---\n${result.preview.prompt}\n--- end prompt ---`);
          else if (result.status === 'error') console.error(result.message);
          else { console.log(result.diff); if (result.status === 'rejected') console.error(`Rejected: ${result.reason}`); else console.log(result.applied ? 'Applied; original saved as .bak.' : 'Preview only; use --apply to write.'); }
          if (result.status === 'error' || result.status === 'rejected' || (result.status === 'confirmation_required' && !values.preview)) process.exitCode = 1;
        } finally { db.close(); }
      } catch (error) { console.error(error instanceof Error ? error.message : 'Invalid AI optimize options'); process.exitCode = 1; }
      return;
    }
    if (process.argv.slice(3).some(arg => arg === '--preview' || arg === '--confirm')) { console.error('AI preview and confirmation require --ai'); process.exitCode = 1; return; }
    let projectArg: string | undefined;
    let apply = false;
    let isJson = false;
    for (let i = 3; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--project' && process.argv[i + 1]) {
        projectArg = process.argv[i + 1];
        i++;
      } else if (arg === '--apply') {
        apply = true;
      } else if (arg === '--dry-run') {
        apply = false;
      } else if (arg === '--json') {
        isJson = true;
      } else if (!arg.startsWith('-') && !projectArg) {
        projectArg = arg;
      }
    }
    const targetPath = projectArg ?? process.cwd();
    const db = openDb(DB_PATH);
    try {
      runAudit(db, HOME);
    } catch {}
    const res = optimizeWorkspace(db, {
      projectRoot: targetPath,
      home: HOME,
      apply,
    });
    if (isJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(formatOptimizeReport(res));
    }
  },
  report: () => {
    let weekArg: string | undefined;
    let isHtml = false;
    let isJson = false;
    for (let i = 3; i < process.argv.length; i++) {
      if (process.argv[i] === '--week' && process.argv[i + 1]) {
        weekArg = process.argv[i + 1];
        i++;
      } else if (process.argv[i] === '--html') {
        isHtml = true;
      } else if (process.argv[i] === '--json') {
        isJson = true;
      }
    }
    const db = openDb(DB_PATH);
    const rep = generateWeeklyReport(db, weekArg, HOME);
    if (isJson) {
      console.log(JSON.stringify(rep.data, null, 2));
    } else if (isHtml) {
      console.log(`Weekly report HTML saved at: ${rep.filePathHtml}`);
    } else {
      console.log(rep.markdown);
    }
  },
  roi: () => {
    const { values } = parseArgs({ args: process.argv.slice(3), options: {
      plan: { type: 'string' }, days: { type: 'string' }, json: { type: 'boolean' },
    } });
    const days = values.days === undefined ? undefined : /^\d+$/.test(values.days) ? Number(values.days) : NaN;
    const db = existsSync(DB_PATH) ? new DatabaseSync(DB_PATH, { readOnly: true }) : openDb(':memory:');
    try {
      const r = subscriptionComparison(db, { plan: values.plan, days });
      if (values.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`${r.title} (${r.plan}, ${r.days} days; ${new Date(r.from).toISOString()} to ${new Date(r.to).toISOString()}, end exclusive)`);
        console.log(`Observed in window: ${r.observedEvents} event${r.observedEvents === 1 ? '' : 's'} across ${r.observedSessions} session${r.observedSessions === 1 ? '' : 's'}`);
        console.log(`First observed: ${r.firstObservedAt == null ? 'n/a' : new Date(r.firstObservedAt).toISOString()}; last observed: ${r.lastObservedAt == null ? 'n/a' : new Date(r.lastObservedAt).toISOString()}`);
        console.log(`Estimated API cost: $${r.estimatedApiCostUsd.toFixed(2)} (priced tokens only; token prices as of ${r.tokenPricesAsOf})`);
        console.log(`Token coverage: ${r.tokenCoverage == null ? 'n/a' : `${(r.tokenCoverage * 100).toFixed(1)}%`} (${r.unpricedTokens} unpriced of ${r.tokens} tokens)`);
        console.log(`US monthly list price: $${r.monthlyPlanPriceUsd}; illustrative ${r.days}/30 reference: $${r.periodPlanPriceUsd.toFixed(2)} (plan prices as of ${r.planPricesAsOf}; ${r.planPriceSource})`);
        console.log(`Estimated API/list-price ratio: ${r.estimatedRatio == null ? 'n/a' : r.estimatedRatio.toFixed(2)}`);
        console.log(r.disclosure);
      }
    } finally { db.close(); }
  },
  savings: () => {
    const { values } = parseArgs({ args: process.argv.slice(3), options: {
      project: { type: 'string' }, weeks: { type: 'string', default: '8' },
      json: { type: 'boolean' }, snapshot: { type: 'boolean' },
    } });
    const weeks = Number(values.weeks);
    if (!Number.isSafeInteger(weeks) || weeks < 1) throw new Error('weeks must be a positive integer');
    if (values.project !== undefined && !values.project.trim()) throw new Error('project must not be empty');
    const db = values.snapshot ? openDb(DB_PATH)
      : existsSync(DB_PATH) ? new DatabaseSync(DB_PATH, { readOnly: true }) : openDb(':memory:');
    try {
      let projectId: number | undefined;
      if (values.project) {
        const project = db.prepare('SELECT id FROM projects WHERE root = ?').get(projectRoot(resolve(values.project))) as { id: number } | undefined;
        if (!project) throw new Error(`Unknown project: ${values.project}`);
        projectId = project.id;
      }
      const report = (values.snapshot ? snapshotSavings : getSavings)(db, { projectId, weeks });
      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      if (!report.projects.length) console.log('No savings data.');
      const label = (week: { weekStart: number; complete: boolean } | null) => week
        ? `${new Date(week.weekStart).toLocaleDateString('sv')}${week.complete ? '' : ' (partial)'}` : 'n/a';
      for (const project of report.projects) {
        console.log(`\n${project.name} (${project.root})`);
        console.log(`  Baseline: ${label(project.baseline)}${project.baselineSource ? ` [${project.baselineSource}]` : ''}`);
        console.log(`  Latest: ${label(project.latest)}`);
        for (const [key, title] of [
          ['tokensPerSession', 'Tokens/session'], ['tokensPerTurn', 'Tokens/turn'],
          ['nonCacheInputShare', 'Non-cache input share'], ['cacheReadRatio', 'Cache-read ratio'], ['sessions', 'Sessions'],
        ] as const) {
          const before = project.baseline?.[key];
          const after = project.latest?.[key];
          const delta = project.changePct?.[key];
          console.log(`  ${title}: ${before ?? 'n/a'} -> ${after ?? 'n/a'} (${delta == null ? 'n/a' : `${delta > 0 ? '+' : ''}${delta}%`})`);
        }
      }
    } finally { db.close(); }
  },
  track: () => {
    let projectArg: string | undefined;
    for (let i = 3; i < process.argv.length; i++) {
      if (process.argv[i] === '--project' && process.argv[i + 1]) {
        projectArg = process.argv[i + 1];
        i++;
      }
    }
    const db = openDb(DB_PATH);
    let projId: number | undefined;
    if (projectArg) {
      const root = projectRoot(projectArg);
      const proj = db.prepare('SELECT id FROM projects WHERE root = ?').get(root) as { id: number } | undefined;
      projId = proj?.id;
    }
    evaluateRecommendations(db);
    const all = getRecommendations(db, { projectId: projId });
    const tracked = all.filter((r) => r.acceptedAt != null || r.status !== 'open');

    console.log(`\n==================================================`);
    console.log(`Improvement Tracking: ${tracked.length} recommendation(s) tracked`);
    console.log(`==================================================\n`);

    if (tracked.length === 0) {
      console.log('No recommendations currently being tracked.');
      console.log("Run 'agentlens accept <id>' to accept a recommendation and begin tracking.\n");
      return;
    }

    for (const r of tracked) {
      const res = r.result;
      const statusBadge = `[${r.status.toUpperCase()}]`;
      console.log(`${statusBadge} ${r.title} (ID: ${r.id})`);
      console.log(`  Rule: ${r.findingRule} | Action: ${r.action}`);
      if (res) {
        const delta = res.deltaPct > 0 ? `+${res.deltaPct}%` : `${res.deltaPct}%`;
        const fmt = (v: number | null | undefined) => v == null ? 'n/a' : v.toLocaleString('en-US');
        console.log(`  Target Metric: ${res.metricName}`);
        console.log(`  Baseline -> Current: ${res.baselineVal} -> ${res.currentVal} (${delta})`);
        console.log(`  Tokens/session (incl. cache writes): ${fmt(res.tokensPerSessionBefore)} -> ${fmt(res.tokensPerSessionAfter)}`);
        console.log(`  Tokens per 1k output: ${fmt(res.tokensPer1kOutputBefore)} -> ${fmt(res.tokensPer1kOutputAfter)}`);
        console.log(`  Samples: ${res.sampleBefore} sessions before, ${res.sampleAfter} sessions after`);
        console.log(`  Guardrails: ${res.guardrails?.passed ? 'PASSED' : 'REGRESSED'} | Verdict: ${res.verdict}`);
      } else {
        console.log(`  Status: ${r.status}`);
      }
      console.log('');
    }
    console.log(`==================================================\n`);
  },
  accept: () => {
    const id = process.argv[3];
    if (!id) {
      console.error('Usage: agentlens accept <recommendation-id>');
      process.exit(1);
    }
    const db = openDb(DB_PATH);
    const ok = updateRecommendationStatus(db, id, 'accepted');
    if (!ok) {
      console.error(`Recommendation not found: ${id}`);
      process.exit(1);
    }
    evaluateRecommendations(db);
    console.log(`Accepted recommendation '${id}'. Improvement tracking initialized for next 14 days.`);
  },
  catalog: () => {
    let jsonMode = false;
    let ruleFilter: string | undefined;
    for (let i = 3; i < process.argv.length; i++) {
      if (process.argv[i] === '--json') jsonMode = true;
      else if (process.argv[i] === '--rule' && process.argv[i + 1]) {
        ruleFilter = process.argv[i + 1];
        i++;
      }
    }
    const all = getCuratedCatalog();
    const items = ruleFilter ? all.filter((i) => i.targetRules.includes(ruleFilter!)) : all;
    if (jsonMode) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    console.log(`\n==================================================`);
    console.log(`agentlens Curated Tool & MCP Catalog`);
    console.log(`==================================================\n`);
    for (const it of items) {
      console.log(`[${it.kind.toUpperCase()}] ${it.name} (~${it.estSavingsPct}% potential savings)`);
      console.log(`  Target Rules: ${it.targetRules.join(', ')}`);
      console.log(`  Description:  ${it.description}`);
      console.log(`  Repository:   ${it.url}`);
      if (it.installCommand) console.log(`  Install:      ${it.installCommand}`);
      console.log('');
    }
    console.log(`==================================================\n`);
  },
  discover: async () => {
    let query: string | undefined;
    let dryRun = false;
    let jsonMode = false;
    let token: string | undefined;

    for (let i = 3; i < process.argv.length; i++) {
      if (process.argv[i] === '--dry-run') dryRun = true;
      else if (process.argv[i] === '--json') jsonMode = true;
      else if (process.argv[i] === '--query' && process.argv[i + 1]) {
        query = process.argv[i + 1];
        i++;
      } else if (process.argv[i] === '--token' && process.argv[i + 1]) {
        token = process.argv[i + 1];
        i++;
      }
    }

    try {
      const res = await discoverGitHubCandidates({ query, dryRun, token });
      if (jsonMode) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(`\n==================================================`);
      console.log(`agentlens Tool Discovery — ${res.source}`);
      console.log(`==================================================\n`);
      if (res.rateLimitRemaining != null) {
        console.log(`GitHub API Rate Limit Remaining: ${res.rateLimitRemaining}\n`);
      }
      if (res.candidates.length === 0) {
        console.log('No new candidates found for query.');
      } else {
        for (const c of res.candidates) {
          console.log(`★ ${c.stars} | [${c.suggestedKind.toUpperCase()}] ${c.fullName}`);
          console.log(`  Description: ${c.description || 'No description provided'}`);
          console.log(`  URL:         ${c.url}`);
          if (c.relevanceRule) console.log(`  Target Waste: ${c.relevanceRule}`);
          console.log('');
        }
      }
      if (dryRun) {
        console.log('(Dry-run mode: candidates not saved to local store)');
      } else {
        console.log(`Saved ${res.candidates.length} candidates to discovery store.`);
      }
      console.log(`==================================================\n`);
    } catch (e) {
      console.error(`Discovery failed: ${(e as Error).message}`);
      process.exit(1);
    }
  },
  'install-statusline': () => {
    console.log(getStatuslineSnippet());
  },
  'install-service': () => {
    const res = installService({
      cliPath: fileURLToPath(import.meta.url),
    });
    if (res.success) {
      console.log(res.message);
    } else {
      console.error(res.message);
      process.exitCode = 1;
    }
  },
  export: () => {
    let format: 'csv' | 'json' = 'json';
    let type: 'sessions' | 'daily' | 'findings' | 'all' | undefined;
    let from: number | undefined;
    let to: number | undefined;
    let projectArg: string | undefined;
    let agentArg: string | undefined;

    for (let i = 3; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--format' && process.argv[i + 1]) {
        const f = process.argv[i + 1].toLowerCase();
        if (f === 'csv' || f === 'json') format = f;
        i++;
      } else if (arg === '--type' && process.argv[i + 1]) {
        const t = process.argv[i + 1].toLowerCase();
        if (t === 'sessions' || t === 'daily' || t === 'findings' || t === 'all') type = t as any;
        i++;
      } else if (arg === '--from' && process.argv[i + 1]) {
        const val = process.argv[i + 1];
        const n = Number(val);
        from = !Number.isNaN(n) && n > 1e11 ? n : Date.parse(val);
        i++;
      } else if (arg === '--to' && process.argv[i + 1]) {
        const val = process.argv[i + 1];
        const n = Number(val);
        to = !Number.isNaN(n) && n > 1e11 ? n : Date.parse(val);
        i++;
      } else if (arg === '--project' && process.argv[i + 1]) {
        projectArg = process.argv[i + 1];
        i++;
      } else if (arg === '--agent' && process.argv[i + 1]) {
        agentArg = process.argv[i + 1];
        i++;
      }
    }

    const db = openDb(DB_PATH);
    let projectId: number | undefined;
    if (projectArg) {
      const root = projectRoot(resolve(projectArg));
      const row = db.prepare('SELECT id FROM projects WHERE root = ? OR name = ?').get(root, projectArg) as { id: number } | undefined;
      projectId = row?.id;
    }

    const output = exportData(db, {
      format,
      type,
      from,
      to,
      projectId,
      agent: agentArg,
    });

    process.stdout.write(output + (output.endsWith('\n') ? '' : '\n'));
  },
  plugin() {
    let action: 'install' | 'status' | 'uninstall' = 'status';
    let enable = false;
    let jsonFlag = false;
    let targetDir: string | undefined;

    for (let i = 3; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === 'install' || arg === 'status' || arg === 'uninstall') {
        action = arg;
      } else if (arg === '--enable') {
        enable = true;
      } else if (arg === '--json') {
        jsonFlag = true;
      } else if (arg === '--dir' && process.argv[i + 1]) {
        targetDir = resolve(process.argv[i + 1]);
        i++;
      }
    }

    if (action === 'install') {
      const res = installOmarchyPlugin({ targetDir, enable });
      if (jsonFlag) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`✓ Installed ${res.pluginId} to ${res.installedDir}`);
        if (res.validationOutput) {
          console.log(`  Validation: ${res.validationOutput}`);
        }
        console.log(`  Enabled in Omarchy bar: ${res.enabled ? 'yes' : 'no (run with --enable or `omarchy plugin enable agentlens.bar-widget`)'}`);
      }
    } else if (action === 'uninstall') {
      const res = uninstallOmarchyPlugin({ targetDir });
      if (jsonFlag) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(res.removed ? `✓ Uninstalled plugin from ${res.installedDir}` : `Plugin not installed at ${res.installedDir}`);
      }
    } else {
      const res = getOmarchyPluginStatus({ targetDir });
      if (jsonFlag) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`Plugin: ${res.pluginId}`);
        console.log(`Installed: ${res.installed ? `yes (${res.installedDir})` : 'no'}`);
        console.log(`Manifest valid: ${res.manifestValid ? 'yes' : 'no'}`);
        console.log(`Enabled in shell.json: ${res.enabledInShellConfig ? 'yes' : 'no'}`);
      }
    }
  },
  cheatsheet: () => {
    let projectArg: string | undefined;
    let topArg: number | undefined;
    let isJson = false;

    for (let i = 3; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--project' && process.argv[i + 1]) {
        projectArg = process.argv[i + 1];
        i++;
      } else if (arg.startsWith('--project=')) {
        projectArg = arg.slice('--project='.length);
      } else if (arg === '--top' && process.argv[i + 1]) {
        topArg = Number(process.argv[i + 1]);
        i++;
      } else if (arg.startsWith('--top=')) {
        topArg = Number(arg.slice('--top='.length));
      } else if (arg === '--json') {
        isJson = true;
      } else if (!arg.startsWith('-') && !projectArg) {
        projectArg = arg;
      }
    }

    const db = existsSync(DB_PATH) ? new DatabaseSync(DB_PATH, { readOnly: true }) : openDb(':memory:');
    try {
      const res = generateCheatsheet(db, { projectRoot: projectArg, top: topArg });
      if (isJson) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(res.markdown);
      }
    } finally {
      db.close();
    }
  },
  help: () => console.log(HELP),
};

export function getStatuslineSnippet(platform: NodeJS.Platform = process.platform): string {
  const command = platform === 'win32' ? 'agentlens.cmd statusline' : 'agentlens statusline';
  const targetPath =
    platform === 'win32'
      ? '%USERPROFILE%\\.claude\\settings.json or project .claude\\settings.json'
      : '~/.claude/settings.json or project .claude/settings.json';
  return `Add this to ${targetPath}:

{
  "statusLine": {
    "command": "${command}"
  }
}
`;
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    const scriptPath = resolve(process.argv[1]);
    const modulePath = fileURLToPath(import.meta.url);
    if (scriptPath === modulePath) return true;
    return existsSync(scriptPath) && realpathSync(scriptPath) === realpathSync(modulePath);
  } catch {
    return false;
  }
}

if (isMain()) {
  const cmd = process.argv[2] ?? 'help';
  const fn = commands[cmd];
  if (!fn) {
    console.error(`agentlens: unknown command "${cmd}"\n\n${HELP}`);
    process.exit(1);
  }
  await fn();
}
