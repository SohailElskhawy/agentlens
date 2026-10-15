import { createServer, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.ts';
import type { Filter } from './types.ts';
import * as q from './queries.ts';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
};
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

function num(sp: URLSearchParams, k: string): number | undefined {
  const v = sp.get(k);
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
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
  };

  const server = createServer((req, res) => {
    // Bound to loopback, but a malicious page could still reach it via DNS rebinding; the Host check stops that.
    if (!LOCAL_HOST.test(req.headers.host ?? '')) return send(res, 403, 'text/plain', 'forbidden host');
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      const handler = api[url.pathname];
      if (handler) return send(res, 200, 'application/json', JSON.stringify(handler(filterOf(url.searchParams), url.searchParams)));
      const file = normalize(join(WEB, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'text/plain', 'not found');
      send(res, 200, TYPES[extname(file)] ?? 'application/octet-stream', readFileSync(file));
    } catch (e) {
      send(res, 500, 'application/json', JSON.stringify({ error: (e as Error).message }));
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
