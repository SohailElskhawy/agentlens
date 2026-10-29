# Opt-in AI analysis

agentlens is deterministic by default. The AI analyst is an optional extra that explains structured session waste signals and enriches recommendations. It is **off** until you enable it and it never runs automatically (not on ingest, `serve`, or any schedule).

Currently implemented: session diagnosis, anomaly explanation, and recommendation enrichment through the **Claude Code CLI (`claude`) only**. Other `ai_agent` values are
accepted as settings but fail closed before anything is launched, because their CLIs cannot be reliably started without
user hooks, plugins, and tools. Excerpt-based analysis is not implemented. The dashboard offers session diagnosis and anomaly explanation (see below).

## Commands

| Command | What it does |
| --- | --- |
| `agentlens ai [status] [--json]` | Show whether AI is enabled, provider, model, and calls used today |
| `agentlens ai enable` / `disable` | Set `ai_enabled` (opt in or out) |
| `agentlens ai preview <diagnose\|session> <id>` | Print the exact JSON preview (prompt, command, `inputHash`, `confirmationHash`). Read-only, works while AI is off, never counts against the cap |
| `agentlens recommend [--ai] [--preview] [--confirm <hash>]` | Show deterministic recommendations, optionally with AI enrichment; preview works while disabled |
| `agentlens explain anomaly <YYYY-MM-DD> <project> [--agent <agent>] [--preview] [--confirm <hash>] [--json]` | Explain a detected local-calendar spike; project is a name or numeric ID |
| `agentlens diagnose <session-id> [--json] [--preview] [--confirm <hash>]` | Diagnose one session |
| `agentlens diagnose --worst <N> [--project <path>] [...]` | Diagnose the N sessions with the largest summed finding estimates (1-99; ties by session id; `--project` matches the project root like `savings --project`) |

`--worst` needs one `--confirm <hash>` per session; repeat the flag. Each session is confirmed on its own: `--preview`
prints every session's hash, and a session without a matching hash is previewed again and skipped.

Exit codes are non-zero for bad arguments, an unknown session, disabled or invalid AI settings, an unsupported
provider, the daily cap, a missing or stale confirmation, a failed run, and output that fails schema validation.

## Dashboard and HTTP API

When AI is enabled, a session's detail page shows **Explain with AI**. It opens a preview panel with the exact prompt,
provider and model; nothing is sent until you press **Send to claude**. Cached results open directly.

`POST /api/ai/diagnose` takes `{"sessionId": "...", "confirm": "<confirmationHash>"}` (loopback only, 16 KB body cap,
cross-origin requests rejected). Without a matching `confirm` it returns `200 {"status":"confirmation_required","preview":{agent,model,prompt,confirmationHash}}`;
with one (or a cached result) `200 {"status":"ok","cached":bool,"diagnosis":{...}}`. Errors carry `{error, code}`:
403 disabled or invalid settings, 404 unknown session, 422 unsupported provider, 429 daily cap, 502 failed run or invalid output.

`GET /api/recommendations?ai=1` adds validated cached enrichment for the first five unfiltered recommendations (then merges them into any filtered results) when AI is enabled;
it never starts a runner or reserves a call. Without `ai=1`, the response remains deterministic. `POST /api/ai/recommendations`
accepts `{}`, `{"preview":true}`, or `{"confirm":"<confirmationHash>"}`. It uses the same loopback Origin guard and 16 KB
byte cap as diagnosis. It returns deterministic `recommendations` with `confirmation_required` and the exact command and prompt
for an uncached request; a matching confirmation executes, and a cache hit returns `ok` without another call. Errors return
`status`, `code`, `message`, and the deterministic recommendations. Explicit preview also works while AI is disabled.

### Anomaly explanations

