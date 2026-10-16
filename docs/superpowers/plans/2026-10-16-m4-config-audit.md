# agentlens M4 — Config Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a comprehensive, read-only Configuration Audit engine for all four agents (Claude Code, Codex, OpenCode, Antigravity) that scans global and project instruction files, MCP servers, skills, plugins, and hooks; measures fixed token overhead; detects unused configurations (30-day inactivity), duplicates, and conflicts; generates actionable recommendations; and exposes findings via CLI (`agentlens audit`), REST API (`/api/audit`), and a dedicated Dashboard UI tab.

**Architecture:**
- `src/audit/scanners/`: Read-only, safe scanners for instruction files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, rules), MCP configs (JSON, TOML, directories), skills (`SKILL.md`), and plugins.
- `src/audit/`: Analyzers for fixed overhead, usage correlation against SQLite `events`, duplicate detection, and conflict detection.
- `src/audit/runner.ts`: Orchestrates audit runs across global paths and registered projects, persisting `audit_items` and synthesizing `findings` and `recommendations`.
- REST API `/api/audit` and CLI command `agentlens audit` for instant inspection.
- Vanilla JS dashboard page in `web/app.js` with inventory tables, overhead metrics, and resolution actions.

**Tech Stack:** Node ≥ 22.18, TypeScript (type-stripping only, zero npm runtime deps), SQLite (`node:sqlite`).

**Spec:** `docs/superpowers/specs/2026-10-16-agentlens-design.md` (Section 5.3)

## Global Constraints

- Never modify user configuration files or run installation commands (strictly read-only).
- Zero external network calls (no external API calls or LLM prompts).
- Zero npm runtime dependencies.
- Tolerant of missing paths, malformed JSON, and unexpected config structures.
- Strict token counting rule: `tokens = Math.ceil(chars / 4)`.
- UI labels verbatim: `Tokens (measured)`, `API-equivalent cost (estimated)`, `Quota used (reported by agent)`.

## Review Focus

1. **Missing or unreadable config files:** Scanners must safely catch `ENOENT`, `EACCES`, or syntax errors without crashing the audit process.
2. **Safe TOML & JSON parsing:** Hand-crafted TOML parser for `config.toml` must handle comments, arbitrary whitespace, quoted keys, and sections without throwing.
3. **Usage correlation accuracy:** Correlating tool names like `mcp__serena__find_symbol` or `serena_find_symbol` with server name `serena` must handle prefix conventions correctly across all four agents.
4. **Idempotent audit runs:** Running `runAudit(db, home)` repeatedly must update existing records in `audit_items` and `findings` without duplicating rows or leaking memory.
5. **Empty projects & global-only scope:** An installation with no git repositories or projects must still audit global configs cleanly without null pointer exceptions.

---

### Task 1: Audit Data Model & Schema (`types.ts`, `db.ts`, `constants.ts`)

**Files:**
- Create: `src/audit/constants.ts`
- Modify: `src/types.ts`
- Modify: `src/db.ts`
- Test: `test/audit-db.test.ts`

**Interfaces:**
```typescript
export type AuditKind = 'instruction' | 'mcp' | 'skill' | 'plugin' | 'hook';
export type AuditStatus = 'active' | 'unused' | 'duplicate' | 'conflict';

export interface AuditItem {
  id: string;
  agent: Agent | 'all';
  projectId: number | null;
  kind: AuditKind;
  name: string;
  sourcePath: string;
  tokens: number;
  invocations30d: number;
  lastInvoked: number | null;
  status: AuditStatus;
  details: Record<string, any>;
  updatedAt: number;
}
```

- [ ] **Step 1: Write the failing test**

`test/audit-db.test.ts`:
1. Open memory DB, verify `audit_items` table exists.
2. Upsert audit items (instruction file, MCP server, skill).
3. Query audit items filtered by project and kind.
4. Update audit item on conflict (preserves ID, updates timestamp and status).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/audit-db.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement data model and db operations**

1. Create `src/audit/constants.ts` with:
   - `INSTRUCTION_OVERHEAD_THRESHOLD = 4_000; // tokens`
   - `UNUSED_WINDOW_MS = 30 * 86_400_000; // 30 days`
   - `CHARS_PER_TOKEN = 4;`
