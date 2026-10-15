# agentlens M1 — Usage Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working, always-on local dashboard of measured token usage, estimated API cost and Codex quota for Claude Code and Codex, per project, ingested incrementally from the agents' own log files.

**Architecture:** One Node process (`agentlens serve`) incrementally reads agent JSONL logs through per-agent adapters into SQLite (`node:sqlite`), and serves a JSON API plus a vanilla-JS dashboard on 127.0.0.1. A systemd user unit keeps it running from login. Adapters normalize every agent into one event shape; queries compute cost at read time from a bundled price snapshot.

**Tech Stack:** Node ≥ 22.18 running `.ts` directly (type stripping), `node:sqlite`, `node:http`, `node:test`, `fs.watch`; uPlot 1.6.32 (vendored) for charts; dev-only `typescript` for `tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-10-16-agentlens-design.md` (this plan implements milestone M1; M2–M6 get their own plans).

## Global Constraints

- Node `>=22.18`, `"type": "module"`, `.ts` executed directly: **erasable TypeScript only**. No `enum`, `namespace` or constructor parameter properties. Relative imports end in `.ts`. Type-only imports use `import type`.
- Zero runtime npm dependencies. Dev dependencies are only `typescript@5.9.3` and `@types/node@24.10.1`.
- Read-only toward agent data: never write under `~/.claude`, `~/.codex`, `~/.config/opencode` or `~/.gemini`.
- Prompt and tool text is never stored. Store only `sha256` truncated to 16 hex chars, plus the length.
- The dashboard binds `127.0.0.1` only and rejects any `Host` header other than `127.0.0.1[:port]` or `localhost[:port]`.
- No network at runtime. Prices are a bundled snapshot that only the dev script `scripts/update-prices.ts` refreshes.
- UI labels, verbatim: `Tokens (measured)`, `API-equivalent cost (estimated)`, `Quota used (reported by agent)`. Missing quota shows `n/a`, never an estimate. Unpriced models show `unpriced`, never `$0.00`.
- Paths: data `$XDG_DATA_HOME/agentlens` (default `~/.local/share/agentlens`), DB `agentlens.db` inside it. Overrides: `AGENTLENS_DATA_DIR`, `AGENTLENS_SOURCE_HOME` (home to read agent logs from), `AGENTLENS_PORT` (default `4711`).
- Token accounting:
  - `input` = **uncached** input. Codex `input_tokens` includes `cached_input_tokens`, so subtract it.
  - `tokens` = `input + output + cacheRead + cacheWrite`.
  - `reasoning` is an informational subset of `output`.
  - `cacheWrite1h` is the subset of `cacheWrite` billed at the 1-hour rate.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The agent is mid-write (partial trailing JSONL line).** The line must not be consumed, and the cursor must stop before it so the next read gets it whole. Pinned in Task 1.
2. **A log file shrinks or is replaced.** Re-read it from offset 0 with no double counting. Pinned in Task 7.
3. **A malformed line in the middle of a file.** Skip it, count it in `errors`, and ingest every other line. Pinned in Task 5.
4. **A session `cwd` that was deleted or isn't a git repo.** The project root is the cwd itself, with no crash. Pinned in Task 3.
5. **A model missing from the price table** (`codex-auto-review`, `<synthetic>`, router models). Its tokens are counted in `unpricedTokens` and excluded from cost, never priced at $0. Pinned in Task 8.

Plus one security case: static-file path traversal (`/../src/db.ts`, `/%2e%2e/package.json`) must return 404. Pinned in Task 9.

## File Structure

```
package.json, tsconfig.json, .gitignore, LICENSE, README.md
src/types.ts              # shared types: NormalizedEvent, SessionInfo, QuotaSnapshot, Cursor, ReadResult, Adapter, Filter
src/util.ts               # hash()
src/jsonl.ts              # readLines(): chunked, offset-based JSONL reader
src/db.ts                 # schema + all writes (upserts, cursors, projects, quotas, tx)
src/project.ts            # cwd -> project root (git repo; worktree -> main repo)
src/pricing.ts            # priceFor(), costOf()
src/prices.json           # generated price snapshot (LiteLLM subset)
src/adapters/claude.ts    # Claude Code JSONL -> normalized
src/adapters/codex.ts     # Codex rollout JSONL -> normalized
src/ingest.ts             # discover -> diff cursors -> read -> write, yielding between files
src/queries.ts            # all read queries for the API
src/server.ts             # http server: /api/* + static web/
src/cli.ts                # serve | ingest | install-service | help
scripts/update-prices.ts  # dev-only price snapshot refresh
web/index.html, web/app.js, web/style.css, web/vendor/uPlot.iife.min.js, web/vendor/uPlot.min.css
test/helpers.ts + test/*.test.ts
```

---

### Task 1: Project scaffold, shared types, JSONL reader

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, `src/types.ts`, `src/util.ts`, `src/jsonl.ts`, `test/helpers.ts`
- Test: `test/jsonl.test.ts`

**Interfaces:**
- Produces: every type in `src/types.ts` (exact definitions below); `hash(s: string): string`; `readLines(path: string, offset: number, onLine: (line: string) => void, chunkSize?: number): number`; test helpers `tmp()`, `put()`, `jsonl()`, `cAssistant()`, `cUser()`.

- [ ] **Step 1: Write scaffold files**

`package.json`:
```json
{
  "name": "agentlens",
  "version": "0.1.0",
  "description": "Local-first, read-only usage and workflow optimizer for AI coding agents",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22.18" },
  "bin": { "agentlens": "src/cli.ts" },
  "scripts": {
    "test": "node --no-warnings=ExperimentalWarning --test \"test/**/*.test.ts\"",
    "typecheck": "tsc",
    "start": "node --no-warnings=ExperimentalWarning src/cli.ts serve",
    "update-prices": "node scripts/update-prices.ts"
  },
  "devDependencies": { "typescript": "5.9.3", "@types/node": "24.10.1" }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test", "scripts"]
}
```

`.gitignore`:
```
node_modules/
*.db
*.db-shm
*.db-wal
```

`LICENSE`: the standard MIT license text with `Copyright (c) 2026 agentlens contributors`.

`src/types.ts`:
```ts
export type Agent = 'claude' | 'codex' | 'opencode' | 'antigravity';
export type EventKind = 'user' | 'assistant' | 'tool_call' | 'tool_result';

export interface NormalizedEvent {
  id: string;            // globally unique; re-ingesting the same id merges (per-field MAX) instead of duplicating
  agent: Agent;
  sessionId: string;
  ts: number;            // epoch ms
  kind: EventKind;
  model?: string;
  input?: number;        // uncached input tokens
  output?: number;       // output tokens, reasoning included
  cacheRead?: number;
  cacheWrite?: number;   // all cache writes
  cacheWrite1h?: number; // subset of cacheWrite billed at the 1-hour rate
  reasoning?: number;    // informational subset of output
  tool?: string;
  argsHash?: string;
  resultBytes?: number;
  isError?: boolean;
  textHash?: string;     // prompt text is never stored, only hash + length
  textLen?: number;
}

export interface SessionInfo { id: string; agent: Agent; cwd?: string; parentId?: string }

export interface QuotaSnapshot {
  agent: Agent;
  ts: number;
  window: '5h' | '7d';
  usedPct: number;
  resetsAt: number;      // epoch ms
  source: string;
}

export interface Cursor { offset: number; state: Record<string, string> }

export interface ReadResult {
  events: NormalizedEvent[];
  sessions: SessionInfo[];
  quotas: QuotaSnapshot[];
  cursor: Cursor;
  errors: number;        // lines that failed to parse and were skipped
}

export interface Adapter {
  agent: Agent;
  root(home: string): string;          // directory to watch
  discover(root: string): string[];    // absolute file paths to ingest
  read(path: string, cursor: Cursor): ReadResult;
}

export interface Filter { from?: number; to?: number; agent?: string; projectId?: number }
```

`src/util.ts`:
```ts
import { createHash } from 'node:crypto';

export const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
```

`test/helpers.ts`:
```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const tmp = () => mkdtempSync(join(tmpdir(), 'agentlens-'));

export function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

export const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

let n = 0;
export const cAssistant = (o: { msg: string; req?: string; session?: string; cwd?: string; ts?: string; out?: number; model?: string; content?: unknown[] }) => ({
  type: 'assistant', uuid: `ua${n++}`, sessionId: o.session ?? 's1', cwd: o.cwd ?? '/tmp/agentlens-proj',
  timestamp: o.ts ?? '2026-10-15T10:00:00.000Z', requestId: o.req ?? 'r1', isSidechain: false,
  message: {
    id: o.msg, model: o.model ?? 'claude-opus-5-5', role: 'assistant', content: o.content ?? [{ type: 'text', text: 'ok' }],
    usage: {
      input_tokens: 2, output_tokens: o.out ?? 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 50 }, output_tokens_details: { thinking_tokens: 3 },
    },
  },
});

export const cUser = (o: { uuid: string; content: unknown; session?: string; cwd?: string; ts?: string }) => ({
  type: 'user', uuid: o.uuid, sessionId: o.session ?? 's1', cwd: o.cwd ?? '/tmp/agentlens-proj',
  timestamp: o.ts ?? '2026-10-15T10:00:01.000Z', isSidechain: false, message: { role: 'user', content: o.content },
});
```

- [ ] **Step 2: Install dev deps**

Run: `npm install`
Expected: `node_modules/` with typescript and @types/node, `package-lock.json` created.

- [ ] **Step 3: Write the failing test**

`test/jsonl.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readLines } from '../src/jsonl.ts';
import { tmp, put } from './helpers.ts';

test('readLines stops before a partial trailing line and resumes from it', () => {
  const p = put(join(tmp(), 'a.jsonl'), '{"a":1}\n{"a":2}\n{"a":');
  const got: string[] = [];
  const off = readLines(p, 0, (l) => got.push(l));
  assert.deepEqual(got, ['{"a":1}', '{"a":2}']);
  assert.equal(off, 16);
  appendFileSync(p, '3}\n');
  const more: string[] = [];
  const off2 = readLines(p, off, (l) => more.push(l));
  assert.deepEqual(more, ['{"a":3}']);
  assert.equal(off2, statSync(p).size);
});

test('readLines handles lines longer than the chunk size and multibyte text across chunks', () => {
  const p = put(join(tmp(), 'b.jsonl'), '{"t":"héllo wörld"}\n\n{"t":"x"}\n');
  const got: string[] = [];
  const off = readLines(p, 0, (l) => got.push(l), 5);
  assert.deepEqual(got, ['{"t":"héllo wörld"}', '{"t":"x"}']);
  assert.equal(off, statSync(p).size);
});

test('readLines from the end of the file reads nothing', () => {
  const p = put(join(tmp(), 'c.jsonl'), '{"a":1}\n');
  const got: string[] = [];
  assert.equal(readLines(p, 8, (l) => got.push(l)), 8);
  assert.deepEqual(got, []);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../src/jsonl.ts'`.

- [ ] **Step 5: Implement `src/jsonl.ts`**

```ts
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * Calls onLine for each complete, non-empty line after `offset` and returns the offset just past the last
 * complete line. A trailing line without '\n' is left unread: the agent may still be writing it.
 * Reads in chunks so a large log never has to fit in memory at once.
 */
export function readLines(path: string, offset: number, onLine: (line: string) => void, chunkSize = 4 * 1024 * 1024): number {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(chunkSize);
    let pos = offset;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const n = readSync(fd, buf, 0, chunkSize, pos);
      if (n === 0) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      let nl: number;
      while ((nl = data.indexOf(10, start)) !== -1) {
        const line = data.toString('utf8', start, nl);
        if (line.trim()) onLine(line);
        start = nl + 1;
      }
      carry = Buffer.from(data.subarray(start)); // copy: `buf` is reused next iteration
    }
    return pos - carry.length;
  } finally {
    closeSync(fd);
  }
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: 3 tests PASS, tsc exits 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore LICENSE src/types.ts src/util.ts src/jsonl.ts test/helpers.ts test/jsonl.test.ts
git commit -m "feat: project scaffold, shared types, incremental JSONL reader

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: SQLite storage layer

**Files:**
- Create: `src/db.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: types from `src/types.ts`.
- Produces: `type DB = DatabaseSync`; `openDb(path: string): DB`; `tx<T>(db: DB, fn: () => T): T`; `upsertEvents(db: DB, events: NormalizedEvent[]): void`; `upsertSessions(db: DB, sessions: (SessionInfo & { projectId: number | null })[]): void`; `upsertProject(db: DB, root: string, name: string): number`; `insertQuotas(db: DB, quotas: QuotaSnapshot[]): void`; `getCursor(db: DB, path: string): Cursor | undefined`; `setCursor(db: DB, path: string, agent: string, cursor: Cursor, errors: number): void`.
- Tables (column names later tasks query): `cursors(path, agent, byte_offset, state, errors, updated_at)`, `projects(id, root, name)`, `sessions(id, agent, project_id, cwd, parent_id)`, `events(id, agent, session_id, ts, kind, model, input, output, cache_read, cache_write, cache_write_1h, reasoning, tool, args_hash, result_bytes, is_error, text_hash, text_len)`, `quota_snapshots(agent, ts, win, used_pct, resets_at, source)`. Session start/end times are derived from `events`, not stored.

