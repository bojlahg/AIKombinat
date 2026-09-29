# OpenCode Executor V1 smoke report

Status: **READY_WITH_LIMITATIONS**. Real OpenCode implementation, read-only review, invalid-model failure and Stop succeeded. GitHub CI for the resulting commit remains unverified; local validation results are recorded below.

## Environment and verified CLI

- Date: 2026-09-30, Asia/Yekaterinburg. Successful smoke: 02:58:09–02:58:55 (2026-09-29 UTC).
- Windows NT 10.0.26200.0, Node.js v22.16.0; AIKombinat 0.2.49.
- Base main commit: `5b1202d716a1d3f08c4834008442530acdf2e34f`; smoke used the executor changes in this report's working tree.
- Actual installed CLI: `C:/Users/bojla/AppData/Roaming/npm/opencode.cmd`, version **1.18.33**.
- Verified `--help`, `run --help`, `models --help`, `--version`: `run --format json --model --agent`, stdin prompt and `models --refresh` supported. `--standalone` absent.

The [official v1.18.33 run implementation](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/cli/cmd/run.ts) reads stdin and starts a private in-process server when no attachment is requested. AIKombinat uses this verified mode without a shared server or attachment. Capability probing adds `--standalone` only if a compatible V1 CLI advertises it. V1 permissions are verified against the [tagged configuration implementation](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/config/config.ts).

A separately inspected 2.0.20 installation started but returned an empty standalone model catalog and has a different permissions contract. It is explicitly incompatible in this iteration. Installing a GUI is not evidence that the server can find a configured CLI.

## Discovery and selected profile

Real `opencode models --refresh` exited 0, did not time out, returned 1,134 stdout characters and **39 unique exact IDs**. Stderr contained `Models cache refreshed`. Discovery was authoritative, with source `opencode-models`. No bundled model list or hardcoded Muse row was inserted.

- Exact selected ID: **`opencode/muse-spark-1.3-contributor-free`**.
- CLI verbose metadata: display name `Muse Spark 1.3 Free`, active status, input/output/cache-read/cache-write prices all 0 at inspection time. This describes the observed catalog, not future availability or a billing guarantee.
- Profile: `OpenCode Free Smoke`, ID `2a8c0c7b-4c8d-4b3a-a1b0-f308f9bbe700`.
- Execution snapshot retained profile and candidate IDs, `agent=opencode`, identical model/effectiveModel values and `effort=null`.

An earlier real refresh failed while the known-good catalog remained available. The successful rerun above refreshed all 39 models. The script also injected a failed empty refresh and verified preservation of existing model IDs/statuses. Automated tests cover timeout, empty/error output, manual entries and authoritative missing-model reconciliation.

## Real execution evidence

The fixture was a separate disposable Git repository with a deliberately incorrect addition function. It used its own database and worktrees, not the AIKombinat repository or user projects.

| Check | Observed result |
| --- | --- |
| Implementation | Muse changed subtraction to addition and added the `add(2, 3) === 5` regression; PID 43576; completed |
| Fixture validation | `node --test add.test.cjs` passed, zero failures |
| Local fixture commit | `6c874df962774b1b40a7ead613ff57f0d43dfdc1`; only `add.cjs` and `add.test.cjs` changed |
| Review | Separate managed reviewer PID 57932; existing pipeline accepted its JSON verdict; review round completed |
| Read-only observation | SHA-256 over both fixture files before/after review unchanged |
| Final Todo | `completed`, both implementation/review rounds completed, persisted PID 0 |
| Elapsed time | 40,585 ms across implementation and review; logged process times 27,747 ms and 12,259 ms |
| Invalid exact model | `aikombinat-invalid/model-missing`, PID 45500; Todo failed, final PID 0; no false completion |
| Stop | PID 30972; requested during a real run; final `stopped`, persisted PID 0, manager reported no running process |
| Termination | Existing lifecycle logged confirmed graceful termination after 213 ms |
| Database integrity | `PRAGMA foreign_key_check` returned no violations |

The invalid-model CLI returned a generic server error, not a reliably structured model-unavailable reason. It is recorded as a runtime failure without inventing backend quota identity or reset time. Usage/cost was not persisted for this smoke; no inferred token savings or billed cost is claimed.

