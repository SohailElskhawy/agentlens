import { createServer, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.ts';
import { getAuditItems, getFindings, getRecommendations, updateRecommendationStatus } from './db.ts';
import type { AuditKind, AuditStatus, Filter } from './types.ts';
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
    '/api/quota': (f) => q.quota(db, f),
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
      return {
        items,
        summary: {
          totalItems: items.length,
          totalFixedTokens,
          unusedCount,
          duplicateCount,
          conflictCount,
        },
      };
    },
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
          body += c;
          if (body.length > 16384) {
            tooLarge = true;
            req.destroy();
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
