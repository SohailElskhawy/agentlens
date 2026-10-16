import { execFileSync } from 'node:child_process';
import type { DB } from '../db.ts';
import type { Finding } from '../types.ts';
import { OUTCOME_EFFICIENCY_TOKENS_PER_COMMIT, OUTCOME_EFFICIENCY_TOKENS_PER_LINE } from './constants.ts';

export interface GitCommitStat {
  hash: string;
  ts: number; // ms
  added: number;
  deleted: number;
}

export function readGitNumstat(cwd: string, sinceDays = 30): GitCommitStat[] {
  try {
    const stdout = execFileSync(
      'git',
      ['log', '--numstat', '--format=commit %H %ct', '-n', '100', `--since=${sinceDays} days ago`],
      {
        cwd,
        encoding: 'utf-8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );

    const commits: GitCommitStat[] = [];
    let currentCommit: GitCommitStat | null = null;

    const lines = stdout.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('commit ')) {
        const parts = trimmed.split(' ');
        const hash = parts[1];
        const epochSec = Number.parseInt(parts[2], 10);
        if (hash && !Number.isNaN(epochSec)) {
          currentCommit = {
            hash,
            ts: epochSec * 1000,
            added: 0,
            deleted: 0,
          };
          commits.push(currentCommit);
        }
        continue;
      }

      if (currentCommit) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          const added = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10) || 0;
          const deleted = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10) || 0;
          currentCommit.added += added;
          currentCommit.deleted += deleted;
        }
      }
    }

    return commits;
  } catch {
    return [];
  }
}

export function detectOutcomeEfficiency(
  db: DB,
  options?: { projectId?: number; gitReader?: typeof readGitNumstat }
): Finding[] {
  const gitReader = options?.gitReader ?? readGitNumstat;
  let sql = 'SELECT id, name, root FROM projects WHERE 1 = 1';
  const params: any[] = [];
  if (options?.projectId != null) {
    sql += ' AND id = ?';
    params.push(options.projectId);
  }

  const projects = db.prepare(sql).all(...params) as Array<{ id: number; name: string; root: string }>;
  const findings: Finding[] = [];

  for (const proj of projects) {
    // 1. Gather all sessions and tokens in project
    const sessionRows = db.prepare(`
      SELECT s.id, s.agent,
             min(e.ts) AS started,
             max(e.ts) AS ended,
             sum(e.input + e.output + e.cache_read + e.cache_write) AS tokens
      FROM sessions s
      JOIN events e ON e.session_id = s.id
      WHERE s.project_id = ?
      GROUP BY s.id
    `).all(proj.id) as Array<{ id: string; agent: string; started: number; ended: number; tokens: number }>;

    if (sessionRows.length === 0) continue;

    const totalTokens = sessionRows.reduce((acc, s) => acc + (s.tokens || 0), 0);
    if (totalTokens < 50_000) continue; // Only evaluate projects with meaningful token spend

    // 2. Read git commits
    const commits = gitReader(proj.root);
    if (commits.length === 0) continue; // Skip if not a git repo or no recent commits

    // 3. Attribute commits to sessions
    // A commit is attributed to a session if its timestamp is between [started - 1min, ended + 10min]
    let attributedCommits = 0;
    let attributedLinesChanged = 0;

    for (const commit of commits) {
      const isAttributed = sessionRows.some(
        (s) => commit.ts >= s.started - 60_000 && commit.ts <= s.ended + 600_000
      );
      if (isAttributed) {
        attributedCommits++;
        attributedLinesChanged += commit.added + commit.deleted;
      }
    }

    // Fall back to all recent repo commits if strict time attribution yielded 0 (e.g. commits pushed afterwards)
    const effectiveCommits = attributedCommits > 0 ? attributedCommits : commits.length;
    const effectiveLines = attributedLinesChanged > 0
      ? attributedLinesChanged
      : commits.reduce((acc, c) => acc + c.added + c.deleted, 0);

    const tokensPerCommit = Math.round(totalTokens / Math.max(1, effectiveCommits));
    const tokensPerChangedLine = Math.round(totalTokens / Math.max(1, effectiveLines));

    const isInefficient =
      tokensPerCommit >= OUTCOME_EFFICIENCY_TOKENS_PER_COMMIT ||
      tokensPerChangedLine >= OUTCOME_EFFICIENCY_TOKENS_PER_LINE;

    if (isInefficient) {
      const confidence = tokensPerCommit >= 250_000 || tokensPerChangedLine >= 1000 ? 'high' : 'medium';
      findings.push({
        id: `outcome_efficiency:${proj.id}`,
        rule: 'outcome_efficiency',
        projectId: proj.id,
        sessionId: null,
        evidence: {
          projectId: proj.id,
          projectName: proj.name,
          totalTokens,
          commitsCount: effectiveCommits,
          linesChanged: effectiveLines,
          tokensPerCommit,
          tokensPerChangedLine,
        },
        confidence,
        confidenceReason: `${proj.name} averaged ${tokensPerCommit.toLocaleString()} tokens per commit (${tokensPerChangedLine} tokens/changed line), indicating low outcome efficiency.`,
        estTokensWeek: Math.round(totalTokens * 0.25),
        firstSeen: Date.now() - 7 * 86400_000,
        lastSeen: Date.now(),
      });
    }
  }

  return findings;
}