2. Update `src/types.ts` with `AuditKind`, `AuditStatus`, `AuditItem`.
3. Update `src/db.ts` with:
   - `audit_items` table schema and indexes.
   - `upsertAuditItems(db: DB, items: AuditItem[]): void`.
   - `getAuditItems(db: DB, filter?: { projectId?: number; kind?: AuditKind; status?: AuditStatus }): AuditItem[]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/audit-db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/db.ts src/audit/constants.ts test/audit-db.test.ts
git commit -m "feat: add audit_items schema and database queries for M4"
```

---

### Task 2: Config Scanners (`instruction.ts`, `mcp.ts`, `skill.ts`)

**Files:**
- Create: `src/audit/scanners/instruction.ts`
- Create: `src/audit/scanners/mcp.ts`
- Create: `src/audit/scanners/skill.ts`
- Test: `test/audit-scanners.test.ts`

**Interfaces:**
- `scanInstructions(home: string, projects: { id: number; root: string; name: string }[]): RawConfigItem[]`
- `scanMcp(home: string, projects: { id: number; root: string; name: string }[]): RawConfigItem[]`
- `scanSkills(home: string, projects: { id: number; root: string; name: string }[]): RawConfigItem[]`
- Safe parser for `config.toml` that extracts `[mcp_servers.<name>]`.

- [ ] **Step 1: Write the failing test**

`test/audit-scanners.test.ts`:
1. Mock directory structure with `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude.json`, `config.toml`, `opencode.json`, and skills folders.
2. Verify `scanInstructions` finds global and project instruction files and calculates token length (`chars / 4`).
3. Verify `scanMcp` extracts servers from Claude `.claude.json`, Codex `config.toml`, OpenCode `opencode.json`, and Antigravity directory.
4. Verify `scanSkills` discovers skills in `~/.claude/skills/`, `~/.codex/skills/`, and `~/.gemini/config/skills/`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/audit-scanners.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement scanners**

Implement:
1. `src/audit/scanners/instruction.ts`: checks global `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`, `~/.gemini/GEMINI.md`, and project roots.
2. `src/audit/scanners/mcp.ts`: parses JSON configs and TOML `[mcp_servers.<name>]` safely.
3. `src/audit/scanners/skill.ts`: traverses skill directories looking for `SKILL.md`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/audit-scanners.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/audit/scanners/instruction.ts src/audit/scanners/mcp.ts src/audit/scanners/skill.ts test/audit-scanners.test.ts
git commit -m "feat: implement config scanners for instructions, MCPs, and skills"
```

---

### Task 3: Audit Analyzers & Runner (`overhead.ts`, `usage.ts`, `duplicates.ts`, `conflicts.ts`, `runner.ts`)

**Files:**
- Create: `src/audit/overhead.ts`
- Create: `src/audit/usage.ts`
- Create: `src/audit/duplicates.ts`
- Create: `src/audit/conflicts.ts`
- Create: `src/audit/runner.ts`
- Test: `test/audit-runner.test.ts`

**Interfaces:**
- `calculateOverhead`: computes fixed tokens per session, estimates weekly token tax based on project session frequency. Emits `instruction_bloat` finding if tokens > 4,000.
- `correlateUsage`: queries SQLite `events` for tool activity in last 30 days and Claude `skillUsage`. Flags `status = 'unused'` if 0 invocations. Emits `unused_config` finding.
- `detectDuplicates`: identifies same skill or MCP configured in multiple places or identical content hashes. Flags `status = 'duplicate'`. Emits `duplicate_config` finding.
- `detectConflicts`: checks instruction files for package manager discrepancies (`npm` vs `yarn` vs `pnpm`) in the same project. Flags `status = 'conflict'`. Emits `config_conflict` finding.
- `runAudit(db: DB, home?: string): { items: AuditItem[]; findings: Finding[] }`: coordinates scanners and analyzers, upserts items and findings into db.

- [ ] **Step 1: Write the failing test**

`test/audit-runner.test.ts`:
1. Fixed overhead: instruction file of 24,000 chars (6,000 tokens) on project with 5 sessions/week -> triggers `instruction_bloat` finding.
2. Unused config: MCP server configured in `.claude.json` with 0 invocations in 30 days -> flags `unused` and emits `unused_config` finding.
3. Duplicates: `diagnose-crash` skill present in both Claude and Codex -> flags `duplicate` and emits `duplicate_config` finding.
4. Conflicts: `CLAUDE.md` specifies `npm install` and `AGENTS.md` specifies `pnpm install` in same project -> flags `conflict` and emits `config_conflict` finding.
5. End-to-end `runAudit` populates database and returns consistent summary.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/audit-runner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement analyzers and runner**

Implement `overhead.ts`, `usage.ts`, `duplicates.ts`, `conflicts.ts`, and `runner.ts`. Update `src/recommend.ts` to generate recommendations for `instruction_bloat`, `unused_config`, `duplicate_config`, and `config_conflict`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/audit-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/audit/*.ts test/audit-runner.test.ts
git commit -m "feat: implement audit analyzers for overhead, unused configs, duplicates, and conflicts"
```

