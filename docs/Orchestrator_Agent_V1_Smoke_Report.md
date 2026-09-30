# Orchestrator Agent V1 acceptance report

Conclusion: **READY_WITH_LIMITATIONS**.

## Environment

2026-09-30, Windows, Node v22.16.0. Implementation started on clean, freshly pulled `main` at `2e8a6e1bde79cb63f4719b1b1a7254debf0224ad`, with Resource Fabric V2 READY_FOR_ORCHESTRATOR. Real fixtures used separate SQLite files and disposable local Git repositories; no application production DB, external workload or project branch was changed by smoke runs. No fixture commit was pushed.

Primary: Claude Code **2.1.246**, exact profile model **claude-opus-4-7**. Provider modelUsage also reported Claude Haiku 4.5 ancillary usage; this is recorded without treating it as a second orchestrator candidate. Child: OpenCode **1.18.33**, discovered exact **opencode/muse-spark-1.3-contributor-free**. Catalog refresh succeeded; no paid child fallback was used. Review used the same strong Claude profile.

Primary/child profile IDs for A/C/D: `d13df7c3-d759-4cdc-a7dc-9059a0415dc3` / `5499ef20-35c6-4ea1-a373-d937a07546bf`. Full local audit artifacts: visualization workspace `orchestrator-smoke-2/report.json`, `orchestrator-parallel-1/report.json`, `orchestrator-restart-1/before.json` and `after.json`. Only bounded, non-secret evidence is reproduced here. All timestamps below are UTC.

## A — real child implementation, review and fresh wake

Objective: fix an addition utility, add positive/negative tests, delegate one implementation to the cheap profile, use the ordinary review pipeline and finish after review approval.

Orchestrator `76772c12-d08f-40bc-aba7-6f9d63929c63`: **completed**, two primary turns, one child Todo `f720ab10-70a0-446e-93a6-b71256dc6c48`.

| Evidence | Observation |
| --- | --- |
| First primary | PID 32300; async delegate_task, then yield; finished 11:51:38.591 |
| Waiting | waiting_event, primary PID 0; persisted checkpoint and owned child wake condition |
| Child implementation | Muse, PID 57152, ordinary worktree; completed |
| Review | Claude Opus 4.7, PID 26480; ordinary review round completed/approved |
| Durable child event | child.completed at 11:53:22.059 |
| Fresh second primary | PID 37564; started 11:53:22.062; inspected child and finished 11:53:37.814 |
| Event consumption | After successful terminal action/exit, 11:53:37.814 |
| Artifact verification | node add.test.cjs rerun in the child worktree passed |

No manual Retry and no provider continuation. Parent → turn → operation → child → Todo → implementation/review round → exact executor/model snapshots are persisted.

## B — parallel siblings and separate integration child

Orchestrator `35077b80-a9d3-4109-ba01-03966483319e`: **completed**, four primary turns, three ordinary Muse Todos. Two independent siblings created/committed alpha/beta utilities and tests in separate worktrees. Both ran concurrently (PIDs 23028 and 43384). First completion woke a fresh primary; second completion arrived before its yield, and another fresh turn followed automatically. That turn delegated a separate integration child (PID 56136), which cherry-picked the sibling commits and verified both utilities. The controller did not automatically merge branches. Final primary PID 34840 finished after integration completion; all final primary PIDs were zero. Independent node alpha.test.cjs and node beta.test.cjs checks in the integration worktree passed.

## C — real CPU wait, reserve-before-wake and atomic claim

Temporary policy in the disposable DB left one allocatable CPU thread. An owned raw-shell blocker held it. No GPU was requested. The blocker was safely stopped after the orchestrator actually reached waiting_event; the observed contention lasted about 47 seconds, rather than relying on an assumed provider latency.

Orchestrator `c92be6b9-fb6b-4554-8a9b-4fcf85cc45f9`: **completed**, three primary turns and one Muse child. Request `60d3b96a-0ceb-4233-b32e-4fa85d423aba`, binding **4cfeecaf-3a33-4a3f-a8f5-1904b01a7a46**.

| Ordering | Evidence |
| --- | --- |
| Request waiting | 11:53:46; first primary PID 39584; waiting_event after exit, PID 0 |
| Blocker termination/release | 11:54:25; termination confirmed before lease release |
| Parent binding/lease acquired | 11:54:25.591; persisted five-minute claim deadline 11:59:25.591 |
| resource.fulfilled persisted | 11:54:25.592, after the binding |
| Fresh primary admission | 11:54:25.657; PID 44700 |
| Child claim transfer | 11:54:35, after ExecutorPool admission; same binding and binding items |
| Child spawn | Muse PID 32468, after claim |
| Child lease release/completion | 11:56:07; request became released; child.completed at 11:56:07.208 |
| Final fresh primary | PID 8492; finished 11:56:23.526 |

