# Delegation Router V0/V1

Delegation Router is an experimental, disabled-by-default optimization for reducing bulk file context in a primary coding agent. V0 records privacy-bounded tool observations. V1 adds one operation, `bulk_read`, which asks a configured existing Execution Profile to identify relevant ranges in one file. The primary agent remains responsible for targeted reads and all implementation decisions.

## Architecture

Headless Todo implementation and rework launches receive an immutable, persisted parent execution identity plus `AIKOMBINAT_DELEGATION_DEPTH=0`. Claude and Codex receive an execution-local, least-privilege MCP connection that exposes only `bulk_read`. A short-lived capability maps hook and MCP requests to the persisted parent work directory and execution snapshot; neither tool accepts a workspace root, parent ID, provider, or model from the model.

Each delegation performs bounded immediate admission through the existing Model Catalog, Execution Profile, `ExecutorPool`, and `ProviderQuotaService`. Worker eligibility requires both an AI provider and a proven V1 isolation capability; unsupported candidates and `raw-shell` are skipped even if a saved profile is changed after Delegation settings are saved. One request starts one tool-less worker process with `AIKOMBINAT_DELEGATION_DEPTH=1`; source data and the query arrive only through the prompt, the current repository is not the worker root, and no Delegation MCP is injected into the worker. The resolved provider/model/`effectiveModel`/effort snapshot is persisted once and reused for launch. There is no second scheduler and no persistent worker pool.

### V1 worker provider support

| Provider | Primary hook | V1 worker | Isolation strategy | Real smoke |
|---|---:|---:|---|---|
| Claude | yes | supported | Tool-less `--tools ""`, empty worker-only strict MCP config, disabled filesystem setting sources, disposable scratch cwd | NOT RUN |
| Codex | yes | unsupported | `--sandbox read-only` does not prove tool-less or scratch-only host reads | UNSUPPORTED |
| Antigravity | n/a for V1 primary hook | unsupported | `--sandbox` documents terminal restrictions, not a tool-less or scratch-only read boundary | UNSUPPORTED |

Claude's worker-only strict MCP configuration does not change primary Claude execution: primary MCP injection remains additive and never adds `--strict-mcp-config`. The capability decision follows the documented [Claude tool availability contract](https://code.claude.com/docs/en/cli-reference), [Codex sandbox configuration](https://developers.openai.com/codex/config-reference), and captured Antigravity CLI help. Unsupported providers remain available for ordinary primary execution.

Provider transport decoding stays at the CLI adapter edge. Antigravity's `SUCCESS`/failure stream envelope is decoded before `bulk_read` validates the worker JSON; Claude result events are normalized by its adapter path, and core `bulk_read` parses only the resulting structured payload.

## Settings and rollout modes

Settings → Delegation contains explicit enablement, mode, worker Execution Profile, file thresholds, timeout, hook controls, and compact statistics. Enabling the feature warns that the selected file content is sent to the provider represented by the worker profile.

- `telemetry` observes supported tool calls and never blocks them.
- `suggest` adds guidance for a large Claude full-file `Read` while allowing it.
- `enforce_bulk_read` may deny only a confidently identified large Claude full-file `Read` when a worker route is immediately healthy. Targeted reads remain allowed. Missing context, server failure, an unconfigured worker, exhausted/busy candidates, or temporary fallback always fail open.

Existing installations remain disabled after upgrade. Telemetry is the recommended first enabled mode.

## Provider hooks

The managed installer adds one user-level AIKombinat `PreToolUse` entry, preserves unrelated settings and hooks, writes atomically, creates a backup before the first mutation, and refuses malformed configuration. It copies the bridge into the application data directory and writes a stable launcher around the exact running Node runtime. Status verifies that the launcher references the expected runtime and bridge and that the copied bridge SHA-256 still matches the managed definition; a modified copy is incompatible, never verified. Packaged Electron launchers set `ELECTRON_RUN_AS_NODE=1`; Windows uses a quoted `.cmd` wrapper, while macOS/Linux use a quoted executable POSIX wrapper. Status distinguishes a configuration entry from a missing or unrunnable launcher/runtime. Removing a hook removes only the managed entry. The bridge exits immediately outside an AIKombinat execution and never receives prompts, file contents, provider credentials, or the general administrative MCP token.

Claude uses its native user `settings.json` hook representation. Every managed definition has a schema/bridge/path/runtime hash and an installation timestamp. `verified` requires a real hook event carrying that same hash after the current installation; an older observation or a changed/reinstalled definition remains `installed_unverified`. Codex supports a separate `hooks.json`; if the same config layer already uses inline hooks, AIKombinat reports `manual_action_required` rather than creating a competing representation. Codex hook definitions may require manual trust. AIKombinat reports `needs_trust` separately and never passes `--dangerously-bypass-hook-trust`.

