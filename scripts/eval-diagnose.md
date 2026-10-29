# Diagnosis evaluation

Create a private evaluation directory, put a separately created, migrated SQLite snapshot in it, and create an output directory inside it. The snapshot and output directory must both exist. The harness opens the snapshot read-only and keeps the working database in memory; it copies the snapshot's schema and only diagnosis data, AI call/cache records, and the three AI configuration settings. It never enables AI in the snapshot. The output directory should be private because the preview contains structured session metadata.

Run the preview (no model call):

```sh
node scripts/eval-diagnose.ts /path/to/eval /path/to/eval/snapshot.db /path/to/eval/output
```

Review `output/preview.json`: it lists the ten sessions with the largest summed finding estimates (ties by session ID), each command's non-prompt arguments, the structured metadata sent, and hashes binding the full diagnosis previews. Fewer than ten eligible sessions or an invalid preview stops the run. After reviewing all ten, pass the exact manifest hash printed by the command:

```sh
AGENTLENS_EVAL_AI=1 node scripts/eval-diagnose.ts /path/to/eval /path/to/eval/snapshot.db /path/to/eval/output REVIEWED_MANIFEST_HASH
```

The hash is recomputed before any call, so changes to the selected sessions, metadata, model or commands require a new review. Execution uses the existing diagnosis consent, cache, validation and daily cap. The temporary copy retains the snapshot's cap and prior call/cache records; it does not persist new calls across runs. Avoid rerunning the evaluation unless intended. `results.json` is rewritten atomically after each completed session with `complete: false`, so a hard stop keeps finished calls; `complete: true` appears only after all ten, and `results.md` is written only then. Per-session failures, including cap failures, appear in both; the command exits nonzero if any session fails. All estimates are unverified AI output, not measured savings. External judging is a separate step.

Use only a verified first-party Claude subscription login. Remove Anthropic API keys, auth tokens, OAuth environment tokens and base URL overrides before execution. The harness checks common override variables but cannot verify the CLI's account or all external configuration. Tests inject a fake runner and never invoke a model.
