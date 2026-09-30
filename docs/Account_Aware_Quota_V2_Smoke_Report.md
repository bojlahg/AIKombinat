# Account-aware Quota V2 smoke report

## Environment

Validated on 2026-09-30, Windows x64, Node v22.16.0. The implementation working tree is based on commit `3d37589170c4b4d63a610eb14a6c946de6b4e0a4`; the resulting implementation commit is reported in the task response.

Installed CLI observations: Claude Code 2.1.246, Codex CLI 0.159.2, Antigravity 1.2.14. OpenCode was unavailable. Claude inherited login health was available; Codex reported auth_error; Antigravity health remained unknown. No credentials or login state were changed.

## Migration

Disposable tests create accounts, profiles, Todo snapshots and legacy exhausted provider state, recreate the V2 quota table, then initialize twice. Account IDs and legacy snapshots remain intact, every migrated account starts unknown, legacy provider exhaustion is ignored, and foreign_key_check is clean. Baseline startup also exercises the existing Session/Schedule/Orchestrator schema and Provider Accounts migrations.

## Account states and aggregate

Synthetic account A starts unknown; its quota rejection changes only A to exhausted, source runtime_rejection, reset observed_at + five-minute cooldown. Synthetic B starts unknown; its actual process success changes only B to available, source execution_success, no reset. Aggregate becomes available despite A exhaustion. Aggregate tests also cover unknown/exhausted combinations and disabled/auth-error exclusion.

## Executable synthetic failover

`npx tsx scripts/account-quota-v2-smoke.ts` creates disposable SQLite/project fixtures and runs real Node child processes in an actual disposable Git worktree for the A → B smoke:

1. A writes partial.txt containing `from A`, emits `usage limit reached` and exits nonzero.
2. Classification is quota_exhausted; A becomes exhausted.
3. A round remains failed with A's snapshot. A fresh round/run token is persisted.
4. B starts with a distinct real PID in the same directory, verifies A's file and writes done.txt.
5. B succeeds; Todo completes; audit lineage records A → B; foreign keys remain clean.

The launch assertions verify separate provider credentials, absence of the other account's environment reference, exclusion of server-only secrets, recovery prompt semantics and no continuation flag.

## Loop prevention and cap

A → B followed by manually clearing A and rejecting B never launches A again. Durable exclusions survive quota service reset/schema reinitialization. A one-failover cap permits B and prevents C; the general cap is bounded at eight. A duplicate failure callback is inert.

## Waiting quota and wake

A/B initially exhausted produce waiting_quota with PID 0. Clearing previously untried B to unknown automatically launches B. Fixed A rejection waits while healthy B remains unused; clearing A starts a new attempt on A. Exhausted A plus busy B yields waiting_executor. Multiple service subscribers receive account availability wakeups; cooldown affects only the account whose deadline elapsed.

## Review/Rework

Both review and rework fail over their current phase, retaining the completed implementation/review history and original snapshots. A new round links to the failed round with attempt_index 2. Earlier implementation does not restart. Existing review/rework and explicit Retry regression suites also run.

## Orchestrator

Synthetic A creates a child under idempotency key same-child and quota-fails before a terminal action. B receives the durable trigger context and repeats the key: identical child result, one Todo, one child job. Events remain unconsumed before B's terminal action. Parent max_turns=1 still permits the quota replacement because its logical turn_count remains 1. History retains failed A and completed B rows.

## Session no-failover

Interactive A quota rejection updates A, starts no B, and preserves the original execution snapshot. Resume remains pinned to A and rejects its active exhaustion despite healthy B.

## Stop, ownership and restart

Stop during awaited B candidate evaluation prevents the second spawn. An unresolved old PID retains ownership and creates no retry intent. Restart with persisted retry intent reuses one B round and ignores duplicate A failure callbacks. Existing startup, generation, remote ownership and resource tests remain enabled.

## Security

Synthetic environment-reference children receive only their bound provider credential; reference variables and server auth/tunnel secrets are removed. Quota/audit records contain classification and bounded normalized reasons, not raw stdout/stderr or credentials. Foreign keys are clean. V1 streaming credential-isolation tests remain in the full suite.

## UI/WebSocket

Client tests render health independently from exhausted quota, display source/reset/observation, execute reset-to-unknown, then deliver live quota and created/updated/health/deleted events through the panel's WebSocket subscription. The mounted panel reloads without page refresh. Execution history renders immutable account labels and retry lineage. A real in-app browser also opened the disposable server at localhost:4200/settings/provider-accounts. A disabled synthetic account created through the API appeared immediately in the mounted panel without page reload; a reset POST changed Claude quota from available/execution_success to unknown/manual_reset while health stayed available. A screenshot was saved as the task UI evidence. These operations affected only the disposable smoke DB.

## Real Claude smoke

`npx tsx scripts/provider-accounts-smoke.ts .smoke/account-quota-v2-real` ran on a disposable DB/Git project. A tiny inherited-account Todo completed; account `ee793c91-4aa6-4031-b611-78e6aa2d291d` became available with source execution_success; the provider aggregate was available; the account identity stayed in the snapshot.

## Real Orchestrator smoke

A short Claude primary turn invoked finish without creating children or resources. The Orchestrator completed on the same inherited account and recorded available/execution_success quota. The real smoke foreign_key_check returned []. No real quota exhaustion or account rotation was induced.

## Validation and limitations

Final validation passed: typecheck; 1122 server tests passed with 2 existing skips; 189 client tests passed; all 22 specialized synthetic smoke scenarios passed; client/server build; ERD check; git diff --check. The initial sandbox build returned EPERM on existing dist artifacts; the authorized escalated build succeeded. The final build completed both client and server compilation.

Unsupported non-inherited Codex/Antigravity/SSH accounts and OpenCode quota remain outside V2. Quantitative telemetry stays NULL. A chain never reuses an attempted account merely because cooldown/manual reset elapsed; previously attempted-only chains need explicit Retry/new logical phase or a new untried account. Lost process ownership uses the existing conservative recovery path.

GitHub baseline CI was green for 3d375891. CI for the resulting pushed commit has not yet been observed; repository instructions require stopping immediately after the successful push. Feature validation is local; final remote CI acceptance remains pending.

## Conclusion

READY_WITH_LIMITATIONS — local feature and real/synthetic smoke evidence is recorded. Final pushed-commit CI must be accepted separately before declaring unconditional READY.
