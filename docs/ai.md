# Opt-in AI diagnosis

agentlens is deterministic by default. The AI analyst is an optional extra that explains one session's structured waste
signals. It is **off** until you enable it and it never runs automatically (not on ingest, `serve`, or any schedule).

Currently implemented: session diagnosis through the **Claude Code CLI (`claude`) only**. Other `ai_agent` values are
accepted as settings but fail closed before anything is launched, because their CLIs cannot be reliably started without
user hooks, plugins, and tools. Excerpt-based analysis is not implemented. The dashboard offers the same flow (see below).

## Commands

| Command | What it does |
| --- | --- |
| `agentlens ai [status] [--json]` | Show whether AI is enabled, provider, model, and calls used today |
| `agentlens ai enable` / `disable` | Set `ai_enabled` (opt in or out) |
| `agentlens ai preview <diagnose\|session> <id>` | Print the exact JSON preview (prompt, command, `inputHash`, `confirmationHash`). Read-only, works while AI is off, never counts against the cap |
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

## Settings

Stored in the local SQLite settings table; change `ai_enabled` with `ai enable|disable` and the others through the
loopback dashboard's `POST /api/settings` (`{"key": "ai_model", "value": "..."}`). Invalid values are rejected and
invalid stored values fail closed.

| Key | Default | Meaning |
| --- | --- | --- |
| `ai_enabled` | `false` | Must be exactly `true`. `allow_agent_launch` does not enable AI |
| `ai_agent` | `auto` | `auto` resolves to `claude`; other providers are unsupported today |
| `ai_model` | empty | Optional `--model` passed to the CLI |
| `ai_max_calls_per_day` | `20` | Local-midnight cap. Failed attempts count; cache hits and previews do not |

## Preview and confirmation

Every new external call is bound to a preview. `confirmationHash` is a SHA-256 of the exact command (which contains the
full prompt), provider, and model, with no timestamps or temp paths. Run `--preview`, read the prompt, then pass that hash
to `--confirm`. If the session data, provider, or model changed, the hash no longer matches: no call is reserved or
started and a fresh preview is shown instead. `inputHash` (hash of the redacted prompt) is separate: it only identifies
the cache entry and call-log row.

## What is sent, and where

- A redacted, structured digest: finding rule names and estimates, tool names, call counts and byte sizes, token totals,
  and the first turns' token counts and model names. No prompt text, tool output, source code, session IDs, or paths.
  Secrets, emails, and home paths are redacted from the payload, which is capped at 12,000 characters.
- agentlens runs `claude -p ...` with hooks, plugins, MCP, slash commands, and tools disabled, in a fresh temporary directory.
- That CLI authenticates with whatever provider, account, or subscription **you** configured for it, and the prompt goes to
  that provider. Using it consumes that account's quota or billing and the data leaves your machine. agentlens does not
  use any API key of its own, and enabling AI means egress is no longer purely local.

## Caps and cache

- The daily cap reserves a call in the local `ai_calls` table before the CLI starts and records the result afterwards. It
  stores metadata only (kind, provider, hash, time, outcome, duration), never prompts or output.
- Only output that validates as JSON `{summary, causes[{cause, evidence, est_tokens}], fixes[{action, where, snippet}]}`
  (plain or in a code fence, bounded in size and length) is cached in `ai_notes`, keyed by kind, `inputHash`, provider, and
  model. Failures, malformed output, and runner errors are never cached.
- A cached, validated result can be read again with no confirmation, no new reservation, and even when the daily cap is
  reached, but only while AI is enabled with valid settings. Disabled or invalid settings block cached reads too.
- Error messages never include the command, prompt, or model output.

## What the output means

The diagnosis is an AI explanation of structured data. Its `est_tokens` figures are unverified model estimates, not
measurements and not realized results. It never creates or changes findings, scores, IDs, or recommendations.
