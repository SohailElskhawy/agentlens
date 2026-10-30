import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { DB } from './db.ts';
import type { Finding } from './types.ts';

function within(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function isTempProject(path: string): boolean {
  return isAbsolute(path) && (within(path, '/tmp') || within(path, tmpdir()));
}

export function isAnalystCwd(path: unknown): boolean {
  if (typeof path !== 'string' || !isAbsolute(path)) return false;
  return ['/tmp', tmpdir()].some((root) => {
    const rel = relative(resolve(root), resolve(path));
    const first = rel.split(sep)[0];
    return within(path, root) && (first === 'agentlens-ai' || first.startsWith('agentlens-ai-'));
  });
}

export function tempProjectIds(db: DB): Set<number> {
  const projects = db.prepare('SELECT id, root FROM projects').all() as { id: number; root: string }[];
  return new Set(projects.filter((p) => isTempProject(p.root)).map((p) => p.id));
}

export function excludeTempFindings(db: DB, findings: Finding[]): Finding[] {
  const ids = tempProjectIds(db);
  const sessions = db.prepare('SELECT id, project_id AS projectId, cwd FROM sessions').all() as { id: string; projectId: number | null; cwd: string | null }[];
  const excludedSessions = new Set(sessions.filter((s) => (s.projectId != null && ids.has(s.projectId)) || (s.cwd != null && isTempProject(s.cwd))).map((s) => s.id));
  return findings.filter((f) => (f.projectId == null || !ids.has(f.projectId)) && (f.sessionId == null || !excludedSessions.has(f.sessionId)));
}