---

### Task 4: Recommendations Synthesis, REST API, & CLI (`recommend.ts`, `server.ts`, `cli.ts`)

**Files:**
- Modify: `src/recommend.ts`
- Modify: `src/server.ts`
- Modify: `src/cli.ts`
- Test: `test/api-audit.test.ts`

**Interfaces:**
- `GET /api/audit`: returns `{ items: AuditItem[]; summary: { totalTokens: number; totalWeeklyWaste: number; unusedCount: number; duplicateCount: number; conflictCount: number } }`.
- `agentlens audit [--project <path>]`: CLI command printing ANSI/ASCII tables of overhead, unused tools, duplicates, and conflicts.

- [ ] **Step 1: Write the failing test**

`test/api-audit.test.ts`:
1. Test `GET /api/audit` returns summary and items.
2. Test `GET /api/audit?project=1` filters by project.
3. Test `agentlens audit` CLI prints output cleanly without throwing.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --test test/api-audit.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement API endpoint and CLI command**

1. In `src/server.ts`: add `GET /api/audit` route.
2. In `src/cli.ts`: add `audit` subcommand supporting `--project` filter.
3. In `src/recommend.ts`: handle audit rules with actionSnippets (e.g. `'claude mcp remove <name>'`, `'rm -r ~/.claude/skills/<name>'`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --test test/api-audit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/cli.ts src/recommend.ts test/api-audit.test.ts
git commit -m "feat: add /api/audit endpoint and agentlens audit CLI command"
```

---

### Task 5: Dashboard UI (Config Audit Tab) (`index.html`, `app.js`, `style.css`)

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/style.css`

**Interfaces:**
- Nav bar: `<a href="#/audit">Config Audit</a>`.
- Summary Tiles:
  - "Per-Session Fixed Overhead" (e.g. `~5.2k tokens`).
  - "Configured Tools & MCPs" (count).
  - "Unused in 30 Days" (count).
  - "Duplicates & Conflicts" (count).
- Tabulated Sections:
  1. Always-Loaded Instruction Files (Path, Agent, Tokens, Weekly Tax).
  2. MCP Servers & Plugins (Name, Agent, Source, 30d Invocations, Status).
  3. Skills (Name, Agent, Path, 30d Invocations, Status).
  4. Duplicates & Conflicting Instructions (with resolution suggestions).

- [ ] **Step 1: Add HTML navigation and styles**

In `web/index.html`, add `<a href="#/audit">Config Audit</a>` to nav.
In `web/style.css`, add styles for audit inventory tables and status pills (`active`, `unused`, `duplicate`, `conflict`).

- [ ] **Step 2: Implement auditPage in `web/app.js`**

Implement route `#/audit`, fetch `/api/audit`, render summary tiles and section tables, respecting the global project filter.

- [ ] **Step 3: Verify syntax and live execution**

Run: `node --check web/app.js && npm run typecheck && npm test`
Run: `node src/cli.ts audit` on real user setup to verify rich output.

- [ ] **Step 4: Commit**

```bash
git add web/index.html web/app.js web/style.css
git commit -m "feat: add Config Audit page to dashboard UI"
```
