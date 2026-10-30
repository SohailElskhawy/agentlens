# Contributing to agentlens 🔍

Thank you for your interest in contributing to **agentlens**! We welcome contributions from the community to help developers optimize their AI agent workflows, reduce token waste, and keep their coding costs and quotas under control.

---

## 🧭 Core Architectural Principles

Before writing code, please keep these non-negotiable principles in mind:

1. **Zero Runtime Dependencies:**
   - The production code in `src/` and `web/` relies **exclusively** on native Node.js standard libraries (`node:sqlite`, `node:fs`, `node:path`, `node:crypto`, `node:http`, `node:os`).
   - Do **not** add runtime npm dependencies to `package.json`.
   - Node ≥ 22.18 provides built-in type-stripping and native SQLite.

2. **Strictly Read-Only on Agent Files:**
   - `agentlens` never writes to, modifies, or deletes agent configuration files, history files, or session logs.
   - All agent files and databases are opened strictly read-only (`mode=ro`).

3. **Privacy First (No Prompt/Output Storage):**
   - Full prompt texts and tool outputs are **never** stored in the database.
   - Only byte lengths and SHA-256 hashes are recorded for repetition and loop detection.

4. **Deterministic & Lightweight (AI is optional and separate):**
   - Analyzers must be deterministic, transparent, and fast.
   - Background monitoring must consume minimal CPU/memory (systemd default `MemoryMax=200M`, `Nice=10`) and zero agent token budget.
   - AI features live in `src/ai/`, are off unless `ai_enabled` is `true` (independent of `allow_agent_launch`), and never run from ingest, `serve`, or any background path. They send redacted data only, preview the exact prompt (with its confirmation hash) before every send, require that hash to be confirmed for every new external call, cache only validated output, cap calls per day, and never write or alter deterministic findings, scores, IDs, or recommendations.
   - Tests must inject a fake runner: never spawn a real agent CLI or touch the network.

---

## 🛠 Local Development Setup

### Prerequisites
- Linux OS (Ubuntu, Debian, Fedora, Arch, etc.)
- Node.js ≥ 22.18
- Git

### Clone & Install
```bash
git clone https://github.com/SohailElskhawy/agentlens.git
cd agentlens

# Install devDependencies (TypeScript for typechecking)
npm install
```

### Running Tests & Typechecks
We require all tests and typechecks to pass without warnings before merging:

```bash
# Run the test suite
npm test

# Run TypeScript typechecker
npm run typecheck

# Check dashboard JavaScript syntax
node --check web/app.js
```

### Running Locally
```bash
# Test one-shot ingestion from local agent logs
npm run start -- ingest

# Run the local server and web dashboard
npm start

# Open http://127.0.0.1:4711
```

---

## 🧩 Extending agentlens

### 1. Adding or Improving an Agent Adapter (`src/adapters/`)

Each agent adapter implements the `Adapter` interface (`src/types.ts`), exported as a named object in `src/ingest.ts`:

```ts
export interface Adapter {
  agent: Agent;
  root(home: string): string;          // directory to watch
  discover(root: string): string[];    // absolute file paths to ingest
  read(path: string, cursor: Cursor): ReadResult;
}
```

- Adapters read incrementally using the byte-offset `cursor` and return the new `offset` in `ReadResult.cursor`.
- Handle malformed, missing, or partial log lines gracefully; count them in `ReadResult.errors` / `skipped` instead of throwing.
- Normalize events into `NormalizedEvent` records (`agent`, `id`, `sessionId`, `ts`, `kind`, `model`, `input`, `output`, `cacheRead`, `cacheWrite`).
- Return quota observations (where the agent reports them, e.g. Codex) as `QuotaSnapshot[]` in `ReadResult.quotas`.

### 2. Adding a Workflow Waste Detector (`src/analyze/`)

Waste detectors identify patterns that unnecessarily consume tokens:

- Place new detectors in `src/analyze/<detector_name>.ts`.
- Detectors inspect database events for a session or project and return `Finding` records.
- Findings must include:
  - `rule`: unique detector name.
  - `confidence`: `'high' | 'medium' | 'low'`.
  - `estTokensWeek`: estimated weekly token waste.
  - `evidence`: JSON object containing hashes, counts, and metadata (no raw prompt/code text).
- Register the detector in `src/analyze/runner.ts` and add unit tests in `test/findings-db.test.ts` or a dedicated test file.

### 3. Adding to the Curated Catalog (`catalog.yaml`)

We curate vetted, privacy-respecting open source tools that solve specific waste patterns:

```yaml
- id: "tool-id"
  name: "Tool Display Name"
  kind: "tool" # 'mcp' | 'skill' | 'plugin' | 'tool'
  description: "Clear explanation of how it saves tokens."
  url: "https://github.com/org/repo"
  targetRules: ["hot_files", "retry_loop"]
  estSavingsPct: 25
  recommendedAction: "add"
  installCommand: "npx tool-id"
  safeToSuggest: true
```

*Note: Update both `catalog.yaml` and `catalog.json` when modifying catalog items.*

---

## 🤝 Submitting a Pull Request

1. **Fork and branch**: Create a descriptive branch name (e.g. `feat/gemini-cli-adapter`, `fix/report-export`).
2. **Write tests**: Every new feature or bugfix must include automated tests in `test/`.
3. **Verify**:
   ```bash
   npm test && npm run typecheck && node --check web/app.js
   ```
4. **Clean commit messages**: Write concise, conventional commit messages (`feat: ...`, `fix: ...`, `docs: ...`).
5. **Open a PR**: Describe what changed, the motivation, and evidence of test verification.

---

## 📄 License

By contributing to agentlens, you agree that your contributions will be licensed under the [MIT License](LICENSE).