`agentlens explain anomaly 2026-10-20 my-project --preview` shows the exact command, prompt, and hash, even while AI is disabled. Enable AI and repeat with `--confirm HASH` to send; use `--json` for machine-readable output. If a project name or ID has spikes for multiple agents, add `--agent claude` (or the matching agent); use a numeric project ID to disambiguate duplicate names. The literal `null` selects events without a project. Invalid or future dates and dates without a detected spike fail. Historical dates are evaluated through the end of the local calendar day; today is evaluated through the current instant. A changed spike or contributor digest requires a fresh confirmation.

Overview shows the deterministic spike list whether or not AI is enabled, and offers **Explain with AI** only when enabled. `POST /api/ai/explain` accepts `{"date":"YYYY-MM-DD","project":"name or ID","agent":"optional agent","confirm":"optional hash"}`. It has a 16,384-byte request limit and the same loopback Origin guard as diagnosis. A cache miss without the exact hash returns `confirmation_required` with `{agent, model, prompt, confirmationHash}`; a successful or cached result returns `{status:"ok", cached, explanation}`. Errors use `{error, code}` with 400 for invalid input/date, 404 for no matching spike, 409 for ambiguous selection, 403 for disabled/invalid settings, 422 for an unsupported provider, 429 for the cap, and 502 for runner or output failure.

The prompt contains the spike's day, project ID, agent, token total, baseline median, sample count, ratio, and bounded structured digests of its top contributing sessions. It excludes raw prompts, instruction bodies, file paths, session IDs, and arbitrary files. Redaction is applied and the prompt remains valid JSON data under 12,000 characters by dropping detail as needed. Only a bounded, non-empty single-paragraph JSON explanation is cached. The explanation is a model interpretation of limited metadata, not proof of a cause; it does not alter the deterministic anomalies, scores, findings, or recommendations.

## Settings

Stored in the local SQLite settings table; change `ai_enabled` with `ai enable|disable` and the others through the
loopback dashboard's `POST /api/settings` (`{"key": "ai_model", "value": "..."}`). Invalid values are rejected and
invalid stored values fail closed.

| Key | Default | Meaning |
| --- | --- | --- |
| `ai_enabled` | `false` | Must be exactly `true`. `allow_agent_launch` does not enable AI |
| `ai_agent` | `auto` | `auto` resolves to `claude`; other providers are unsupported today |
| `ai_model` | empty | Optional `--model` passed to the CLI |
| `ai_max_calls_per_day` | `20` | Local-midnight cap. Failed attempts, including failed capability checks, count; cache hits and previews do not |

## Preview and confirmation

Every new external call is bound to a preview. `confirmationHash` is a SHA-256 of the exact command (which contains the
full prompt), provider, and model, with no timestamps or temp paths. Run `--preview`, read the prompt, then pass that hash
to `--confirm`. If the session data, provider, or model changed, the hash no longer matches: no call is reserved or
started and a fresh preview is shown instead. `inputHash` (hash of the redacted prompt) is separate: it only identifies
the cache entry and call-log row.

## What is sent, and where

- For diagnosis, a redacted, structured digest: finding rule names and estimates, tool names, call counts and byte sizes, token totals,
  and the first turns' token counts and model names. No prompt text, tool output, source code, session IDs, or paths.
  Secrets, emails, and home paths are redacted from the payload, which is capped at 12,000 characters.
- Before each uncached diagnosis, agentlens runs a local, prompt-free `claude --help` capability check with the same isolation controls, in a fresh temporary directory. It requires help to advertise print, output format, no session persistence, safe mode, restricted mode, strict MCP configuration, disabled slash commands, and tool selection. Missing or broken help fails closed with upgrade guidance; no prompt is sent. The check does not initialize hooks, plugins, or skills.
- Once the check passes, agentlens runs `claude -p ...` with hooks, plugins, MCP, slash commands, and tools disabled in that directory.
- Recommendation enrichment sends bounded, redacted baseline recommendation text and whitelisted finding evidence, plus project dependency and script names and instruction headings when available. It reads only regular project files up to 64 KB each, and sends no instruction bodies or package values. The prompt is capped at 12,000 characters by dropping lower-ranked recommendations; the default is five and the maximum is twenty.
- That CLI authenticates with whatever provider, account, or subscription **you** configured for it, and the prompt goes to
  that provider. Using it consumes that account's quota or billing and the data leaves your machine. agentlens does not
  use any API key of its own, and enabling AI means egress is no longer purely local.