- [ ] **Step 1: Write the failing test**

`test/db.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertEvents, upsertSessions, upsertProject, insertQuotas, getCursor, setCursor, tx } from '../src/db.ts';
import type { NormalizedEvent } from '../src/types.ts';

test('upsertEvents merges repeated ids with per-field MAX (streamed Claude usage lines)', () => {
  const db = openDb(':memory:');
  const e: NormalizedEvent = { id: 'claude:m1:r1', agent: 'claude', sessionId: 's1', ts: 1, kind: 'assistant', model: 'm', input: 2, output: 10 };
  upsertEvents(db, [e, { ...e, output: 50 }, { ...e, output: 30 }]);
  assert.deepEqual({ ...db.prepare('SELECT count(*) AS n, max(output) AS o, max(input) AS i FROM events').get() }, { n: 1, o: 50, i: 2 });
});

test('upsertProject is idempotent and returns a stable id', () => {
  const db = openDb(':memory:');
  const a = upsertProject(db, '/r/app', 'app');
  assert.equal(upsertProject(db, '/r/app', 'app'), a);
  assert.notEqual(upsertProject(db, '/r/other', 'other'), a);
});

test('upsertSessions keeps the first cwd and project', () => {
  const db = openDb(':memory:');
  const p = upsertProject(db, '/r/app', 'app');
  upsertSessions(db, [{ id: 's1', agent: 'codex', cwd: '/r/app', projectId: p }]);
  upsertSessions(db, [{ id: 's1', agent: 'codex', cwd: '/elsewhere', projectId: null }]);
  assert.deepEqual({ ...db.prepare('SELECT cwd, project_id AS p FROM sessions').get() }, { cwd: '/r/app', p });
});

test('insertQuotas ignores exact duplicates', () => {
  const db = openDb(':memory:');
  const q = { agent: 'codex' as const, ts: 5, window: '5h' as const, usedPct: 12, resetsAt: 9, source: 'codex-log' };
  insertQuotas(db, [q, q]);
  assert.equal((db.prepare('SELECT count(*) AS n FROM quota_snapshots').get() as { n: number }).n, 1);
});

test('cursors round-trip state and accumulate errors', () => {
  const db = openDb(':memory:');
  assert.equal(getCursor(db, '/f'), undefined);
  setCursor(db, '/f', 'codex', { offset: 10, state: { model: 'gpt' } }, 1);
  setCursor(db, '/f', 'codex', { offset: 20, state: { model: 'gpt2' } }, 2);
  assert.deepEqual(getCursor(db, '/f'), { offset: 20, state: { model: 'gpt2' } });
  assert.equal((db.prepare('SELECT errors FROM cursors').get() as { errors: number }).errors, 3);
});

test('tx rolls back on error', () => {
  const db = openDb(':memory:');
  assert.throws(() => tx(db, () => { upsertProject(db, '/x', 'x'); throw new Error('boom'); }));
  assert.equal((db.prepare('SELECT count(*) AS n FROM projects').get() as { n: number }).n, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/db.test.ts`
Expected: FAIL — `Cannot find module '.../src/db.ts'`.

- [ ] **Step 3: Implement `src/db.ts`**

```ts
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Cursor, NormalizedEvent, QuotaSnapshot, SessionInfo } from './types.ts';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursors (
  path TEXT PRIMARY KEY, agent TEXT NOT NULL, byte_offset INTEGER NOT NULL, state TEXT NOT NULL DEFAULT '{}',
  errors INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, root TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, project_id INTEGER REFERENCES projects(id), cwd TEXT, parent_id TEXT);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, model TEXT,
  input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0, cache_write_1h INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
  tool TEXT, args_hash TEXT, result_bytes INTEGER, is_error INTEGER, text_hash TEXT, text_len INTEGER);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, ts);
CREATE TABLE IF NOT EXISTS quota_snapshots (
  agent TEXT NOT NULL, ts INTEGER NOT NULL, win TEXT NOT NULL, used_pct REAL NOT NULL, resets_at INTEGER NOT NULL,
  source TEXT NOT NULL, PRIMARY KEY (agent, win, ts));
`;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// node:sqlite rejects undefined bindings, so every optional field becomes null or 0.
export function upsertEvents(db: DB, events: NormalizedEvent[]) {
  const st = db.prepare(`
    INSERT INTO events (id, agent, session_id, ts, kind, model, input, output, cache_read, cache_write, cache_write_1h,
      reasoning, tool, args_hash, result_bytes, is_error, text_hash, text_len)
    VALUES ($id, $agent, $session, $ts, $kind, $model, $input, $output, $cacheRead, $cacheWrite, $cacheWrite1h,
      $reasoning, $tool, $argsHash, $resultBytes, $isError, $textHash, $textLen)
    ON CONFLICT(id) DO UPDATE SET
      input = max(input, excluded.input), output = max(output, excluded.output),
      cache_read = max(cache_read, excluded.cache_read), cache_write = max(cache_write, excluded.cache_write),
      cache_write_1h = max(cache_write_1h, excluded.cache_write_1h), reasoning = max(reasoning, excluded.reasoning)`);
  for (const e of events) {
    st.run({
      id: e.id, agent: e.agent, session: e.sessionId, ts: e.ts, kind: e.kind, model: e.model ?? null,
      input: e.input ?? 0, output: e.output ?? 0, cacheRead: e.cacheRead ?? 0, cacheWrite: e.cacheWrite ?? 0,
      cacheWrite1h: e.cacheWrite1h ?? 0, reasoning: e.reasoning ?? 0, tool: e.tool ?? null, argsHash: e.argsHash ?? null,
      resultBytes: e.resultBytes ?? null, isError: e.isError == null ? null : e.isError ? 1 : 0,
      textHash: e.textHash ?? null, textLen: e.textLen ?? null,
    });
  }
}

export function upsertSessions(db: DB, sessions: (SessionInfo & { projectId: number | null })[]) {
  const st = db.prepare(`
    INSERT INTO sessions (id, agent, project_id, cwd, parent_id) VALUES ($id, $agent, $projectId, $cwd, $parentId)
    ON CONFLICT(id) DO UPDATE SET project_id = coalesce(project_id, excluded.project_id),
      cwd = coalesce(cwd, excluded.cwd), parent_id = coalesce(parent_id, excluded.parent_id)`);
  for (const s of sessions) st.run({ id: s.id, agent: s.agent, projectId: s.projectId, cwd: s.cwd ?? null, parentId: s.parentId ?? null });
}

export function upsertProject(db: DB, root: string, name: string): number {
  db.prepare('INSERT INTO projects (root, name) VALUES (?, ?) ON CONFLICT(root) DO NOTHING').run(root, name);
  return (db.prepare('SELECT id FROM projects WHERE root = ?').get(root) as { id: number }).id;
}

export function insertQuotas(db: DB, quotas: QuotaSnapshot[]) {
  const st = db.prepare(`INSERT OR IGNORE INTO quota_snapshots (agent, ts, win, used_pct, resets_at, source)
    VALUES ($agent, $ts, $win, $usedPct, $resetsAt, $source)`);
  for (const q of quotas) st.run({ agent: q.agent, ts: q.ts, win: q.window, usedPct: q.usedPct, resetsAt: q.resetsAt, source: q.source });
}

export function getCursor(db: DB, path: string): Cursor | undefined {
  const r = db.prepare('SELECT byte_offset, state FROM cursors WHERE path = ?').get(path) as { byte_offset: number; state: string } | undefined;
  return r && { offset: r.byte_offset, state: JSON.parse(r.state) };
}

