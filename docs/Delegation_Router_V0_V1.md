# Delegation Router V0/V1

Delegation Router is an experimental, disabled-by-default optimization for reducing bulk file context in a primary coding agent. V0 records privacy-bounded tool observations. V1 adds one operation, `bulk_read`, which asks a configured existing Execution Profile to identify relevant ranges in one file. The primary agent remains responsible for targeted reads and all implementation decisions.

## Architecture

Headless Todo implementation and rework launches receive an immutable, persisted parent execution identity plus `AIKOMBINAT_DELEGATION_DEPTH=0`. Claude and Codex receive an execution-local, least-privilege MCP connection that exposes only `bulk_read`. A short-lived capability maps hook and MCP requests to the persisted parent work directory and execution snapshot; neither tool accepts a workspace root, parent ID, provider, or model from the model.

Each delegation performs bounded immediate admission through the existing Model Catalog, Execution Profile, `ExecutorPool`, and `ProviderQuotaService`. One request starts one read-only worker process with `AIKOMBINAT_DELEGATION_DEPTH=1`; no Delegation MCP is injected into the worker. The resolved provider/model/`effectiveModel`/effort snapshot is persisted once and reused for launch. There is no second scheduler and no persistent worker pool.

## Settings and rollout modes

Settings → Delegation contains explicit enablement, mode, worker Execution Profile, file thresholds, timeout, hook controls, and compact statistics. Enabling the feature warns that the selected file content is sent to the provider represented by the worker profile.

- `telemetry` observes supported tool calls and never blocks them.
- `suggest` adds guidance for a large Claude full-file `Read` while allowing it.
- `enforce_bulk_read` may deny only a confidently identified large Claude full-file `Read` when a worker route is immediately healthy. Targeted reads remain allowed. Missing context, server failure, an unconfigured worker, exhausted/busy candidates, or temporary fallback always fail open.

Existing installations remain disabled after upgrade. Telemetry is the recommended first enabled mode.

## Provider hooks

The managed installer adds one user-level AIKombinat `PreToolUse` entry, preserves unrelated settings and hooks, writes atomically, creates a backup before the first mutation, and refuses malformed configuration. Removing a hook removes only the managed entry. The bridge exits immediately outside an AIKombinat execution and never receives prompts, file contents, provider credentials, or the general administrative MCP token.

Claude uses its native user `settings.json` hook representation. `installed_unverified` means the file contains the managed entry; `verified` means the server observed a real hook event. Codex supports a separate `hooks.json`; if the same config layer already uses inline hooks, AIKombinat reports `manual_action_required` rather than creating a competing representation. Codex hook definitions may require manual trust. AIKombinat reports `needs_trust` separately and never passes `--dangerously-bypass-hook-trust`.

## `bulk_read` contract

Model input is limited to:

```json
{ "path": "relative/or/contained/absolute/file.ts", "query": "focused question", "max_ranges": 8 }
```

The server resolves and realpaths the file against the persisted parent work directory, requires a regular UTF-8 text file, rejects traversal and external symlink escapes, and enforces byte/line limits. `.env` variants, credentials, private/SSH keys, `.git` internals, and AIKombinat authentication/configuration secrets are refused and are never sent to the worker.

Before launch, the server records size, line count, and SHA-256. It rechecks identity after the worker returns; a changed file produces `stale` and no old ranges. Source content is delimited as untrusted data in the worker prompt. Worker JSON is validated for schema, bounds, range count, total lines, and bounded strings. Overlaps are merged. Anchor snippets are extracted from the current real file by the server, never copied from worker prose.

`no_match` means only that the worker identified no ranges; it is not proof that the file is irrelevant. Infrastructure failures, invalid structured output, timeout, and `no_match` grant one direct full-read fallback for the same parent, canonical file, and file hash for 60 seconds. Sensitive or outside-workspace refusals do not grant fallback.

## Lifecycle and recovery

Delegation runs persist `starting`, `running`, `completed`, `failed`, `cancelled`, or `recovery_required` state with PID and process identity. A running or unresolved worker consumes provider capacity. Parent Stop cancels the worker; ownership is released only after confirmed exit. Startup recovery never signals a PID on identity mismatch or unverifiable identity. A matching orphan is terminated because its original MCP caller no longer exists; an unverifiable process remains `recovery_required` and continues consuming capacity.

## Telemetry and privacy

Tool observations store parent execution/provider/model identity, tool and normalized operation, safe relative path and offsets, cheap file metadata, decision/reason, and hook latency. Shell observations store only a derived command kind, raw character length, and SHA-256—not command text. Delegation runs store file identity and sizes, bounded failure detail, the resolved worker snapshot, actual token usage only when a provider reports it, returned characters, and `context_avoided_chars = max(0, source_chars - returned_chars)`.

Normal telemetry never stores prompts, file contents, environment variables, raw shell commands, full provider output, or capabilities. Startup cleanup defaults to 30-day retention. Character reduction is labelled as characters; no parent-token savings are fabricated.

## Known V1 limitations

1. Claude `@file` references can bypass `PreToolUse Read`.
2. Codex may read through shell/unified exec; V1 records telemetry but does not attempt complete shell parsing or blocking.
3. Hooks are cost-optimization guardrails, not a sandbox security boundary.
4. Worker quality may miss implicit cross-file context.
5. `no_match` is not proof of absence.
6. One process per delegation adds startup latency.
7. Parent tokens saved are unknown unless a provider exposes sufficient real usage data.
8. A worker Execution Profile must be explicitly configured.
9. Non-managed Codex hooks may require manual trust.
10. V1 handles one file per `bulk_read`.

V2 large output/log routing, generic summarization, code generation, architecture/debugging/review delegation, adaptive cost routing, DAGs, and persistent workers are intentionally out of scope.