## Caps and cache

- The daily cap reserves a call in the local `ai_calls` table before the CLI starts and records the result afterwards. It
  stores metadata only (kind, provider, hash, time, outcome, duration), never prompts or output.
- Diagnosis output that validates as JSON `{summary, causes[{cause, evidence, est_tokens}], fixes[{action, where, snippet}]}`
  (plain or in a code fence, bounded in size and length) is cached in `ai_notes`, keyed by kind, `inputHash`, provider, and
  model. Failures, malformed output, and runner errors are never cached.
- Recommendation output must be a bounded JSON array of unique input IDs with `aiBody` and/or `aiActionSnippet` strings. Unknown IDs, duplicate IDs, malformed or oversized output are rejected. Enrichment is stored separately in `ai_notes`; original IDs, scores, body and action snippet are never changed.
- A cached, validated result can be read again with no confirmation, no new reservation, and even when the daily cap is
  reached, but only while AI is enabled with valid settings. Disabled or invalid settings block cached reads too.
- Error messages never include the command, prompt, or model output.

## What the output means

The diagnosis is an AI explanation of structured data. Its `est_tokens` figures are unverified model estimates, not
measurements and not realized results. It never creates or changes findings, scores, IDs, or recommendations.

## Local CLI evidence

Sanitized help-only check: Claude Code `2.1.312` reports `--print`, `--output-format`, `--no-session-persistence`, `--safe-mode`, `--restricted`, `--strict-mcp-config`, `--disable-slash-commands`, and `--tools`. The check passed these isolation flags to `--help`; no model was invoked.

## Instruction rewrite

`agentlens optimize /path/to/AGENTS.md --ai --preview` displays the exact redacted prompt and confirmation hash. After reviewing it, enable AI and run `agentlens optimize /path/to/AGENTS.md --ai --confirm HASH` to request a candidate and display its diff. Add `--apply` to write an accepted candidate and create `AGENTS.md.bak`; an existing backup is never overwritten. `CLAUDE.md` is also supported. A directory is accepted only when it contains exactly one readable supported file. The AI path does not run the ordinary workspace optimization. Without `--ai`, ordinary optimization is unchanged.

Instruction text is sent to the configured provider only on an explicit AI request with AI enabled and the exact confirmation for the current file, prompt, command, provider, and model. The preview can be shown while AI is disabled. Redaction is pattern-based and cannot guarantee removal of every secret; review the entire prompt before confirming. The input must be a regular, non-symlink file at most 10,000 bytes, and the complete prompt is limited to 12,000 characters. A changed file invalidates the confirmation even if the redacted text looks the same. Valid cached selections can be reused without another confirmation or call while AI remains enabled; selected cut IDs are stored in the local AI cache.

The model selects from locally detected duplicate-line and stale-path cuts; it cannot rewrite or add text. The trimmer compares only the target and its sibling `CLAUDE.md` or `AGENTS.md` in the same directory. The target and sibling reads are bounded to regular, non-symlink files of at most 10,000 bytes; unreadable siblings are ignored. Headings and fenced code are never offered, nor are long-code-block or conflicting-command cuts. The candidate is built locally from the original file, so redacted text remains intact unless its line was explicitly selected as an eligible cut. Duplicate and stale-path flags are heuristics, not proof that a line is dispensable: review the prompt and diff before applying. At least one eligible cut and a potential 10% estimated token saving are required before making a request, and the selected cuts must also meet that threshold. Blank lines alone never trigger a call. The diff is a whole-file unified diff that `git apply` accepts. Invalid selections are rejected and not cached. Agent output is treated as data and never executed. The file is checked again before writing; a backup created during a failed race check is retained for inspection.