Claude primary execution adds the temporary Delegation MCP with `--mcp-config` but does not use `--strict-mcp-config`. Claude's current CLI contract defines strict mode as ignoring every other MCP configuration, so using it here would silently suppress unrelated user/project servers. Normal MCP configuration remains additive, while the injected `kombinat-delegation` server itself exposes only `bulk_read` and only that tool is added to the managed permission rules. See the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference#cli-flags).

## `bulk_read` contract

Model input is limited to:

```json
{ "path": "relative/or/contained/absolute/file.ts", "query": "focused question", "max_ranges": 8 }
```

The server resolves and realpaths the file against the persisted parent work directory, requires a regular UTF-8 text file, rejects traversal and external symlink escapes, and enforces byte/line limits. `.env` variants, credentials, private/SSH keys, `.git` internals, and AIKombinat authentication/configuration secrets are refused and are never sent to the worker.

Before launch, the server records size, line count, and SHA-256. It rechecks identity after the worker returns; a changed file produces `stale` and no old ranges. Source content is delimited as untrusted data in the worker prompt. Worker JSON is validated for schema, bounds, range count, total lines, and bounded strings. Overlaps are merged. Anchor snippets are extracted from the current real file by the server, never copied from worker prose.

`no_match` means only that the worker identified no ranges; it is not proof that the file is irrelevant. Infrastructure failures, invalid structured output, timeout, and `no_match` grant one direct full-read fallback for the same parent, canonical file, and file hash for 60 seconds. Sensitive or outside-workspace refusals do not grant fallback.

## Lifecycle and recovery

Delegation runs persist `starting`, `running`, `completed`, `failed`, `cancelled`, or `recovery_required` state with PID and process identity. Spawn adoption persists PID/identity before releasing its reservation, including a late spawn after parent cancellation. Any row with `process_pid > 0` is owned regardless of lifecycle status and consumes provider capacity until reconciliation clears it. Timeout, transport failure, and parent Stop apply the same stop matrix: confirmed termination or exit clears ownership; `not_owned` clears stale ownership without another signal; `unresolved` retains ownership in `recovery_required`. Fallback eligibility is independent of ownership release, and late completion cannot overwrite `recovery_required`.

Startup recovery and the existing 30-second passive tick both use the canonical all-PID query, including anomalous terminal rows. Recovery is single-flight, so overlapping ticks share one pass and cannot concurrently probe or signal the same PID. Dead or identity-mismatched PIDs release ownership without signalling a mismatched process, matched PIDs receive safe cleanup, and unverifiable live PIDs remain retained. Ownership updates compare status, PID, and identity, so an older asynchronous reconciliation cannot clear superseding state. Every real delegation capacity release goes through the coalesced `ExecutorPool` availability callback and wakes ordinary `waiting_executor` Todos once.

## Telemetry and privacy

Tool observations store parent execution/provider/model identity, tool and normalized operation, safe relative path and offsets, cheap file metadata, decision/reason, and hook latency. Shell observations store only a derived command kind, raw character length, and SHA-256—not command text. Delegation runs store file identity and sizes, bounded failure detail, the resolved worker snapshot, actual token usage only when a provider reports it, returned characters, and `context_avoided_chars = max(0, source_chars - returned_chars)`.

Normal telemetry never stores prompts, file contents, environment variables, raw shell commands, full provider output, or capabilities. Startup cleanup defaults to 30-day retention and removes finished parent execution rows only after retained child state and PID ownership are gone. Character reduction is labelled as characters; no parent-token savings are fabricated.

## Known V1 limitations

1. Claude `@file` references can bypass `PreToolUse Read`.
2. Codex may read through shell/unified exec; V1 records telemetry but does not attempt complete shell parsing or blocking.
3. Hooks are cost-optimization guardrails, not a sandbox security boundary.
4. Claude is the only provider with a proven V1 worker isolation contract; Codex and Antigravity candidates fail open to the next eligible candidate or direct read.
5. Worker quality may miss implicit cross-file context.
6. `no_match` is not proof of absence.
7. One process per delegation adds startup latency.
8. Parent tokens saved are unknown unless a provider exposes sufficient real usage data.
9. A worker Execution Profile must be explicitly configured.
10. Non-managed Codex hooks may require manual trust.
11. V1 handles one file per `bulk_read`.

V2 large output/log routing, generic summarization, code generation, architecture/debugging/review delegation, adaptive cost routing, DAGs, and persistent workers are intentionally out of scope.