The child's immutable execution snapshot contains the identical binding ID. There was no release/reacquire gap during handoff. Resource leases were released at child termination, and finish accepted only with no active hold/child. The child's utility tests were rerun successfully. Nonmatching resource.released events remain immutable audit inbox entries; assigned relevant events were consumed.

## D — real human message wake

Orchestrator `54d4f233-c22e-4ef6-aa39-601c6d39c188`: **completed**, two fresh turns. PID 26356 yielded for user_message and exited at 11:56:56.181, leaving waiting_event PID 0. Exact message **ACCEPT-MESSAGE-42** was persisted at 11:56:56.199. New turn began at 11:56:56.202 with PID 52304 and received the exact content; finish at 11:57:06.246 consumed the event.

## E — restart while waiting

Two independent temporary controller processes shared the same SQLite file. This scenario used an explicit deterministic fake primary and fake child admission, without a real provider.

Controller PID 44420 created one child and one bound CPU request, checkpointed, yielded at waiting_event PID 0 and exited without normal cleanup. Controller PID 21792 recovered the same checkpoint/hold, remained waiting, then received a new user event. Exactly one fresh turn launched. Repeated delegate_task/request_resources keys returned the same child/request IDs. It released the hold, completed the synthetic child and finished. Totals after restart: **one child, one request, two turns**, final PID 0. No duplicate mutation and no manual Retry.

## F–J — automated protocol and safety

Server tests use fake provider execution and fake MCP calls. They verify duplicate delegation/resource/yield results; changed-input conflicts; capability authorization/revocation and parent/turn scoping; oversized UTF-8 and concrete node IDs denied; one primary turn; deterministic event batching and source dedupe; redelivery after a crashed terminal action; event-before-yield and human override; Claude-only selection despite higher-priority Codex; executor/quota waits; persisted PID capacity; turn/child/concurrency/resource/operation budgets; parallel ANY children; finish rejection with children/holds; pause preserving children/releasing holds; unresolved Stop retaining cancelling; safe final cancellation and mismatched-PID recovery without signalling a bystander.

Resource tests additionally verify holds surviving recovery without PID, five-minute expiry while a child waits for executor, copied-requirement fallback, same-binding transfer and child-owned-release rejection. The V2 CHECK migration preserves existing Todo/Session IDs, requests, binding references and leases, passes foreign_key_check and remains idempotent. Existing Todo/executor/resource regression suites run alongside the new service.

UI tests cover creation, Claude profile filtering, budgets, chat, explicit checkpoints, child links, holds/PID display, release gating and pause/resume controls. Core EN/KO/RU key/placeholder parity passes.

## Validation and issues fixed

Required local validation: typecheck, full server/client tests, production build, ERD check and git diff --check. Test totals and the final GitHub CI result are recorded in the delivery message for this implementation commit. The baseline CI was verified green before delivery; the implementation's remote CI cannot run until it is pushed.

Fixed during validation: ERD extraction initially picked the new migration helper instead of initDatabase; it now anchors the schema entry point. Interrupted terminal actions no longer consume events before confirmed success, and duplicate terminal keys can finish a corrective turn. Added admission/Stop race protection, fail-closed PID recovery, primary accounting in ExecutorPool, shutdown revocation, deterministic global request ordering and complete CPU lease-key reporting during handoff. Corrected UI token names and async UI assertions.

The first fixture setup stopped before any provider invocation because it expected an Opus alias absent from the catalog; the successful runs use the discovered exact model. Sandbox build permissions initially caused EPERM on preexisting dist files; the same normal build succeeded with approved host access. No destructive cleanup was used.

## Limitations

V1 boundaries remain: Claude-only primary; depth one; ANY only; no live child input injection; no provider --continue dependency; no remote OpenCode; integration through an explicit child; no general DAG, arbitrary training checkpoints or hard cross-provider dollar budget. Provider restriction is a CLI tool contract rather than an OS filesystem sandbox. Windows real smoke verifies native Claude; a shell-only npm primary shim is not verified. Exact discovered free-model availability can change; no future billing guarantee is inferred from this smoke.

**READY_WITH_LIMITATIONS**.