export function setCursor(db: DB, path: string, agent: string, cursor: Cursor, errors: number) {
  db.prepare(`INSERT INTO cursors (path, agent, byte_offset, state, errors, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET byte_offset = excluded.byte_offset, state = excluded.state,
      errors = errors + excluded.errors, updated_at = excluded.updated_at`)
    .run(path, agent, cursor.offset, JSON.stringify(cursor.state), errors, Date.now());
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS (jsonl + 6 db tests), tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts test/db.test.ts
git commit -m "feat: SQLite storage layer with idempotent upserts and cursors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Project resolution

**Files:**
- Create: `src/project.ts`
- Test: `test/project.test.ts`

**Interfaces:**
- Produces: `projectRoot(cwd: string): string`; `projectName(root: string): string`.

- [ ] **Step 1: Write the failing test**

`test/project.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, projectName } from '../src/project.ts';
import { tmp, put } from './helpers.ts';

test('a subdirectory of a repo maps to the repo root', () => {
  const repo = join(tmp(), 'app');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'src/deep'), { recursive: true });
  assert.equal(projectRoot(join(repo, 'src/deep')), repo);
  assert.equal(projectName(repo), 'app');
});

test('a git worktree maps to its main repository', () => {
  const base = tmp();
  const main = join(base, 'main');
  put(join(main, '.git/worktrees/feat/commondir'), '../..\n');
  const wt = join(base, 'wt-feat');
  put(join(wt, '.git'), `gitdir: ${join(main, '.git/worktrees/feat')}\n`);
  assert.equal(projectRoot(wt), main);
});

test('a directory outside any repo, or one that no longer exists, is its own project', () => {
  const plain = tmp();
  assert.equal(projectRoot(plain), plain);
  const gone = join(tmp(), 'deleted/long/ago');
  assert.equal(projectRoot(gone), gone);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/project.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/project.ts`**

```ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const cache = new Map<string, string>();

/**
 * Maps a working directory to its project root: the enclosing git repo (a worktree maps to its main repo),
 * or the directory itself when it is not inside a repo or no longer exists.
 */
export function projectRoot(cwd: string): string {
  const hit = cache.get(cwd);
  if (hit) return hit;
  let root = cwd;
  for (let dir = cwd; ; dir = dirname(dir)) {
    const git = join(dir, '.git');
    if (existsSync(git)) {
      root = statSync(git).isFile() ? (worktreeMain(git) ?? dir) : dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  cache.set(cwd, root);
  return root;
}

// A worktree's .git file holds "gitdir: <main>/.git/worktrees/<name>"; that dir's "commondir" points back to <main>/.git.
function worktreeMain(gitFile: string): string | undefined {
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitFile, 'utf8'));
  if (!m) return;
  const gitdir = resolve(dirname(gitFile), m[1].trim());
  const commonFile = join(gitdir, 'commondir');
  const common = existsSync(commonFile) ? resolve(gitdir, readFileSync(commonFile, 'utf8').trim()) : gitdir;
  return basename(common) === '.git' ? dirname(common) : undefined;
}

export const projectName = (root: string) => basename(root) || root;
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/project.ts test/project.test.ts
git commit -m "feat: resolve session cwd to git project root (worktree-aware)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Pricing and the bundled price snapshot

**Files:**
- Create: `src/pricing.ts`, `scripts/update-prices.ts`, `src/prices.json` (generated)
- Test: `test/pricing.test.ts`

**Interfaces:**
- Produces: `interface Usage { input; output; cacheRead; cacheWrite; cacheWrite1h }` (all `number`); `type Price = Usage` (USD per token); `priceFor(model: string | null | undefined, models?: Record<string, Price>): Price | undefined`; `costOf(model: string | null | undefined, u: Usage, models?: Record<string, Price>): number | null`; `PRICES_AS_OF: string`.

- [ ] **Step 1: Write the dev-only snapshot script**

`scripts/update-prices.ts`:
```ts
// Dev-time only: refreshes src/prices.json from LiteLLM's public price table (the source ccusage uses).
// agentlens never fetches prices at runtime.
import { writeFileSync } from 'node:fs';

const SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const KEEP = /^(claude-|gpt-|o[134]|codex|gemini-|deepseek|glm-|kimi-|qwen)/;

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`fetch ${SOURCE}: ${res.status}`);
const raw = (await res.json()) as Record<string, any>;
const models: Record<string, unknown> = {};
for (const [id, m] of Object.entries(raw)) {
  if (!KEEP.test(id) || !['chat', 'responses'].includes(m.mode) || m.input_cost_per_token == null) continue;
  const cacheWrite = m.cache_creation_input_token_cost ?? m.input_cost_per_token;
  models[id] = {
    input: m.input_cost_per_token,
    output: m.output_cost_per_token ?? 0,
    cacheRead: m.cache_read_input_token_cost ?? m.input_cost_per_token,
    cacheWrite,
    cacheWrite1h: m.cache_creation_input_token_cost_above_1hr ?? cacheWrite,
  };
}
const out = { asOf: new Date().toISOString().slice(0, 10), source: SOURCE, models };
writeFileSync(new URL('../src/prices.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${Object.keys(models).length} models`);
```

- [ ] **Step 2: Generate the snapshot**

Run: `npm run update-prices && jq '.models["claude-opus-5-5"], .models["gpt-6.1-sol"]' src/prices.json`
Expected: `wrote N models` with N > 50. Both objects are printed with numeric `input`/`output`. At the time of planning, LiteLLM lists `claude-opus-5-5` input `0.000004`, output `0.00002` and cacheWrite1h `0.000008`.

- [ ] **Step 3: Write the failing test**

`test/pricing.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, costOf, PRICES_AS_OF } from '../src/pricing.ts';

const M = { 'claude-x': { input: 1e-6, output: 2e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6, cacheWrite1h: 2e-6 } };

test('priceFor falls back from provider prefix and date suffix', () => {
  assert.equal(priceFor('claude-x', M), M['claude-x']);
  assert.equal(priceFor('anthropic/claude-x', M), M['claude-x']);
  assert.equal(priceFor('claude-x-20251001', M), M['claude-x']);
  assert.equal(priceFor('nope', M), undefined);
  assert.equal(priceFor(undefined, M), undefined);
});

test('costOf prices 5-minute and 1-hour cache writes separately', () => {
  const c = costOf('claude-x', { input: 1000, output: 100, cacheRead: 10000, cacheWrite: 400, cacheWrite1h: 300 }, M);
  // 1000*1e-6 + 100*2e-6 + 10000*1e-7 + 100*1.25e-6 + 300*2e-6
  assert.ok(Math.abs(c! - 0.002925) < 1e-12);
});

test('costOf returns null (not 0) for an unknown model', () => {
  assert.equal(costOf('codex-auto-review', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, M), null);
});

test('bundled snapshot covers the models this user runs', () => {
  assert.match(PRICES_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'gpt-6.1-sol', 'gpt-6-luna']) assert.ok(priceFor(m), m);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --no-warnings --test test/pricing.test.ts`
Expected: FAIL — module `src/pricing.ts` not found.

- [ ] **Step 5: Implement `src/pricing.ts`**

```ts
import { readFileSync } from 'node:fs';

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }
export type Price = Usage; // USD per token, per field

const file = JSON.parse(readFileSync(new URL('./prices.json', import.meta.url), 'utf8')) as { asOf: string; models: Record<string, Price> };
export const PRICES_AS_OF = file.asOf;

/** Exact model id, then without a provider prefix ("openai/gpt-x"), then without a date suffix ("-20251001"). */
export function priceFor(model: string | null | undefined, models = file.models): Price | undefined {
  if (!model) return;
  const bare = model.replace(/^[\w.-]+\//, '');
  return models[model] ?? models[bare] ?? models[bare.replace(/-\d{8}$/, '')];
}

/** Estimated API-equivalent cost in USD, or null when the model has no known price. */
export function costOf(model: string | null | undefined, u: Usage, models = file.models): number | null {
  const p = priceFor(model, models);
  if (!p) return null;
  return u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead
    + (u.cacheWrite - u.cacheWrite1h) * p.cacheWrite + u.cacheWrite1h * p.cacheWrite1h;
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. If the snapshot test fails for one model, check `jq '.models | keys[]' src/prices.json | grep <family>`. If LiteLLM lacks that model, remove it from the test list: it will show as unpriced, which is correct behavior.

- [ ] **Step 7: Commit**

```bash
git add src/pricing.ts src/prices.json scripts/update-prices.ts test/pricing.test.ts
git commit -m "feat: cost estimation from bundled LiteLLM price snapshot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Claude Code adapter

**Files:**
- Create: `src/adapters/claude.ts`
- Test: `test/claude.test.ts`

**Interfaces:**
- Consumes: `readLines` (Task 1), `hash` (Task 1), types.
- Produces: `export const claude: Adapter`.

Facts about real Claude Code logs (verified on this machine):
- Files: `~/.claude/projects/<slug>/<sessionId>.jsonl` and `~/.claude/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl`.
- Each assistant **content block** is written as its own line, and every one of those lines repeats `message.usage`. `output_tokens` can differ between them while the response streams. Emit one `assistant` event per line with id `claude:<message.id>:<requestId>`: the DB's MAX-upsert collapses them, and the same id dedupes history copied into resumed sessions.
- Subagent records carry `isSidechain: true` and `agentId`. Their `sessionId` is the **parent's** id.
- Record types other than `user`/`assistant` (`attachment`, `ai-title`, `file-history-*`, …) are ignored.
- The 1-hour cache-write subset is `usage.cache_creation.ephemeral_1h_input_tokens`. Thinking tokens are `usage.output_tokens_details.thinking_tokens`.

- [ ] **Step 1: Write the failing test**

`test/claude.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { claude } from '../src/adapters/claude.ts';
import { tmp, put, jsonl, cAssistant, cUser } from './helpers.ts';

function fixture() {
  const home = tmp();
  const file = put(join(home, '.claude/projects/-p/s1.jsonl'),
    jsonl(
      cUser({ uuid: 'u1', content: 'secret prompt text' }),
      cAssistant({ msg: 'm1', out: 10, content: [{ type: 'thinking', thinking: '' }] }),
      cAssistant({ msg: 'm1', out: 50, content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] }),
      cUser({ uuid: 'u2', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello', is_error: false }] }),
      { type: 'attachment', sessionId: 's1' },
    )
    + '{not json\n'
    + jsonl({ ...cAssistant({ msg: 'm9', req: 'r9', session: 's1' }), isSidechain: true, agentId: 'a1' }));
  return { home, file };
}

test('claude adapter normalizes usage, tools, prompts and subagents', () => {
  const { file } = fixture();
  const r = claude.read(file, { offset: 0, state: {} });
  const of = (k: string) => r.events.filter((e) => e.kind === k);

  const m1 = of('assistant').filter((e) => e.id === 'claude:m1:r1');
  assert.equal(m1.length, 2, 'one event per streamed line; the DB merges them');
  assert.deepEqual(
    { model: m1[1].model, input: m1[1].input, output: m1[1].output, cacheRead: m1[1].cacheRead, cacheWrite: m1[1].cacheWrite, cacheWrite1h: m1[1].cacheWrite1h, reasoning: m1[1].reasoning },
    { model: 'claude-opus-5-5', input: 2, output: 50, cacheRead: 100, cacheWrite: 50, cacheWrite1h: 50, reasoning: 3 },
  );

  const [call] = of('tool_call');
  assert.equal(call.id, 'claude:toolu_1');
  assert.equal(call.tool, 'Bash');
  assert.match(call.argsHash!, /^[0-9a-f]{16}$/);

  const [result] = of('tool_result');
  assert.deepEqual({ id: result.id, bytes: result.resultBytes, err: result.isError }, { id: 'claude:toolu_1:result', bytes: 5, err: false });

  const [prompt] = of('user');
  assert.equal(prompt.textLen, 18);
  assert.match(prompt.textHash!, /^[0-9a-f]{16}$/);

  const sub = r.events.find((e) => e.id === 'claude:m9:r9');
  assert.equal(sub?.sessionId, 'a1');
  assert.deepEqual(r.sessions.map((s) => [s.id, s.parentId]), [['s1', undefined], ['a1', 's1']]);
});

test('a malformed line is counted and skipped; the rest of the file still ingests', () => {
  const { file } = fixture();
  const r = claude.read(file, { offset: 0, state: {} });
  assert.equal(r.errors, 1);
  assert.ok(r.events.some((e) => e.id === 'claude:m9:r9'), 'line after the bad one was read');
  assert.equal(r.cursor.offset, statSync(file).size);
});

test('prompt and tool text never leave the adapter', () => {
  const { file } = fixture();
  const out = JSON.stringify(claude.read(file, { offset: 0, state: {} }));
  assert.ok(!out.includes('secret prompt'));
  assert.ok(!out.includes('hello'));
});

test('discover finds main session files and subagent files', () => {
  const { home, file } = fixture();
  const sub = put(join(home, '.claude/projects/-p/s1/subagents/agent-a1.jsonl'), '');
  assert.deepEqual(claude.discover(claude.root(home)).sort(), [file, sub].sort());
  assert.deepEqual(claude.discover(join(home, 'missing')), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/claude.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/adapters/claude.ts`**

```ts
import { existsSync, globSync } from 'node:fs';
import { join } from 'node:path';
import { readLines } from '../jsonl.ts';
import { hash } from '../util.ts';
import type { Adapter, NormalizedEvent, SessionInfo } from '../types.ts';

export const claude: Adapter = {
  agent: 'claude',
  root: (home) => join(process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'projects'),
  discover: (root) => existsSync(root)
    ? [...globSync('*/*.jsonl', { cwd: root }), ...globSync('*/*/subagents/*.jsonl', { cwd: root })].map((p) => join(root, p))
    : [],

  read(path, cursor) {
    const events: NormalizedEvent[] = [];
    const sessions = new Map<string, SessionInfo>();
    let errors = 0;

    const offset = readLines(path, cursor.offset, (line) => {
      let r: any;
      try { r = JSON.parse(line); } catch { errors++; return; }
      if (r.type !== 'user' && r.type !== 'assistant') return;
      // Subagent records keep the parent's id in sessionId and their own in agentId.
      const sub = r.isSidechain && r.agentId;
      const sessionId: string | undefined = sub ? r.agentId : r.sessionId;
      const ts = Date.parse(r.timestamp);
      if (!sessionId || Number.isNaN(ts)) return;
      if (!sessions.has(sessionId)) sessions.set(sessionId, { id: sessionId, agent: 'claude', cwd: r.cwd, parentId: sub ? r.sessionId : undefined });

      const base = { agent: 'claude' as const, sessionId, ts };
      const content = r.message?.content;

      if (r.type === 'assistant') {
        const u = r.message?.usage;
        if (u && r.message.id) {
          events.push({
            ...base, id: `claude:${r.message.id}:${r.requestId ?? ''}`, kind: 'assistant', model: r.message.model,
            input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0, cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
            reasoning: u.output_tokens_details?.thinking_tokens ?? 0,
          });
        }
        for (const b of Array.isArray(content) ? content : []) {
          if (b.type === 'tool_use') events.push({ ...base, id: `claude:${b.id}`, kind: 'tool_call', tool: b.name, argsHash: hash(JSON.stringify(b.input ?? {})) });
        }
        return;
      }

      if (!r.uuid) return;
      if (typeof content === 'string') {
        events.push({ ...base, id: `claude:${r.uuid}`, kind: 'user', textHash: hash(content), textLen: content.length });
        return;
      }
      if (!Array.isArray(content)) return;
      const text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      if (text) events.push({ ...base, id: `claude:${r.uuid}`, kind: 'user', textHash: hash(text), textLen: text.length });
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
        events.push({ ...base, id: `claude:${b.tool_use_id}:result`, kind: 'tool_result', resultBytes: Buffer.byteLength(body), isError: !!b.is_error });
      }
    });

    return { events, sessions: [...sessions.values()], quotas: [], cursor: { offset, state: {} }, errors };
  },
};
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/claude.ts test/claude.test.ts
git commit -m "feat: Claude Code log adapter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Codex adapter

**Files:**
- Create: `src/adapters/codex.ts`
- Test: `test/codex.test.ts`

**Interfaces:**
- Consumes: `readLines`, `hash`, types.
- Produces: `export const codex: Adapter`.

Facts about real Codex rollouts (verified on this machine):
- Files: `~/.codex/sessions/YYYY/MM/DD/rollout-<datetime>-<uuid>.jsonl`. Every line is `{ timestamp, type, payload }`.
- `session_meta.payload.cwd` gives the cwd. `turn_context.payload.model` gives the model for the turns that follow.
- `event_msg` with `payload.type === 'token_count'`:
  - `payload.info` may be `null`.
  - `info.last_token_usage` holds that turn's usage. Its `input_tokens` **includes** `cached_input_tokens`.
  - `info.total_token_usage.total_tokens` is cumulative per session. It makes a unique, stable per-turn id.
  - `payload.rate_limits.primary` / `.secondary` each have `used_percent`, `window_minutes` (300 → `5h`, 10080 → `7d`) and `resets_at` (epoch **seconds**).
- `event_msg` with `payload.type === 'user_message'` carries `payload.message` (the prompt text).
- `response_item` payload types `function_call` / `custom_tool_call` have `name`, `call_id` and `arguments`/`input`. Their outputs `function_call_output` / `custom_tool_call_output` have `call_id` and `output` (a string or an array).
- Incremental reads start mid-file, so session id comes from the **file name**, and `model`/`cwd` are carried in `cursor.state`.

- [ ] **Step 1: Write the failing test**

`test/codex.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { codex } from '../src/adapters/codex.ts';
import { tmp, put, jsonl } from './helpers.ts';

const ID = '01a14053-9cd4-7a63-8d1d-89bf3480152f';
const t = (s: number) => `2026-10-15T10:00:${String(s).padStart(2, '0')}.000Z`;
const usage = { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 1050 };
const head = [
  { timestamp: t(0), type: 'session_meta', payload: { id: ID, cwd: '/work/app' } },
  { timestamp: t(1), type: 'turn_context', payload: { model: 'gpt-6.1-sol', cwd: '/work/app' } },
];
const rest = [
  { timestamp: t(2), type: 'event_msg', payload: { type: 'user_message', message: 'secret codex prompt' } },
  { timestamp: t(3), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: null } },
  { timestamp: t(4), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"cmd":"ls"}' } },
  { timestamp: t(5), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'abc' } },
  { timestamp: t(6), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'x' } },
  { timestamp: t(7), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: [{ type: 'input_text', text: 'ok' }] } },
  { timestamp: t(8), type: 'event_msg', payload: {
    type: 'token_count',
    info: { total_token_usage: usage, last_token_usage: usage },
    rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1792098588 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1792650545 } },
  } },
];

test('codex adapter: incremental read keeps model and cwd, subtracts cached input, records quota', () => {
  const home = tmp();
  const file = put(join(home, `.codex/sessions/2026/10/15/rollout-2026-10-15T10-00-00-${ID}.jsonl`), jsonl(...head));
  const first = codex.read(file, { offset: 0, state: {} });
  appendFileSync(file, jsonl(...rest));
  const r = codex.read(file, first.cursor);

  const turn = r.events.find((e) => e.kind === 'assistant')!;
  assert.deepEqual(
    { id: turn.id, sessionId: turn.sessionId, model: turn.model, input: turn.input, cacheRead: turn.cacheRead, output: turn.output, reasoning: turn.reasoning },
    { id: `codex:${ID}:1050`, sessionId: ID, model: 'gpt-6.1-sol', input: 400, cacheRead: 600, output: 50, reasoning: 20 },
  );
  assert.deepEqual(r.sessions, [{ id: ID, agent: 'codex', cwd: '/work/app' }]);
  assert.deepEqual(r.quotas.map((q) => [q.window, q.usedPct, q.resetsAt, q.ts]), [
    ['5h', 12.5, 1792098588000, Date.parse(t(8))],
    ['7d', 40, 1792650545000, Date.parse(t(8))],
  ]);
  assert.deepEqual(r.events.filter((e) => e.kind === 'tool_call').map((e) => [e.id, e.tool]), [['codex:c1', 'shell'], ['codex:c2', 'exec']]);
  assert.deepEqual(r.events.filter((e) => e.kind === 'tool_result').map((e) => [e.id, e.resultBytes]), [
    ['codex:c1:result', 3],
    ['codex:c2:result', Buffer.byteLength(JSON.stringify([{ type: 'input_text', text: 'ok' }]))],
  ]);
  assert.equal(r.events.filter((e) => e.kind === 'user').length, 1);
  assert.ok(!JSON.stringify(r).includes('secret codex prompt'));
});

test('codex discover walks the dated session tree', () => {
  const home = tmp();
  const f = put(join(home, `.codex/sessions/2026/10/15/rollout-x-${ID}.jsonl`), '');
  put(join(home, '.codex/sessions/2026/10/15/notes.txt'), '');
  assert.deepEqual(codex.discover(codex.root(home)), [f]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/codex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/adapters/codex.ts`**

```ts
import { existsSync, globSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readLines } from '../jsonl.ts';
import { hash } from '../util.ts';
import type { Adapter, NormalizedEvent, QuotaSnapshot } from '../types.ts';

const WINDOWS: Record<number, '5h' | '7d'> = { 300: '5h', 10080: '7d' };

export const codex: Adapter = {
  agent: 'codex',
  root: (home) => join(process.env.CODEX_HOME ?? join(home, '.codex'), 'sessions'),
  discover: (root) => existsSync(root) ? globSync('**/rollout-*.jsonl', { cwd: root }).map((p) => join(root, p)) : [],

  read(path, cursor) {
    // The id is in the file name, so a read that starts mid-file still knows its session.
    // ponytail: forked rollouts that copy history could double count; the M2 ccusage cross-check will flag drift.
    const sessionId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path)?.[1] ?? basename(path);
    const state = { ...cursor.state }; // { model, cwd } carried across incremental reads
    const events: NormalizedEvent[] = [];
    const quotas: QuotaSnapshot[] = [];
    let errors = 0;

    const offset = readLines(path, cursor.offset, (line) => {
      let r: any;
      try { r = JSON.parse(line); } catch { errors++; return; }
      const p = r.payload ?? {};
      const ts = Date.parse(r.timestamp);
      if (Number.isNaN(ts)) return;
      const base = { agent: 'codex' as const, sessionId, ts };

      if (r.type === 'session_meta' || r.type === 'turn_context') {
        if (p.cwd) state.cwd ??= p.cwd;
        if (p.model) state.model = p.model;
      } else if (r.type === 'event_msg' && p.type === 'token_count') {
        const u = p.info?.last_token_usage;
        const total = p.info?.total_token_usage?.total_tokens;
        if (u && total != null) {
          const cached = u.cached_input_tokens ?? 0;
          events.push({
            ...base, id: `codex:${sessionId}:${total}`, kind: 'assistant', model: state.model,
            input: Math.max(0, (u.input_tokens ?? 0) - cached), output: u.output_tokens ?? 0, cacheRead: cached,
            cacheWrite: u.cache_write_input_tokens ?? 0, reasoning: u.reasoning_output_tokens ?? 0,
          });
        }
        for (const w of [p.rate_limits?.primary, p.rate_limits?.secondary]) {
          const window = WINDOWS[w?.window_minutes];
          if (window && typeof w.used_percent === 'number') {
            quotas.push({ agent: 'codex', ts, window, usedPct: w.used_percent, resetsAt: (w.resets_at ?? 0) * 1000, source: 'codex-log' });
          }
        }
      } else if (r.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
        events.push({ ...base, id: `codex:${sessionId}:user:${ts}`, kind: 'user', textHash: hash(p.message), textLen: p.message.length });
      } else if (r.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
        events.push({ ...base, id: `codex:${p.call_id}`, kind: 'tool_call', tool: p.name, argsHash: hash(String(p.arguments ?? p.input ?? '')) });
      } else if (r.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
        const body = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
        events.push({ ...base, id: `codex:${p.call_id}:result`, kind: 'tool_result', resultBytes: Buffer.byteLength(body) });
      }
    });

    return { events, sessions: [{ id: sessionId, agent: 'codex', cwd: state.cwd }], quotas, cursor: { offset, state }, errors };
  },
};
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/codex.ts test/codex.test.ts
git commit -m "feat: Codex rollout adapter with quota snapshots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Ingest pipeline

**Files:**
- Create: `src/ingest.ts`
- Test: `test/ingest.test.ts`

**Interfaces:**
- Consumes: `claude`, `codex` adapters; `tx`, `getCursor`, `setCursor`, `upsertEvents`, `upsertSessions`, `upsertProject`, `insertQuotas` from `db.ts`; `projectRoot`, `projectName`.
- Produces: `ADAPTERS: Adapter[]`; `interface IngestStats { files: number; read: number; events: number; errors: number }`; `ingest(db: DB, home: string, adapters?: Adapter[]): Promise<IngestStats>`.

- [ ] **Step 1: Write the failing test**

`test/ingest.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.ts';
import { ingest } from '../src/ingest.ts';
import { claude } from '../src/adapters/claude.ts';
import { tmp, put, jsonl, cAssistant } from './helpers.ts';

const totals = (db: DB) => ({ ...db.prepare(`SELECT count(*) AS n, sum(output) AS out FROM events WHERE kind = 'assistant'`).get() });

test('ingest is incremental, merges streamed duplicates, and survives a file shrinking', async () => {
  const home = tmp();
  const repo = join(home, 'code/app');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const file = put(join(home, '.claude/projects/-code-app/s1.jsonl'), jsonl(
    cAssistant({ msg: 'm1', out: 10, cwd: repo }),
    cAssistant({ msg: 'm1', out: 40, cwd: repo }),
    cAssistant({ msg: 'm2', req: 'r2', out: 5, cwd: repo }),
  ));
  const db = openDb(':memory:');

  let s = await ingest(db, home, [claude]);
  assert.equal(s.read, 1);
  assert.deepEqual(totals(db), { n: 2, out: 45 });

  s = await ingest(db, home, [claude]);
  assert.equal(s.read, 0, 'unchanged file is skipped');

  appendFileSync(file, jsonl(cAssistant({ msg: 'm3', req: 'r3', out: 1, cwd: repo })));
  await ingest(db, home, [claude]);
  assert.deepEqual(totals(db), { n: 3, out: 46 });

  writeFileSync(file, jsonl(cAssistant({ msg: 'm1', out: 40, cwd: repo }))); // shrank: re-read from 0
  await ingest(db, home, [claude]);
  assert.deepEqual(totals(db), { n: 3, out: 46 }, 'no double counting after a re-read');

  const p = db.prepare('SELECT p.root, p.name FROM sessions s JOIN projects p ON p.id = s.project_id').get() as { root: string; name: string };
  assert.deepEqual({ ...p }, { root: repo, name: 'app' });
});

test('a file that vanishes between discover and read does not stop the others', async () => {
  const home = tmp();
  const good = put(join(home, 'good.jsonl'), jsonl(cAssistant({ msg: 'ok' })));
  const broken = { ...claude, root: () => home, discover: () => [join(home, 'missing.jsonl'), good] };
  const s = await ingest(openDb(':memory:'), home, [broken]);
  assert.equal(s.read, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/ingest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/ingest.ts`**

```ts
import { statSync } from 'node:fs';
import { claude } from './adapters/claude.ts';
import { codex } from './adapters/codex.ts';
import { type DB, getCursor, insertQuotas, setCursor, tx, upsertEvents, upsertProject, upsertSessions } from './db.ts';
import { projectName, projectRoot } from './project.ts';
import type { Adapter, Cursor, ReadResult } from './types.ts';

export const ADAPTERS: Adapter[] = [claude, codex];

export interface IngestStats { files: number; read: number; events: number; errors: number }

/**
 * Reads only what was appended since the last run (a file that shrank is re-read from 0; upserts keep that
 * idempotent). Yields to the event loop between files so the dashboard stays responsive during the first backfill.
 */
export async function ingest(db: DB, home: string, adapters = ADAPTERS): Promise<IngestStats> {
  const stats: IngestStats = { files: 0, read: 0, events: 0, errors: 0 };
  for (const a of adapters) {
    for (const path of a.discover(a.root(home))) {
      stats.files++;
      let size: number;
      try { size = statSync(path).size; } catch { continue; } // deleted between discover and read
      let cursor: Cursor = getCursor(db, path) ?? { offset: 0, state: {} };
      if (size === cursor.offset) continue;
      if (size < cursor.offset) cursor = { offset: 0, state: {} };

      let r: ReadResult;
      try { r = a.read(path, cursor); } catch (e) {
        console.error(`agentlens: could not read ${path}: ${(e as Error).message}`);
        stats.errors++;
        continue;
      }
      tx(db, () => {
        upsertEvents(db, r.events);
        upsertSessions(db, r.sessions.map((s) => {
          const root = s.cwd ? projectRoot(s.cwd) : undefined;
          return { ...s, projectId: root ? upsertProject(db, root, projectName(root)) : null };
        }));
        insertQuotas(db, r.quotas);
        setCursor(db, path, a.agent, r.cursor, r.errors);
      });
      stats.read++;
      stats.events += r.events.length;
      stats.errors += r.errors;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return stats;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/ingest.ts test/ingest.test.ts
git commit -m "feat: incremental ingest pipeline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Read queries

**Files:**
- Create: `src/queries.ts`
- Test: `test/queries.test.ts`

**Interfaces:**
- Consumes: `DB`, `Filter`, `costOf`, `PRICES_AS_OF`.
- Produces (all the API returns; field names are what the dashboard reads):
  - `interface Totals { input; output; cacheRead; cacheWrite; cacheWrite1h; reasoning; tokens; cost; unpricedTokens }` (numbers)
  - `summary(db, f) → { totals: Totals; byAgent: ({ agent } & Totals)[]; sessions: number; pricesAsOf: string }`
  - `daily(db, f) → ({ day: 'YYYY-MM-DD' (local); agent } & Totals)[]`, sorted by day
  - `models(db, f) → ({ name: string | null; agent } & Totals)[]`, sorted by tokens desc
  - `projects(db, f) → ({ projectId; name; root; sessions; lastActive; agents: 'claude,codex' } & Totals)[]`, sorted by tokens desc
  - `sessions(db, f, limit = 200) → ({ id; agent; parentId; project; started; ended; turns; toolCalls } & Totals)[]`, sorted by ended desc
  - `sessionDetail(db, id) → null | { id; agent; cwd; parentId; project; root; totals: Totals; turns: { ts; model; context; output }[]; tools: { tool; calls; resultBytes; errors }[]; children: { id; agent }[] }`
  - `quota(db, f) → { latest: { agent; win; usedPct; resetsAt; ts }[]; timeline: { agent; win; ts; usedPct }[]; limitHits: { agent; win; resetsAt; firstHit }[] }`
  - `health(db) → { sources: { agent; files; badLines; lastIngest }[]; events: { agent; events; latestEvent }[] }`

- [ ] **Step 1: Write the failing test**

`test/queries.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertEvents, upsertSessions, upsertProject, insertQuotas } from '../src/db.ts';
import * as q from '../src/queries.ts';
import { costOf } from '../src/pricing.ts';
import type { NormalizedEvent } from '../src/types.ts';

const day1 = new Date(2026, 9, 14, 12).getTime(); // local noon, so local-day bucketing is unambiguous
const day2 = new Date(2026, 9, 15, 12).getTime();
const localDay = (ms: number) => new Date(ms).toLocaleDateString('sv');

function seed() {
  const db = openDb(':memory:');
  const a = upsertProject(db, '/r/app', 'app');
  const b = upsertProject(db, '/r/api', 'api');
  upsertSessions(db, [
    { id: 's1', agent: 'claude', cwd: '/r/app', projectId: a },
    { id: 's3', agent: 'claude', cwd: '/r/app', parentId: 's1', projectId: a },
    { id: 's2', agent: 'codex', cwd: '/r/api', projectId: b },
  ]);
  const t = (id: string, session: string, ts: number, model: string, input: number, output: number): NormalizedEvent =>
    ({ id, agent: session === 's2' ? 'codex' : 'claude', sessionId: session, ts, kind: 'assistant', model, input, output, cacheRead: 100, cacheWrite: 10, cacheWrite1h: 10 });
  upsertEvents(db, [
    t('e1', 's1', day1, 'claude-opus-5-5', 5, 50),
    t('e2', 's1', day2, 'claude-opus-5-5', 7, 70),
    t('e3', 's3', day2 + 1000, 'claude-haiku-5-5', 1, 10),
    t('e4', 's2', day2 + 2000, 'codex-auto-review', 3, 30),
    { id: 'c1', agent: 'claude', sessionId: 's1', ts: day2, kind: 'tool_call', tool: 'Bash' },
    { id: 'c1:result', agent: 'claude', sessionId: 's1', ts: day2, kind: 'tool_result', resultBytes: 5, isError: true },
  ]);
  insertQuotas(db, [
    { agent: 'codex', ts: day1, window: '5h', usedPct: 50, resetsAt: day1 + 1, source: 'codex-log' },
    { agent: 'codex', ts: day2, window: '5h', usedPct: 100, resetsAt: day2 + 1, source: 'codex-log' },
  ]);
  return { db, a, b };
}

const tok = (input: number, output: number) => input + output + 110;

test('summary totals tokens, and keeps unpriced models out of cost', () => {
  const { db } = seed();
  const s = q.summary(db, {});
  assert.equal(s.totals.tokens, tok(5, 50) + tok(7, 70) + tok(1, 10) + tok(3, 30));
  assert.equal(s.totals.unpricedTokens, tok(3, 30), 'codex-auto-review has no price');
  const u = (i: number, o: number) => ({ input: i, output: o, cacheRead: 100, cacheWrite: 10, cacheWrite1h: 10 });
  const expected = costOf('claude-opus-5-5', u(5, 50))! + costOf('claude-opus-5-5', u(7, 70))! + costOf('claude-haiku-5-5', u(1, 10))!;
  assert.ok(Math.abs(s.totals.cost - expected) < 1e-12);
  assert.equal(s.sessions, 3);
  assert.deepEqual(s.byAgent.map((g) => g.agent).sort(), ['claude', 'codex']);
});

test('filters by agent, project and time', () => {
  const { db, a } = seed();
  assert.equal(q.summary(db, { agent: 'codex' }).totals.tokens, tok(3, 30));
  assert.equal(q.summary(db, { projectId: a }).sessions, 2);
  assert.equal(q.summary(db, { from: day2 }).totals.tokens, tok(7, 70) + tok(1, 10) + tok(3, 30));
});

test('daily buckets by local day and agent', () => {
  const { db } = seed();
  const d = q.daily(db, {});
  assert.deepEqual(d.map((r) => [r.day, r.agent]), [[localDay(day1), 'claude'], [localDay(day2), 'claude'], [localDay(day2), 'codex']]);
});

test('projects and models rank by tokens', () => {
  const { db } = seed();
  const p = q.projects(db, {});
  assert.deepEqual(p.map((r) => [r.name, r.sessions]), [['app', 2], ['api', 1]]);
  assert.equal(p[0].agents, 'claude');
  assert.equal(q.models(db, {})[0].name, 'claude-opus-5-5');
});

test('sessions lists newest first with turns and tool calls; detail joins tool results', () => {
  const { db } = seed();
  const list = q.sessions(db, {}, 2);
  assert.deepEqual(list.map((r) => r.id), ['s2', 's3']);
  const s1 = q.sessions(db, {}).find((r) => r.id === 's1')!;
  assert.deepEqual([s1.turns, s1.toolCalls, s1.project], [2, 1, 'app']);
  const d = q.sessionDetail(db, 's1')!;
  assert.deepEqual(d.turns.map((t) => t.context), [5 + 110, 7 + 110]);
  assert.deepEqual(d.tools, [{ tool: 'Bash', calls: 1, resultBytes: 5, errors: 1 }].map((x) => ({ ...x })));
  assert.deepEqual(d.children.map((c) => c.id), ['s3']);
  assert.equal(d.totals.tokens, tok(5, 50) + tok(7, 70));
  assert.equal(q.sessionDetail(db, 'nope'), null);
});

test('quota returns the latest snapshot per window and limit hits', () => {
  const { db } = seed();
  const r = q.quota(db, {});
  assert.deepEqual(r.latest.map((l) => [l.agent, l.win, l.usedPct]), [['codex', '5h', 100]]);
  assert.equal(r.timeline.length, 2);
  assert.equal(r.limitHits.length, 1);
});
```

Note on `deepEqual` with SQLite rows: `node:sqlite` returns null-prototype objects. `assert.deepEqual` in strict mode compares prototypes, so the implementation must spread rows (`{ ...r }`) before returning them. The tests rely on that.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/queries.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/queries.ts`**

```ts
import type { DB } from './db.ts';
import type { Filter } from './types.ts';
import { costOf, PRICES_AS_OF } from './pricing.ts';

export interface Totals {
  input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; reasoning: number;
  tokens: number; cost: number; unpricedTokens: number;
}
type Row = Record<string, any>;

const SUMS = `sum(e.input) AS input, sum(e.output) AS output, sum(e.cache_read) AS cacheRead,
  sum(e.cache_write) AS cacheWrite, sum(e.cache_write_1h) AS cacheWrite1h, sum(e.reasoning) AS reasoning`;
const FROM = 'FROM events e LEFT JOIN sessions s ON s.id = e.session_id';
const plain = (rows: unknown[]) => rows.map((r) => ({ ...(r as Row) })); // node:sqlite rows have a null prototype

function where(f: Filter & { sessionId?: string }) {
  const c: string[] = [];
  const params: Record<string, string | number> = {};
  if (f.from != null) { c.push('e.ts >= $from'); params.from = f.from; }
  if (f.to != null) { c.push('e.ts < $to'); params.to = f.to; }
  if (f.agent) { c.push('e.agent = $agent'); params.agent = f.agent; }
  if (f.projectId != null) { c.push('s.project_id = $projectId'); params.projectId = f.projectId; }
  if (f.sessionId) { c.push('e.session_id = $sessionId'); params.sessionId = f.sessionId; }
  return { sql: c.map((x) => ` AND ${x}`).join(''), params };
}

const zero = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, tokens: 0, cost: 0, unpricedTokens: 0 });

function add(t: Totals, r: Row) {
  const u = { input: r.input ?? 0, output: r.output ?? 0, cacheRead: r.cacheRead ?? 0, cacheWrite: r.cacheWrite ?? 0, cacheWrite1h: r.cacheWrite1h ?? 0 };
  for (const k of Object.keys(u) as (keyof typeof u)[]) t[k] += u[k];
  t.reasoning += r.reasoning ?? 0;
  const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
  t.tokens += tokens;
  const c = costOf(r.model, u);
  if (c == null) t.unpricedTokens += tokens;
  else t.cost += c;
}

/**
 * Token totals and estimated cost per group. Cost needs the model, so rows are grouped by (dims..., model)
 * and folded per dims in JS. `dims` maps output field -> SQL expression: only pass literals, never user input.
 */
function grouped(db: DB, f: Filter & { sessionId?: string }, dims: Record<string, string>): (Row & Totals)[] {
  const w = where(f);
  const keys = Object.keys(dims);
  const select = keys.map((k) => `${dims[k]} AS ${k}, `).join('');
  const groupBy = [...keys.map((_, i) => i + 1), keys.length + 1].join(', '); // ordinals: avoids ambiguous aliases like "agent"
  const rows = db.prepare(`SELECT ${select}e.model AS model, ${SUMS} ${FROM} WHERE e.kind = 'assistant'${w.sql} GROUP BY ${groupBy}`).all(w.params) as Row[];
  const out = new Map<string, Row & Totals>();
  for (const r of rows) {
    const id = JSON.stringify(keys.map((k) => r[k]));
    let g = out.get(id);
    if (!g) { g = { ...Object.fromEntries(keys.map((k) => [k, r[k]])), ...zero() }; out.set(id, g); }
    add(g, r);
  }
  return [...out.values()];
}

export function summary(db: DB, f: Filter) {
  const w = where(f);
  const { n } = db.prepare(`SELECT count(DISTINCT e.session_id) AS n ${FROM} WHERE 1 = 1${w.sql}`).get(w.params) as { n: number };
  return { totals: grouped(db, f, {})[0] ?? zero(), byAgent: grouped(db, f, { agent: 'e.agent' }), sessions: n, pricesAsOf: PRICES_AS_OF };
}

export const daily = (db: DB, f: Filter) =>
  grouped(db, f, { day: `date(e.ts / 1000, 'unixepoch', 'localtime')`, agent: 'e.agent' })
    .sort((a, b) => a.day.localeCompare(b.day) || a.agent.localeCompare(b.agent));

export const models = (db: DB, f: Filter) => grouped(db, f, { name: 'e.model', agent: 'e.agent' }).sort((a, b) => b.tokens - a.tokens);

export function projects(db: DB, f: Filter) {
  const w = where(f);
  const meta = new Map((db.prepare(`
    SELECT s.project_id AS projectId, p.name, p.root, count(DISTINCT e.session_id) AS sessions, max(e.ts) AS lastActive,
      group_concat(DISTINCT e.agent) AS agents
    ${FROM} JOIN projects p ON p.id = s.project_id WHERE 1 = 1${w.sql} GROUP BY s.project_id`).all(w.params) as Row[])
    .map((r) => [r.projectId, { ...r }]));
  return grouped(db, f, { projectId: 's.project_id' })
    .filter((g) => meta.has(g.projectId))
    .map((g) => ({ ...meta.get(g.projectId), ...g }))
    .sort((a, b) => b.tokens - a.tokens);
}

// ponytail: totals are computed for every session in range, then joined to the page; fine at thousands of sessions.
export function sessions(db: DB, f: Filter, limit = 200) {
  const w = where(f);
  const rows = db.prepare(`
    SELECT e.session_id AS id, e.agent, s.parent_id AS parentId, p.name AS project, min(e.ts) AS started, max(e.ts) AS ended,
      sum(e.kind = 'assistant') AS turns, sum(e.kind = 'tool_call') AS toolCalls
    ${FROM} LEFT JOIN projects p ON p.id = s.project_id WHERE 1 = 1${w.sql}
    GROUP BY e.session_id ORDER BY ended DESC LIMIT $limit`).all({ ...w.params, limit }) as Row[];
  const totals = new Map(grouped(db, f, { id: 'e.session_id' }).map((g) => [g.id, g]));
  return rows.map((r) => ({ ...r, ...(totals.get(r.id) ?? zero()) }));
}

export function sessionDetail(db: DB, id: string) {
  const s = db.prepare(`SELECT s.id, s.agent, s.cwd, s.parent_id AS parentId, p.name AS project, p.root
    FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?`).get(id) as Row | undefined;
  if (!s) return null;
  return {
    ...s,
    totals: grouped(db, { sessionId: id }, {})[0] ?? zero(),
    turns: plain(db.prepare(`SELECT ts, model, input + cache_read + cache_write AS context, output
      FROM events WHERE session_id = ? AND kind = 'assistant' ORDER BY ts`).all(id)),
    tools: plain(db.prepare(`SELECT c.tool, count(*) AS calls, coalesce(sum(r.result_bytes), 0) AS resultBytes, coalesce(sum(r.is_error), 0) AS errors
      FROM events c LEFT JOIN events r ON r.id = c.id || ':result'
      WHERE c.session_id = ? AND c.kind = 'tool_call' GROUP BY c.tool ORDER BY calls DESC`).all(id)),
    children: plain(db.prepare('SELECT id, agent FROM sessions WHERE parent_id = ? ORDER BY id').all(id)),
  };
}

export function quota(db: DB, f: Filter) {
  const p = { from: f.from ?? 0, to: f.to ?? Number.MAX_SAFE_INTEGER, agent: f.agent ?? '' };
  const agentSql = `($agent = '' OR agent = $agent)`;
  return {
    latest: plain(db.prepare(`SELECT agent, win, used_pct AS usedPct, resets_at AS resetsAt, ts FROM quota_snapshots q
      WHERE ts = (SELECT max(ts) FROM quota_snapshots WHERE agent = q.agent AND win = q.win) AND ${agentSql}
      ORDER BY agent, win`).all({ agent: p.agent })),
    timeline: plain(db.prepare(`SELECT agent, win, ts, used_pct AS usedPct FROM quota_snapshots
      WHERE ts >= $from AND ts < $to AND ${agentSql} ORDER BY ts`).all(p)),
    limitHits: plain(db.prepare(`SELECT agent, win, resets_at AS resetsAt, min(ts) AS firstHit FROM quota_snapshots
      WHERE used_pct >= 100 AND ts >= $from AND ts < $to AND ${agentSql}
      GROUP BY agent, win, resets_at ORDER BY firstHit DESC`).all(p)),
  };
}

export function health(db: DB) {
  return {
    sources: plain(db.prepare('SELECT agent, count(*) AS files, sum(errors) AS badLines, max(updated_at) AS lastIngest FROM cursors GROUP BY agent').all()),
    events: plain(db.prepare('SELECT agent, count(*) AS events, max(ts) AS latestEvent FROM events GROUP BY agent').all()),
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, tsc exits 0. If a `deepEqual` fails only on `[Object: null prototype]`, a row was returned without going through `plain()`/spread. Fix it in `queries.ts`, not in the test.

- [ ] **Step 5: Commit**

```bash
git add src/queries.ts test/queries.test.ts
git commit -m "feat: usage, project, session and quota queries with cost estimates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: HTTP server

**Files:**
- Create: `src/server.ts`, plus a minimal `web/index.html` placeholder so static serving can be tested (Task 10 replaces it).
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: everything exported from `queries.ts`.
- Produces: `startServer(db: DB, port: number, host?: string): Promise<Server>`. Routes: `GET /api/summary|daily|projects|models|sessions|session|quota|health`. The query params `from`, `to` (epoch ms), `agent`, `project` (project id), `limit` (sessions, max 1000) and `id` (session) are all optional, and invalid numbers are ignored. All other paths serve files from `web/`.

- [ ] **Step 1: Write the failing test**

`web/index.html` (temporary):
```html
<!doctype html><title>agentlens</title>
```

`test/server.test.ts`:
```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { startServer } from '../src/server.ts';

const server = await startServer(openDb(':memory:'), 0);
const port = (server.address() as AddressInfo).port;
after(() => server.close());

function get(path: string, host = `127.0.0.1:${port}`): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), body }));
    }).on('error', reject).end();
  });
}

test('API endpoints answer with JSON, even on an empty database', async () => {
  for (const p of ['summary', 'daily', 'projects', 'models', 'sessions', 'quota', 'health']) {
    const r = await get(`/api/${p}`);
    assert.equal(r.status, 200, p);
    assert.match(r.type, /application\/json/);
    JSON.parse(r.body);
  }
  assert.equal(JSON.parse((await get('/api/session?id=nope')).body), null);
});

test('invalid numeric params are ignored, not errors', async () => {
  assert.equal((await get('/api/summary?from=abc&project=&limit=-5')).status, 200);
});

test('serves the dashboard and blocks path traversal', async () => {
  const index = await get('/');
  assert.equal(index.status, 200);
  assert.match(index.body, /<title>agentlens<\/title>/);
  assert.equal((await get('/../src/db.ts')).status, 404);
  assert.equal((await get('/%2e%2e/package.json')).status, 404);
  assert.equal((await get('/nope.js')).status, 404);
});

test('rejects foreign Host headers (DNS rebinding)', async () => {
  assert.equal((await get('/api/summary', 'evil.example:80')).status, 403);
  assert.equal((await get('/api/summary', `localhost:${port}`)).status, 200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server.ts`**

```ts
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts web/index.html test/server.test.ts
git commit -m "feat: localhost JSON API and static server with host and path guards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Dashboard UI

**Files:**
- Create: `web/index.html` (replace the placeholder), `web/app.js`, `web/style.css`, `web/vendor/uPlot.iife.min.js`, `web/vendor/uPlot.min.css`, `web/vendor/LICENSE-uPlot`

**Interfaces:**
- Consumes: the API from Task 9, with field names exactly as listed in Task 8.
- Produces: hash routes `#/overview`, `#/projects`, `#/sessions`, `#/session/<id>`, `#/project/<id>` (sets the project filter, then shows the overview), `#/quota` and `#/health`.

Before writing chart code, load the `dataviz` skill and follow its color and axis guidance. The agent colors below are a starting point; adjust them only if the skill's validator rejects them.

- [ ] **Step 1: Vendor uPlot**

```bash
mkdir -p web/vendor
curl -fsSL https://cdn.jsdelivr.net/npm/uplot@1.6.32/dist/uPlot.iife.min.js -o web/vendor/uPlot.iife.min.js
curl -fsSL https://cdn.jsdelivr.net/npm/uplot@1.6.32/dist/uPlot.min.css -o web/vendor/uPlot.min.css
curl -fsSL https://cdn.jsdelivr.net/npm/uplot@1.6.32/LICENSE -o web/vendor/LICENSE-uPlot
head -c 120 web/vendor/uPlot.iife.min.js
```
Expected: the JS file starts with `/*! https://github.com/leeoniya/uPlot (v1.6.32) */` or similar, and the LICENSE is MIT.

- [ ] **Step 2: Write `web/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>agentlens</title>
  <link rel="stylesheet" href="vendor/uPlot.min.css">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <a class="brand" href="#/overview">agentlens</a>
    <nav aria-label="Pages">
      <a href="#/overview">Overview</a>
      <a href="#/projects">Projects</a>
      <a href="#/sessions">Sessions</a>
      <a href="#/quota">Quota</a>
      <a href="#/health">Health</a>
    </nav>
    <form class="filters" onsubmit="return false">
      <label>Range
        <select id="f-range">
          <option value="7">Last 7 days</option>
          <option value="30" selected>Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="0">All time</option>
        </select>
      </label>
      <label>Agent
        <select id="f-agent">
          <option value="">All agents</option>
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="opencode">OpenCode</option>
          <option value="antigravity">Antigravity</option>
        </select>
      </label>
      <label>Project
        <select id="f-project"><option value="">All projects</option></select>
      </label>
    </form>
  </header>
  <main id="main"></main>
  <script src="vendor/uPlot.iife.min.js"></script>
  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write `web/style.css`**

```css
:root {
  --bg: #fafaf9; --surface: #ffffff; --text: #1c1917; --muted: #6b6560; --border: #e7e5e4; --grid: #efedeb;
  --accent: #3b63d9; --error: #b42318; color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #121212; --surface: #1b1b1b; --text: #ecebe9; --muted: #a29e9a; --border: #2c2c2c; --grid: #262626; --accent: #8aa6ff; --error: #f97066; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, sans-serif; }
header { display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: center; padding: 12px 16px; background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 1; }
.brand { font-weight: 600; color: var(--text); text-decoration: none; }
nav { display: flex; flex-wrap: wrap; gap: 4px; }
nav a { color: var(--muted); text-decoration: none; padding: 4px 8px; border-radius: 6px; }
nav a[aria-current="page"] { color: var(--text); background: var(--bg); }
nav a:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.filters { display: flex; flex-wrap: wrap; gap: 12px; margin-left: auto; }
.filters label { display: flex; gap: 6px; align-items: center; color: var(--muted); }
select { font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 4px 6px; }
main { max-width: 1200px; margin: 0 auto; padding: 16px; }
main[aria-busy="true"] { opacity: 0.6; }
h1 { font-size: 20px; margin: 8px 0; }
h2 { font-size: 15px; margin: 24px 0 8px; }
.hint, .note, .empty { color: var(--muted); }
.error { color: var(--error); }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
.tile .label { color: var(--muted); font-size: 12px; }
.tile .value { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tile .note { font-size: 12px; }
.chart { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px; min-height: 290px; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr)); gap: 16px; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { color: var(--muted); font-weight: 500; font-size: 12px; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
tr[data-href] { cursor: pointer; }
tr[data-href]:hover, tr[data-href]:focus-visible { background: var(--bg); outline: none; }
tr[data-href]:focus-visible td:first-child { box-shadow: inset 3px 0 var(--accent); }
a { color: var(--accent); }
.u-legend { color: var(--text); }
```

- [ ] **Step 4: Write `web/app.js`**

```js
// agentlens dashboard. Vanilla JS, no build step; every number comes from the local /api.
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTok = (n) => { n = n ?? 0; return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)); };
const fmtUsd = (n) => `$${(n ?? 0).toFixed(2)}`;
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const AGENTS = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' };
const COLORS = { claude: '#d97757', codex: '#4f7cff', opencode: '#2fa37a', antigravity: '#a35fd6' };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
// Unpriced tokens are never shown as $0: all-unpriced says so, partly-unpriced gets an asterisk.
const cost = (t) => (t.cost === 0 && t.unpricedTokens > 0 ? 'unpriced' : fmtUsd(t.cost) + (t.unpricedTokens > 0 ? '*' : ''));

const state = { range: 30, agent: '', project: '' };
let charts = [];

async function api(path, extra = {}) {
  const p = new URLSearchParams(extra);
  if (state.range) p.set('from', String(Date.now() - state.range * 864e5));
  if (state.agent) p.set('agent', state.agent);
  if (state.project) p.set('project', state.project);
  const r = await fetch(`/api/${path}?${p}`);
  if (!r.ok) throw new Error(`/api/${path} returned ${r.status}`);
  return r.json();
}

const tile = (label, value, note = '') =>
  `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="note">${esc(note)}</div></div>`;

function table(cols, rows, href) {
  if (!rows.length) return '<p class="empty">Nothing in this range. Widen the range above, or open Health if you expected data.</p>';
  const head = cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('');
  const body = rows.map((r) => `<tr${href ? ` data-href="${esc(href(r))}" tabindex="0"` : ''}>${
    cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${esc(c.get(r))}</td>`).join('')}</tr>`).join('');
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function chart(id, x, series, { time = true, fmt = fmtTok } = {}) {
  const el = document.getElementById(id);
  const axis = { stroke: css('--muted'), grid: { stroke: css('--grid') }, ticks: { stroke: css('--grid') } };
  charts.push(new uPlot({
    width: el.clientWidth - 16, height: 260, scales: { x: { time } },
    series: [{}, ...series.map((s) => ({ label: s.label, stroke: s.color, dash: s.dash, width: 2, spanGaps: true, value: (u, v) => (v == null ? '—' : fmt(v)) }))],
    axes: [axis, { ...axis, size: 64, values: (u, vals) => vals.map(fmt) }],
  }, [x, ...series.map((s) => s.data)], el));
}

const agentCol = { label: 'Agent', get: (r) => AGENTS[r.agent] ?? r.agent };
const tokCols = [
  { label: 'Tokens (measured)', num: true, get: (r) => fmtTok(r.tokens) },
  { label: 'Cache read', num: true, get: (r) => fmtTok(r.cacheRead) },
  { label: 'API-equivalent cost (estimated)', num: true, get: cost },
];
const projectCols = [
  { label: 'Project', get: (r) => r.name },
  { label: 'Agents', get: (r) => (r.agents ?? '').split(',').filter(Boolean).map((a) => AGENTS[a] ?? a).join(', ') },
  { label: 'Sessions', num: true, get: (r) => r.sessions },
  ...tokCols,
  { label: 'Last active', get: (r) => fmtTime(r.lastActive) },
];

function quotaTiles(latest) {
  return ['claude', 'codex'].flatMap((agent) => ['5h', '7d'].map((win) => {
    const q = latest.find((l) => l.agent === agent && l.win === win);
    const name = `${AGENTS[agent]} ${win}`;
    if (!q) return tile('Quota used (reported by agent)', 'n/a', `${name}: not reported yet`);
    if (q.resetsAt < Date.now()) return tile('Quota used (reported by agent)', 'n/a', `${name}: window reset since the last report`);
    return tile('Quota used (reported by agent)', `${Math.round(q.usedPct)}%`, `${name} · resets ${fmtTime(q.resetsAt)}`);
  })).join('');
}

async function overview() {
  const [s, daily, models, projects, quota] = await Promise.all([api('summary'), api('daily'), api('models'), api('projects'), api('quota')]);
  const t = s.totals;
  const days = [...new Set(daily.map((d) => d.day))];
  const agents = [...new Set(daily.map((d) => d.agent))];
  return {
    html: `
      <section class="tiles">
        ${tile('Tokens (measured)', fmtTok(t.tokens), `${fmtTok(t.input)} input · ${fmtTok(t.output)} output · ${fmtTok(t.cacheRead)} cache read · ${fmtTok(t.cacheWrite)} cache write`)}
        ${tile('API-equivalent cost (estimated)', cost(t), t.unpricedTokens ? `${fmtTok(t.unpricedTokens)} tokens from unpriced models not included` : `List prices as of ${s.pricesAsOf}; not what your plan bills`)}
        ${tile('Sessions', String(s.sessions), t.tokens ? `${Math.round((t.cacheRead / t.tokens) * 100)}% of tokens were cache reads` : '')}
        ${quotaTiles(quota.latest)}
      </section>
      <h2>Tokens per day</h2>
      <div id="c-daily" class="chart"></div>
      <div class="cols">
        <section><h2>By agent</h2>${table([agentCol, ...tokCols], s.byAgent)}</section>
        <section><h2>By model</h2>${table([{ label: 'Model', get: (r) => r.name ?? 'unknown' }, agentCol, ...tokCols], models)}</section>
      </div>
      <h2>Top projects</h2>
      ${table(projectCols, projects.slice(0, 10), (r) => `#/project/${r.projectId}`)}`,
    after: () => days.length && chart('c-daily', days.map((d) => Date.parse(`${d}T00:00:00`) / 1000),
      agents.map((a) => ({ label: AGENTS[a] ?? a, color: COLORS[a], data: days.map((d) => daily.find((x) => x.day === d && x.agent === a)?.tokens ?? 0) }))),
  };
}

async function projectsPage() {
  const rows = await api('projects');
  return {
    html: `<h1>Projects</h1>
      <p class="hint">Grouped by git repository; worktrees count toward their main repo. Select a row to filter the overview to that project.</p>
      ${table([...projectCols, { label: 'Path', get: (r) => r.root }], rows, (r) => `#/project/${r.projectId}`)}`,
  };
}

async function sessionsPage() {
  const rows = await api('sessions', { limit: '300' });
  return {
    html: `<h1>Sessions</h1>${table([
      { label: 'Last activity', get: (r) => fmtTime(r.ended) }, agentCol, { label: 'Project', get: (r) => r.project ?? '—' },
      { label: 'Kind', get: (r) => (r.parentId ? 'subagent' : 'main') },
      { label: 'Turns', num: true, get: (r) => r.turns }, { label: 'Tool calls', num: true, get: (r) => r.toolCalls }, ...tokCols,
    ], rows, (r) => `#/session/${encodeURIComponent(r.id)}`)}`,
  };
}

async function sessionPage(id) {
  const d = await api('session', { id: decodeURIComponent(id) });
  if (!d) return { html: '<p class="empty">Session not found. It may not have been ingested yet; check Health.</p>' };
  return {
    html: `<h1>${esc(AGENTS[d.agent] ?? d.agent)} session</h1>
      <p class="hint">${esc(d.project ?? d.cwd ?? '')} · ${esc(d.id)}${d.parentId ? ` · subagent of <a href="#/session/${encodeURIComponent(d.parentId)}">${esc(d.parentId)}</a>` : ''}</p>
      <section class="tiles">${tile('Tokens (measured)', fmtTok(d.totals.tokens))}${tile('API-equivalent cost (estimated)', cost(d.totals))}${tile('Turns', String(d.turns.length))}</section>
      <h2>Context size per turn</h2>
      <p class="hint">Input plus cache tokens sent on each turn. Steady growth with no drop means the context was never compacted.</p>
      <div id="c-ctx" class="chart"></div>
      <h2>Tools</h2>
      ${table([{ label: 'Tool', get: (r) => r.tool }, { label: 'Calls', num: true, get: (r) => r.calls }, { label: 'Result size', num: true, get: (r) => `${fmtTok(r.resultBytes)}B` }, { label: 'Errors', num: true, get: (r) => r.errors }], d.tools)}
      ${d.children.length ? `<h2>Subagents</h2>${table([{ label: 'Session', get: (r) => r.id }, agentCol], d.children, (r) => `#/session/${encodeURIComponent(r.id)}`)}` : ''}`,
    after: () => d.turns.length && chart('c-ctx', d.turns.map((_, i) => i + 1),
      [{ label: 'Context tokens', color: COLORS[d.agent], data: d.turns.map((t) => t.context) }], { time: false }),
  };
}

async function quotaPage() {
  const q = await api('quota');
  const keys = [...new Set(q.timeline.map((p) => `${p.agent}|${p.win}`))];
  const xs = [...new Set(q.timeline.map((p) => p.ts))].sort((a, b) => a - b);
  const idx = new Map(xs.map((x, i) => [x, i]));
  return {
    html: `<h1>Quota</h1>
      <p class="hint">Percentages exactly as each agent reports them. Agents that don't report quota show n/a, never an estimate.</p>
      <section class="tiles">${quotaTiles(q.latest)}</section>
      <h2>Usage over time</h2>
      <div id="c-quota" class="chart"></div>
      <h2>Limit hits</h2>
      ${table([agentCol, { label: 'Window', get: (r) => r.win }, { label: 'First hit', get: (r) => fmtTime(r.firstHit) }, { label: 'Window reset', get: (r) => fmtTime(r.resetsAt) }], q.limitHits)}`,
    after: () => xs.length && chart('c-quota', xs.map((x) => x / 1000), keys.map((k) => {
      const [agent, win] = k.split('|');
      const data = new Array(xs.length).fill(null);
      for (const p of q.timeline) if (p.agent === agent && p.win === win) data[idx.get(p.ts)] = p.usedPct;
      return { label: `${AGENTS[agent] ?? agent} ${win}`, color: COLORS[agent], dash: win === '7d' ? [6, 4] : undefined, data };
    }), { fmt: (v) => `${Math.round(v)}%` }),
  };
}

async function healthPage() {
  const h = await api('health');
  return {
    html: `<h1>Health</h1>
      <p class="hint">What agentlens has read so far. Bad lines are records it could not parse and skipped.</p>
      ${table([agentCol, { label: 'Files tracked', num: true, get: (r) => r.files }, { label: 'Bad lines', num: true, get: (r) => r.badLines }, { label: 'Last ingest', get: (r) => fmtTime(r.lastIngest) }], h.sources)}
      <h2>Events</h2>
      ${table([agentCol, { label: 'Events', num: true, get: (r) => r.events }, { label: 'Latest event', get: (r) => fmtTime(r.latestEvent) }], h.events)}`,
  };
}

const routes = { overview, projects: projectsPage, sessions: sessionsPage, session: sessionPage, quota: quotaPage, health: healthPage };

async function render() {
  const [, name = 'overview', arg = ''] = location.hash.split('/');
  if (name === 'project') {
    state.project = arg;
    $('#f-project').value = arg;
    location.hash = '#/overview';
    return;
  }
  document.querySelectorAll('nav a').forEach((a) => {
    if (a.getAttribute('href') === `#/${name}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const main = $('#main');
  main.setAttribute('aria-busy', 'true');
  try {
    const { html, after } = await (routes[name] ?? overview)(arg);
    charts.forEach((c) => c.destroy());
    charts = [];
    main.innerHTML = html;
    after?.();
  } catch (e) {
    main.innerHTML = `<p class="error">Couldn't load this page (${esc(e.message)}). Check that the agentlens service is running, then reload.</p>`;
  }
  main.removeAttribute('aria-busy');
}

for (const [id, key] of [['f-range', 'range'], ['f-agent', 'agent'], ['f-project', 'project']]) {
  $(`#${id}`).addEventListener('change', (e) => { state[key] = key === 'range' ? Number(e.target.value) : e.target.value; render(); });
}
document.addEventListener('click', (e) => { const tr = e.target.closest?.('tr[data-href]'); if (tr) location.hash = tr.dataset.href; });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches?.('tr[data-href]')) location.hash = e.target.dataset.href; });
window.addEventListener('hashchange', render);
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 250); });
setInterval(() => { if (!document.hidden) render(); }, 60_000);

fetch('/api/projects').then((r) => r.json()).then((ps) => {
  $('#f-project').insertAdjacentHTML('beforeend', ps.map((p) => `<option value="${p.projectId}">${esc(p.name)}</option>`).join(''));
  if (state.project) $('#f-project').value = state.project;
});
render();
```

- [ ] **Step 5: Run the server test (it still uses `/`) and syntax-check the JS**

Run: `npm test && node --check web/app.js`
Expected: all tests PASS (the server test now matches the real `<title>agentlens</title>`), and `node --check` exits 0.

- [ ] **Step 6: Commit**

```bash
git add web/
git commit -m "feat: dashboard UI (overview, projects, sessions, quota, health)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: CLI — `serve`, `ingest`, `install-service`

**Files:**
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `openDb`, `ingest`, `ADAPTERS`, `startServer`.
- Produces: an executable `src/cli.ts` with these commands:
  - `serve`: ingests, serves, watches, polls every 60s, and prints `agentlens dashboard: http://127.0.0.1:<port>`.
  - `ingest`: prints `<read>/<files> files read, <events> events, <errors> bad lines`.
  - `install-service`: writes `$XDG_CONFIG_HOME/systemd/user/agentlens.service`.
  - `help`.

- [ ] **Step 1: Write the failing test**

`test/cli.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, put, jsonl, cAssistant } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const { CLAUDE_CONFIG_DIR: _c, CODEX_HOME: _x, ...baseEnv } = process.env;
const run = (args: string[], env: Record<string, string>) =>
  execFileSync(process.execPath, ['--no-warnings', CLI, ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8' });

test('ingest reads a home directory into the data dir', () => {
  const home = tmp();
  const data = tmp();
  put(join(home, '.claude/projects/-p/s1.jsonl'), jsonl(cAssistant({ msg: 'm1' })));
  const out = run(['ingest'], { AGENTLENS_SOURCE_HOME: home, AGENTLENS_DATA_DIR: data });
  assert.match(out, /1\/1 files read, 1 events, 0 bad lines/);
  assert.ok(existsSync(join(data, 'agentlens.db')));
});

test('install-service writes a user unit that runs this checkout', () => {
  const cfg = tmp();
  const out = run(['install-service'], { XDG_CONFIG_HOME: cfg });
  const unit = readFileSync(join(cfg, 'systemd/user/agentlens.service'), 'utf8');
  assert.ok(unit.includes(`"${CLI}" serve`), unit);
  assert.match(unit, /^Nice=10$/m);
  assert.match(unit, /^MemoryMax=200M$/m);
  assert.match(out, /systemctl --user enable --now agentlens/);
});

test('serve answers on the port it reports', async () => {
  const child = spawn(process.execPath, ['--no-warnings', CLI, 'serve'], {
    env: { ...baseEnv, AGENTLENS_SOURCE_HOME: tmp(), AGENTLENS_DATA_DIR: tmp(), AGENTLENS_PORT: '0' },
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', (d) => { const m = /http:\/\/127\.0\.0\.1:\d+/.exec(String(d)); if (m) resolve(m[0]); });
      child.on('exit', (code) => reject(new Error(`serve exited ${code}`)));
    });
    const r = await fetch(`${url}/api/health`);
    assert.equal(r.status, 200);
  } finally {
    child.kill();
  }
});

test('unknown command prints help and fails', () => {
  assert.throws(() => run(['bogus'], {}), /Usage: agentlens/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings --test test/cli.test.ts`
Expected: FAIL — `Cannot find module .../src/cli.ts`.

- [ ] **Step 3: Implement `src/cli.ts`**

```ts
#!/usr/bin/env node
import { existsSync, mkdirSync, watch, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { ADAPTERS, ingest } from './ingest.ts';
import { startServer } from './server.ts';

const env = process.env;
const HOME = env.AGENTLENS_SOURCE_HOME ?? homedir();
const DATA_DIR = env.AGENTLENS_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'agentlens');
const DB_PATH = join(DATA_DIR, 'agentlens.db');
const PORT = Number(env.AGENTLENS_PORT ?? 4711);

const HELP = `Usage: agentlens <command>

  serve            ingest continuously and serve the dashboard on http://127.0.0.1:${PORT}
  ingest           one-shot ingest of new agent log data, then exit
  install-service  write a systemd user unit so serve starts at login (you enable it)
  help             show this message

Data: ${DB_PATH}`;

async function serve() {
  const db = openDb(DB_PATH);
  let running = false;
  let again = false;
  // One ingest at a time; a trigger during a run schedules exactly one follow-up run.
  const run = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      do { again = false; await ingest(db, HOME); } while (again);
    } catch (e) {
      console.error('agentlens: ingest failed:', e);
    } finally {
      running = false;
    }
  };
  const server = await startServer(db, PORT);
  console.log(`agentlens dashboard: http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await run();

  // Throttle, not debounce: agents write continuously during a session, and a debounce would never fire.
  let timer: NodeJS.Timeout | undefined;
  const soon = () => { timer ??= setTimeout(() => { timer = undefined; run(); }, 2000); };
  for (const a of ADAPTERS) {
    const root = a.root(HOME);
    if (existsSync(root)) {
      try { watch(root, { recursive: true }, soon); } catch (e) { console.error(`agentlens: cannot watch ${root}, relying on polling:`, (e as Error).message); }
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
    const s = await ingest(openDb(DB_PATH), HOME);
    console.log(`${s.read}/${s.files} files read, ${s.events} events, ${s.errors} bad lines`);
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, tsc exits 0.

- [ ] **Step 5: Commit**

```bash
chmod +x src/cli.ts
git add src/cli.ts test/cli.test.ts
git commit -m "feat: CLI with serve (watch + poll), ingest and install-service

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Real-data verification, service install, README

**Files:**
- Create: `README.md`
- Modify: whichever file a failing check points to. Debug with superpowers:systematic-debugging before changing anything.

**Interfaces:**
- Consumes: the whole M1 build. Produces nothing new for code. The deliverable is evidence that M1 is correct on this machine's real data.

- [ ] **Step 1: Full backfill on real data into a scratch data dir, measuring cost**

Run:
```bash
export AGENTLENS_DATA_DIR=$(mktemp -d)
/usr/bin/time -f 'wall=%es maxrss=%MKB' node --no-warnings src/cli.ts ingest
/usr/bin/time -f 'wall=%es maxrss=%MKB' node --no-warnings src/cli.ts ingest
```
Expected:
- The first run reads all ~460 files with `0 bad lines` or close to it. The wall time is recorded, and maxrss is **< 200000KB**.
- The second run reports `0/<n> files read` in under 2 seconds. This proves the run is incremental.

If maxrss ≥ 200 MB, lower the `readLines` chunk size and commit per chunk.

- [ ] **Step 2: Cross-check Claude daily totals against ccusage**

Run:
```bash
sqlite3 -readonly "$AGENTLENS_DATA_DIR/agentlens.db" "SELECT date(ts/1000,'unixepoch','localtime') d, sum(input+output+cache_read+cache_write) FROM events WHERE agent='claude' AND kind='assistant' AND ts >= (strftime('%s','now','-7 days')*1000) GROUP BY d ORDER BY d"
npx -y ccusage@latest claude daily --json --since "$(date -d '-7 days' +%Y%m%d)" > "$AGENTLENS_DATA_DIR/ccusage-claude.json"; jq -c '.. | objects | select(has("totalTokens")) | {date: (.date // .period // .key), totalTokens}' "$AGENTLENS_DATA_DIR/ccusage-claude.json" | head -20
```
Expected: for each day, our total is within 5% of ccusage's `totalTokens`. If ccusage's JSON shape differs, inspect it with `jq 'keys'` and adjust the `jq` filter only. If drift exceeds 5%, use systematic-debugging. Likely suspects: dedupe key, sidechain double counting, or missing subagent files.

- [ ] **Step 3: Cross-check Codex the same way**

Run:
```bash
sqlite3 -readonly "$AGENTLENS_DATA_DIR/agentlens.db" "SELECT date(ts/1000,'unixepoch','localtime') d, sum(input+output+cache_read+cache_write) FROM events WHERE agent='codex' AND kind='assistant' AND ts >= (strftime('%s','now','-7 days')*1000) GROUP BY d ORDER BY d"
npx -y ccusage@latest codex daily --json --since "$(date -d '-7 days' +%Y%m%d)" > "$AGENTLENS_DATA_DIR/ccusage-codex.json"; jq -c '.. | objects | select(has("totalTokens")) | {date: (.date // .period // .key), totalTokens}' "$AGENTLENS_DATA_DIR/ccusage-codex.json" | head -20
```
Expected: within 5% per day. Record any systematic gap and its cause in the README "Accuracy" section. For example, ccusage may count reasoning tokens separately.

- [ ] **Step 4: Install and start the service against real data**

Run:
```bash
unset AGENTLENS_DATA_DIR
node --no-warnings src/cli.ts install-service
systemctl --user daemon-reload && systemctl --user enable --now agentlens
sleep 5; systemctl --user status agentlens --no-pager | head -12
curl -s http://127.0.0.1:4711/api/summary | jq '{tokens: .totals.tokens, cost: .totals.cost, unpriced: .totals.unpricedTokens, sessions}'
curl -s http://127.0.0.1:4711/api/quota | jq '.latest'
```
Expected:
- `active (running)`, with memory shown under 200M.
- The summary shows non-zero tokens.
- `quota.latest` contains Codex `5h` and `7d` rows.

- [ ] **Step 5: Look at the dashboard in a browser**

Open `http://127.0.0.1:4711` with the `run` skill or a browser tool. Visit each page: Overview, Projects, a project row, Sessions, a session, Quota and Health. For each, check:
- the three labels read exactly `Tokens (measured)`, `API-equivalent cost (estimated)`, `Quota used (reported by agent)`;
- Claude quota shows `n/a`;
- the charts render in light and dark mode;
- there is no horizontal page scroll at 375px width.

Fix anything broken in `web/` and commit.

- [ ] **Step 6: Write `README.md`**

```markdown
# agentlens

Local-first, read-only usage and workflow optimizer for AI coding agents on Linux.
M1 status: usage dashboard for **Claude Code** and **Codex** (OpenCode and Antigravity are next).

- Reads the log files the agents already write; never modifies agent config; no network at runtime.
- Never stores prompt or tool text (hashes and lengths only).
- Three numbers kept separate: **tokens (measured)**, **API-equivalent cost (estimated** from a bundled LiteLLM
  price snapshot; not what a subscription bills), and **quota used (reported by the agent**; Codex today, Claude via
  the statusline in M2; `n/a` otherwise).

## Install

Requires Node ≥ 22.18.

    git clone <repo> agentlens && cd agentlens && npm install
    node src/cli.ts ingest            # one-shot backfill
    node src/cli.ts serve             # dashboard on http://127.0.0.1:4711

Always on from login:

    node src/cli.ts install-service
    systemctl --user daemon-reload && systemctl --user enable --now agentlens

## Configuration

| Variable | Default |
|---|---|
| `AGENTLENS_DATA_DIR` | `$XDG_DATA_HOME/agentlens` (`~/.local/share/agentlens`) |
| `AGENTLENS_PORT` | `4711` |
| `AGENTLENS_SOURCE_HOME` | your home directory (where agent logs are read from) |

## Accuracy

Daily totals are cross-checked against [ccusage](https://github.com/ccusage/ccusage) (within 5% per day on the
author's data). <Record any known systematic gap found in Task 12 steps 2–3 here, or delete this sentence.>

## Development

    npm test && npm run typecheck
    npm run update-prices   # refresh src/prices.json (dev only)

MIT licensed. Parsing approach informed by ccusage (MIT); uPlot (MIT) is vendored in `web/vendor`.
```

Replace the angle-bracket sentence with the actual cross-check finding before committing.

- [ ] **Step 7: Final verification and commit**

Run: `npm test && npm run typecheck && git status --short`
Expected: all tests pass, tsc exits 0, and only the README plus any fixes are pending.

```bash
git add README.md
git commit -m "docs: M1 README; verified against real data and ccusage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