Raw evidence is in the disposable `opencode-smoke-2/report.json` and bounded runtime logs under the local visualization workspace. It is not committed because logs may contain local paths and model responses. The table retains the relevant non-secret observations.

## Implementation and boundaries

OpenCode is a first-class executor in the catalog, API validation, Execution Profiles, runtime resolution, snapshots, Executor Pool and EN/KO/RU UI. Default process concurrency is 2; admission and release use the existing pool. Schedules and Todo phases reuse the same resolution path. Existing SQLite catalogs are transactionally rebuilt to extend the CLI CHECK while copying every column and ID, retaining indexes and profile references, and checking foreign keys. Repeated startup is idempotent; fresh and populated old-schema databases are tested.

OpenCode is separate from `QuotaProviderTool`. Provider Quota V1 still tracks only Claude/Codex/Antigravity. OpenCode errors do not exhaust all OpenCode models, create fabricated reset times or route into global `waiting_quota`. No quota badge is shown for it. Backend/account-aware quota remains future work.

Prompts travel over stdin and are absent from argv. Runtime-owned configuration is created per execution, injected after inherited configuration and removed after actual process exit or startup failure. No global provider/auth configuration is rewritten. Managed agents deny unknown tools, external directories, permission questions, subagents and sensitive file patterns. Build permits workspace edits plus a narrow test/build/Git command list; review denies edits and permits only inspection. These are CLI tool guardrails, **not an OS sandbox**. The smoke verified review file stability; it does not prove arbitrary hostile command isolation.

The decoder buffers NDJSON across chunks, preserves UTF-8, emits assistant text rather than raw envelopes, ignores tool/reasoning events, deduplicates identified text parts and keeps stderr separate. Malformed/error streams and exit 0 without assistant text fail. Token counters are exposed only when finite real event values exist; absent usage stays absent. Structured runtime errors carry bounded redacted diagnostics.

Interactive/resume, effort overrides and arbitrary extra CLI options are rejected. OpenCode is explicitly unsupported as a Delegation V1 worker because no tool-less isolation proof was established. Delegation Router architecture was not expanded.

## Bugs found and fixed

The first real reviewer run exposed lifecycle messages surrounding its JSON verdict in the existing log-based review input. OpenCode review now supplies only decoded assistant output to the unchanged review parser. A regression test covers the exclusion of lifecycle lines and stderr; the second real run completed both phases.

Windows synthetic process tests initially had incorrect shell quoting. They now encode their fixture script and use the PATH Node command on Windows, while preserving the existing manager's production spawn behavior. Temporary empty shell artifacts were removed.

## Validation and reproduction

- `npm run typecheck`: passed.
- `npm test`: **963 server tests passed, 1 skipped; 166 client tests passed** (72 server and 31 client files).
- `npm run build`: passed. The initial sandbox run could not overwrite existing `dist` files (Windows EPERM); the authorized rerun completed. Existing Vite chunk-size warnings remain.
- `npm run docs:erd:check`: passed after the prescribed generator; ERD has no substantive change because this schema edit only extends a CHECK.
- `git diff --check`: passed.

Coverage includes populated old-schema migration/FKs/indexes, discovery preservation, exact args and stdin, compatibility probes, NDJSON and split UTF-8, synthetic lifecycle failure, profile validation, pool concurrency and quota separation, reviewer output extraction, and UI status/profile selection without effort/quota.

Run `npx tsx scripts/smoke-opencode.ts <new-disposable-directory>` with a configured compatible CLI. The script refuses existing output directories, selects only a discovered free model, makes a local fixture commit, exercises real implementation/review/failure/Stop and writes `report.json`. Failed assertions return exit 1. It does not push fixture commits. Full commands are in [TESTING.md](TESTING.md); setup is in [SETUP.md](SETUP.md).

## Remaining limitations and next step

Only the verified V1 CLI contract is admitted. Other operating systems have automated portable coverage but no real OpenCode smoke in this iteration. Rework uses the same build agent; no separate real rework round was needed because review passed. Global provider credentials/plugins remain user-managed. Backend-specific quota, interactive sessions/resume, persistent server pools, usage persistence and Delegation worker isolation need separate work.

GitHub CI will run on the pushed main commit. Its result is not claimed here: the repository contract requires stopping immediately after a successful push. Until CI succeeds, that acceptance item remains outstanding. Recommended next implementation stage: **Resource Fabric V2**, followed by Orchestrator Agent V1.
