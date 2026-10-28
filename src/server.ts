import { createServer, type Server, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.ts';
import { getAllSettings, getAuditItems, getFindings, getRecommendations, setSetting, updateRecommendationStatus } from './db.ts';
import type { AuditKind, AuditStatus, Filter } from './types.ts';
import { generateWeeklyReport } from './report.ts';
import { evaluateRecommendations } from './track.ts';
import { getCuratedCatalog } from './catalog.ts';
import { discoverGitHubCandidates, loadDiscoveredCandidates } from './discover.ts';
import { getPlatformPaths } from './paths.ts';
import { generateFixPrompt } from './fix-prompts.ts';
import { runFix } from './fix-runner.ts';
import { exportData, generatePrometheusMetrics } from './export.ts';
import { aiStatus, validAiSetting } from './ai/gate.ts';
import * as q from './queries.ts';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
};
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

function num(sp: URLSearchParams, k: string): number | undefined {
  const v = sp.get(k)?.trim();
  if (v == null || !/^-?\d+$/.test(v)) return undefined; // integers only: SQLite LIMIT rejects 2.5, and hex/blank would coerce oddly
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

const filterOf = (sp: URLSearchParams): Filter => ({ from: num(sp, 'from'), to: num(sp, 'to'), agent: sp.get('agent') || undefined, projectId: num(sp, 'project') });

function send(res: ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

export function startServer(db: DB, port: number, host = '127.0.0.1'): Promise<Server> {
  const api: Record<string, (f: Filter, sp: URLSearchParams) => unknown> = {
    '/api/summary': (f) => q.summary(db, f),
    '/api/daily': (f) => q.daily(db, f),
    '/api/projects': (f) => q.projects(db, f),
    '/api/models': (f) => q.models(db, f),
    '/api/sessions': (f, sp) => q.sessions(db, f, Math.min(Math.max(num(sp, 'limit') ?? 200, 1), 1000)),
    '/api/session': (_f, sp) => q.sessionDetail(db, sp.get('id') ?? ''),
    '/api/session/timeline': (_f, sp) => q.sessionTimeline(db, sp.get('id') ?? ''),
    '/api/quota': (f) => q.quota(db, f),
    '/api/outcomes': (f) => q.outcomeEfficiency(db, f),
    '/api/health': () => q.health(db),
    '/api/findings': (f, sp) => {
      const rule = sp.get('rule') || undefined;
      const findings = getFindings(db, { projectId: f.projectId, rule });
      const totalEstWeeklySavings = findings.reduce((sum, item) => sum + (item.estTokensWeek || 0), 0);
      return { findings, totalEstWeeklySavings };
    },
    '/api/recommendations': (f, sp) => {
      const status = sp.get('status') || undefined;
      const recs = getRecommendations(db, { projectId: f.projectId, status });
      return { recommendations: recs };
    },
    '/api/audit': (f, sp) => {
      const kind = (sp.get('kind') || undefined) as AuditKind | undefined;
      const status = (sp.get('status') || undefined) as AuditStatus | undefined;
      const includeGlobal = sp.get('includeGlobal') !== 'false';
      const items = getAuditItems(db, {
        projectId: f.projectId,
        includeGlobal: f.projectId != null ? includeGlobal : undefined,
        agent: f.agent,
        kind,
        status,
      });
      const totalFixedTokens = items
        .filter((i) => i.kind === 'instruction' && !i.details?.isDoc)
        .reduce((sum, i) => sum + (i.tokens || 0), 0);
      const unusedCount = items.filter((i) => i.status === 'unused').length;
      const duplicateCount = items.filter((i) => i.status === 'duplicate').length;
      const conflictCount = items.filter((i) => i.status === 'conflict').length;
      const trimmings = items
        .filter((i) => i.kind === 'instruction' && i.details?.trimming)
        .map((i) => i.details.trimming);
      const totalTrimSavings = trimmings.reduce((sum: number, t: any) => sum + (t.tokensSaved || 0), 0);
      return {
        items,
        trimmings,
        summary: {
          totalItems: items.length,
          totalFixedTokens,
          unusedCount,
          duplicateCount,
          conflictCount,
          totalTrimSavings,
        },
      };
    },
    '/api/reports': () => {
      const reportsDir = getPlatformPaths().reportsDir;
      const reports: Array<{ week: string; filePathMd: string; filePathHtml: string; generatedAt: number }> = [];
      if (existsSync(reportsDir)) {
        const files = readdirSync(reportsDir);
        for (const f of files) {
          if (f.endsWith('.md')) {
            const week = f.replace(/\.md$/, '');
            const filePathMd = join(reportsDir, f);
            const filePathHtml = join(reportsDir, `${week}.html`);
            try {
              const st = statSync(filePathMd);
              reports.push({
                week,
                filePathMd,
                filePathHtml,
                generatedAt: Math.round(st.mtimeMs),
              });
            } catch {}
          }
        }
      }
      reports.sort((a, b) => b.week.localeCompare(a.week));
      return { reports };
    },
    '/api/tracking': (f) => {
      evaluateRecommendations(db);
      const all = getRecommendations(db, { projectId: f.projectId });
      const items = all.filter((r) => r.acceptedAt != null || r.status !== 'open');
      return { items };
    },
    '/api/catalog': () => ({ catalog: getCuratedCatalog() }),
    '/api/candidates': () => ({ candidates: loadDiscoveredCandidates(process.env.AGENTLENS_SOURCE_HOME || homedir()) }),
    '/api/settings': () => ({ settings: getAllSettings(db) }),
    '/api/ai/status': () => aiStatus(db),
  };

  const server = createServer((req, res) => {
    // Bound to loopback, but a malicious page could still reach it via DNS rebinding; the Host check stops that.
    if (!LOCAL_HOST.test(req.headers.host ?? '')) return send(res, 403, 'text/plain', 'forbidden host');
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return send(res, 400, 'text/plain', 'bad request'); // e.g. `GET //` is an invalid URL; must not escape the listener
    }
    try {
      if (req.method === 'GET' && url.pathname === '/api/export.csv') {
        const type = (url.searchParams.get('type') || 'sessions') as 'sessions' | 'daily' | 'findings';
        const from = num(url.searchParams, 'from');
        const to = num(url.searchParams, 'to');
        const projectId = num(url.searchParams, 'project');
        const agent = url.searchParams.get('agent') || undefined;

        const csvContent = exportData(db, {
          format: 'csv',
          type,
          from,
          to,
          projectId,
          agent,
        });

        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="agentlens-${type}.csv"`,
          'cache-control': 'no-store',
        });
        res.end(csvContent);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/metrics') {
        const metrics = generatePrometheusMetrics(db);
        return send(res, 200, 'text/plain; version=0.0.4; charset=utf-8', metrics);
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/recommendations/') && url.pathname.endsWith('/status')) {
        const parts = url.pathname.split('/');
        let id: string;
        try {
          id = decodeURIComponent(parts.slice(3, parts.length - 1).join('/'));
        } catch {
          return send(res, 400, 'application/json', JSON.stringify({ error: 'invalid id encoding' }));
        }

        let body = '';
        let tooLarge = false;
        req.on('data', (c) => {
          if (tooLarge) return;
          body += c;
          if (body.length > 16384) {
            tooLarge = true;
            req.resume();
            send(res, 413, 'application/json', JSON.stringify({ error: 'payload too large' }));
          }
        });
        req.on('end', () => {
          if (tooLarge) return;
          try {
            const json = JSON.parse(body);
            const VALID_STATUSES = new Set(['open', 'accepted', 'measuring', 'verified', 'no_effect', 'regressed', 'dismissed']);
            if (!VALID_STATUSES.has(json.status)) {
              return send(res, 400, 'application/json', JSON.stringify({ error: 'invalid status' }));
            }
            const ok = updateRecommendationStatus(db, id, json.status);
            if (!ok) {
              return send(res, 404, 'application/json', JSON.stringify({ error: 'recommendation not found', id }));
            }
            send(res, 200, 'application/json', JSON.stringify({ ok: true, id, status: json.status }));
          } catch {
            send(res, 400, 'application/json', JSON.stringify({ error: 'invalid payload' }));
          }
        });
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/recommendations/') && url.pathname.endsWith('/accept')) {
        const parts = url.pathname.split('/');
        let id: string;
        try {
          id = decodeURIComponent(parts.slice(3, parts.length - 1).join('/'));
        } catch {
          return send(res, 400, 'application/json', JSON.stringify({ error: 'invalid id encoding' }));
        }
        const now = Date.now();
        const ok = updateRecommendationStatus(db, id, 'accepted');
        if (!ok) {
          return send(res, 404, 'application/json', JSON.stringify({ error: 'recommendation not found', id }));
        }
        evaluateRecommendations(db, now);
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, id, status: 'accepted', acceptedAt: now }));
      }

      if (req.method === 'POST' && url.pathname === '/api/reports/generate') {
        let body = '';
        let tooLarge = false;
        req.on('data', (c) => {
          if (tooLarge) return;
          body += c;
          if (body.length > 16384) {
            tooLarge = true;
            req.resume();
            send(res, 413, 'application/json', JSON.stringify({ error: 'payload too large' }));
          }
        });
        req.on('end', () => {
          if (tooLarge) return;
          let week: string | undefined;
          try {
            if (body.trim()) {
              const parsed = JSON.parse(body);
              week = parsed.week;
            }
          } catch {}
          try {
            const rep = generateWeeklyReport(db, week, process.env.AGENTLENS_SOURCE_HOME || homedir());
            send(res, 200, 'application/json', JSON.stringify({
              ok: true,
              week: rep.data.week,
              filePathMd: rep.filePathMd,
              filePathHtml: rep.filePathHtml,
              filePathJson: rep.filePathJson,
            }));
          } catch (e) {
            send(res, 500, 'application/json', JSON.stringify({ error: (e as Error).message }));
          }
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/discover') {
        let body = '';
        let tooLarge = false;
        req.on('data', (c) => {
          if (tooLarge) return;
          body += c;
          if (body.length > 16384) {
            tooLarge = true;
            req.resume();
            send(res, 413, 'application/json', JSON.stringify({ error: 'payload too large' }));
          }
        });
        req.on('end', async () => {
          if (tooLarge) return;
          let opts: any = {};
          try {
            if (body.trim()) opts = JSON.parse(body);
          } catch {}
          try {
            const resData = await discoverGitHubCandidates({
              query: opts.query,
              token: opts.token,
              limit: opts.limit,
              home: process.env.AGENTLENS_SOURCE_HOME || homedir(),
            });
            send(res, 200, 'application/json', JSON.stringify({
              ok: true,
              candidates: resData.candidates,
              count: resData.candidates.length,
              source: resData.source,
              rateLimitRemaining: resData.rateLimitRemaining,
            }));
          } catch (e) {
            send(res, 400, 'application/json', JSON.stringify({ error: (e as Error).message }));
          }
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/settings') {
        let body = '';
        let tooLarge = false;
        req.on('data', (c) => {
          if (tooLarge) return;
          body += c;
          if (body.length > 16384) {
            tooLarge = true;
            req.resume();
            send(res, 413, 'application/json', JSON.stringify({ error: 'payload too large' }));
          }
        });
        req.on('end', () => {
          if (tooLarge) return;
          try {
            const json = JSON.parse(body || '{}');
            if (typeof json.key === 'string' && json.key.startsWith('ai_')
              && (typeof json.value !== 'string' || !validAiSetting(json.key, json.value))) {
              return send(res, 400, 'application/json', JSON.stringify({ error: 'invalid AI setting' }));
            }
            if (json.key && typeof json.value === 'string') {
              setSetting(db, json.key, json.value);
            } else if (typeof json.allowAgentLaunch === 'boolean') {
              setSetting(db, 'allow_agent_launch', json.allowAgentLaunch ? 'true' : 'false');
            }
            send(res, 200, 'application/json', JSON.stringify({ ok: true, settings: getAllSettings(db) }));
          } catch {
            send(res, 400, 'application/json', JSON.stringify({ error: 'invalid payload' }));
          }
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/fix/prompt') {
        let body = '';
        let tooLarge = false;
        req.on('data', (c) => {
          if (tooLarge) return;
          body += c;
          if (body.length > 16384) {
            tooLarge = true;
            req.resume();
            send(res, 413, 'application/json', JSON.stringify({ error: 'payload too large' }));
          }
        });
        req.on('end', () => {
          if (tooLarge) return;
          try {
            const json = JSON.parse(body || '{}');
            const prompt = generateFixPrompt(json);
            send(res, 200, 'application/json', JSON.stringify({ ok: true, prompt }));
          } catch (e: any) {
            send(res, 400, 'application/json', JSON.stringify({ error: e.message || 'invalid payload' }));
          }
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/fix/run') {
        let body = '';
        let tooLarge = false;
        req.on('data', (c) => {
          if (tooLarge) return;
          body += c;
          if (body.length > 16384) {
            tooLarge = true;
            req.resume();
            send(res, 413, 'application/json', JSON.stringify({ error: 'payload too large' }));
          }
        });
        req.on('end', async () => {
          if (tooLarge) return;
          try {
            const json = JSON.parse(body || '{}');
            const { agent, prompt, projectId, recommendationId, headless } = json;
            if (!agent || !prompt || projectId == null) {
              return send(res, 400, 'application/json', JSON.stringify({ error: 'Missing required fields: agent, prompt, projectId' }));
            }
            const proj = db.prepare('SELECT id, root FROM projects WHERE id = ?').get(projectId) as { id: number; root: string } | undefined;
            if (!proj) {
              return send(res, 400, 'application/json', JSON.stringify({ error: 'Unknown project' }));
            }
            const result = await runFix(db, {
              agent,
              prompt,
              projectId,
              projectPath: proj.root,
              headless: Boolean(headless),
            });
            if (recommendationId) {
              updateRecommendationStatus(db, recommendationId, 'accepted');
              evaluateRecommendations(db);
            }
            send(res, 200, 'application/json', JSON.stringify(result));
          } catch (e: any) {
            const msg = e.message || String(e);
            const status = msg.includes('Permission denied') ? 403 : msg.includes('currently in progress') ? 429 : 400;
            send(res, status, 'application/json', JSON.stringify({ error: msg }));
          }
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/project/budget') {
        let body = '';
        let tooLarge = false;
        req.on('data', (c) => {
          if (tooLarge) return;
          body += c;
          if (body.length > 16384) {
            tooLarge = true;
            req.resume();
            send(res, 413, 'application/json', JSON.stringify({ error: 'payload too large' }));
          }
        });
        req.on('end', () => {
          if (tooLarge) return;
          try {
            const json = JSON.parse(body || '{}');
            const { projectId, budgetTokens, budgetCost } = json;
            if (projectId == null) {
              return send(res, 400, 'application/json', JSON.stringify({ error: 'Missing projectId' }));
            }
            if (budgetTokens != null && Number(budgetTokens) > 0) {
              setSetting(db, `budget_tokens_${projectId}`, String(budgetTokens));
            } else if (budgetTokens === 0 || budgetTokens === null) {
              db.prepare('DELETE FROM settings WHERE key = ?').run(`budget_tokens_${projectId}`);
            }
            if (budgetCost != null && Number(budgetCost) > 0) {
              setSetting(db, `budget_cost_${projectId}`, String(budgetCost));
            } else if (budgetCost === 0 || budgetCost === null) {
              db.prepare('DELETE FROM settings WHERE key = ?').run(`budget_cost_${projectId}`);
            }
            send(res, 200, 'application/json', JSON.stringify({ ok: true, projectId }));
          } catch {
            send(res, 400, 'application/json', JSON.stringify({ error: 'invalid payload' }));
          }
        });
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/reports/')) {
        const week = url.pathname.slice('/api/reports/'.length);
        if (/^\d{4}-W\d{1,2}$/.test(week)) {
          try {
            const reportsDir = getPlatformPaths().reportsDir;
            const filePathMd = join(reportsDir, `${week}.md`);
            const filePathHtml = join(reportsDir, `${week}.html`);
            const filePathJson = join(reportsDir, `${week}.json`);
            if (existsSync(filePathJson) && existsSync(filePathMd) && existsSync(filePathHtml)) {
              try {
                const data = JSON.parse(readFileSync(filePathJson, 'utf8'));
                return send(res, 200, 'application/json', JSON.stringify({
                  data,
                  markdown: readFileSync(filePathMd, 'utf8'),
                  html: readFileSync(filePathHtml, 'utf8'),
                }));
              } catch {}
            }
            const rep = generateWeeklyReport(db, week);
            return send(res, 200, 'application/json', JSON.stringify({
              data: rep.data,
              markdown: rep.markdown,
              html: rep.html,
            }));
          } catch (e) {
            return send(res, 404, 'application/json', JSON.stringify({ error: (e as Error).message }));
          }
        }
      }

      const handler = api[url.pathname];
      if (handler) return send(res, 200, 'application/json', JSON.stringify(handler(filterOf(url.searchParams), url.searchParams)));
      const file = normalize(join(WEB, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'text/plain', 'not found');
      send(res, 200, TYPES[extname(file)] ?? 'application/octet-stream', readFileSync(file));
    } catch (e) {
      send(res, 500, 'application/json', JSON.stringify({ error: (e as Error).message }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
