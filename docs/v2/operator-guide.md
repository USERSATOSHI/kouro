# Local operator guide

Kouro v2 is a loopback-only workbench. `bun run dev` builds the client and starts
the Elysia host; `bun run kouro --help` lists headless commands. Keep the printed
pairing token private. State lives in `KOURO_DATA_DIR` (default `.kouro-data`).
Only one writable host may own that directory at a time.

## Inspect a run

Use Runs for the compiled graph, live timeline, invocation inspector, context,
tools, usage, logs, artifacts and Git diff. Selection is by concrete invocation,
not merely node name. The graph outline offers a keyboard-readable alternative.
The timeline uses durable timestamps; a running bar advances from wall time even
when no new event arrives. Provider-native context or usage that Kouro cannot see
is labeled unavailable, not zero.

The UI sends controls through the host API with run revision and idempotency key.
A stale revision is refused. Pause stops new admission but does not imply an
already claimed effect has stopped. Interrupt/cancel depend on harness capability;
the host never pretends a provider accepted an unsupported control.

## Workflow templates

The CLI bundles starter packages for `feature`, `refactor`, `chore`, `bugfix`,
`hotfix`, `feature-fusion`, and `refactor-fusion`. Create one in a project with:

```sh
kouro create template my-feature --template feature
```

This writes `.kouro/my-feature/manifest.json`, `kouro.ts`, `prompts/`, and
`schemas/schema.ts`. Kouro discovers those project packages at startup. Fusion
packages run multiple model-selected specialist agents in parallel, then pass
their outputs to a model-selected fusion agent for one canonical result. They do
not imply live agent-to-agent messaging.

## Recovery choices

| Situation | Safe operator action |
| --- | --- |
| Reserved effect, not claimed | Restart/resume; the journal may replay the reservation. |
| Claimed command or provider effect with uncertain outcome | Reconcile against the recorded operation and workspace before retrying. Do not assume it failed. |
| Pending human approval | Decide again against the current binding/revision; a fork requires fresh approval. |
| Failed invocation with a retry policy | Retry creates a new attempt of the same logical invocation. |
| Paused and drained Git-backed run | Capture a checkpoint, then fork an identical retained tree into distinct worktrees. |
| External side effect outside Git/workspace | Verify externally; a checkpoint is not a rewind or compensation mechanism. |

Checkpoint eligibility in the web UI lists the exact failed predicates. The
current materializer supports the validated same-bundle root-scope prefix path;
nested-scope reuse is refused rather than replayed incorrectly. Completed work
is inherited with source IDs, but approvals, provider sessions and delivery
authority are not copied. Changing captured dependencies invalidates reuse.
No live provider memory is transferable across forks.
Execution-profile and unexecuted-agent-prompt fork variants are allowed for new
work; inherited attempts retain their original provenance. The prompt target
must be a root-graph agent node that has not completed. Child display names are
metadata, not workflow input. At startup, SQLite checkpoint certificates restore
any retention marks missing after a capture crash before workspace cleanup is allowed.

## Back up and restore

The storage API exports a SQLite `VACUUM INTO` snapshot and exactly the immutable
blobs referenced by that database snapshot. `verifyBackup()` checks database
integrity, manifest closure and SHA-256 bytes. `restoreBackup()` refuses an
existing destination and verifies the restored copy. These functions are local
host APIs, not a remote backup service or a replacement for copying backups to
separate storage. Stop the host before using a restored directory as the active
`KOURO_DATA_DIR`; never overwrite a live directory in place.

## Development and evaluations

Developer tools validate schemas and render prompt fixtures without starting a
workflow. “Run prompt fixture” deliberately starts an ordinary run; open it to
inspect its attempt and context. Evaluation cells are also ordinary runs, with
experiment metadata and deterministic evidence distinguished from model or
human opinions. A blinded pairwise decision does not modify deterministic
acceptance evidence.

The scripted harness requires no model credentials. Codex/Pi availability and
native capabilities are discovered at runtime; a successful scripted exchange
is not proof of real-provider collaboration. A local Pi model completed a tiny
agent → command → complete run through the native RPC adapter, but a live
model-to-model collaboration exchange remains unverified.

For a Pi-backed run, set `KOURO_PI_MODEL` to the native model id and keep the
llama.cpp endpoint in `LLAMA_BASE_URL`. If the system Pi install is not writable
or has a provider patch applied in a user-owned copy, set `KOURO_PI_BIN` to that
executable; the adapter records provider/model identity but never treats missing
or all-zero provider telemetry as observed usage.
