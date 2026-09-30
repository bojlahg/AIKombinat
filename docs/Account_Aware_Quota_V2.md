# Account-aware Quota V2 and automatic account failover

## Canonical state and migration

`provider_account_quota_state` is the only mutable runtime quota truth for Claude, Codex and Antigravity. Each account has its own available/exhausted/unknown state, source, observation time, bounded reason and reset deadline. Optional quantitative columns remain NULL: no inferred percentages, billing scraping or model-level limits.

Migration runs after Provider Accounts V1, preserves IDs, snapshots and references, creates unknown rows for all existing accounts, and is idempotent. `provider_quota_state` remains legacy diagnostic data; its available/unknown/exhausted values are neither copied to accounts nor consulted by runtime admission. New runtime observations always use the immutable execution account identity. Compatibility provider mutators resolve only the inherited account, never write legacy provider rows, and do not affect other accounts.

Provider reads are derived over enabled accounts with available/unknown health:

| Runnable account states | Provider aggregate |
| --- | --- |
| Any available | available |
| None available, any unknown | unknown |
| All exhausted | exhausted |
| No runnable accounts | unknown |

Disabled/auth-error/unavailable accounts do not determine the quota aggregate. Capacity is a separate axis. Unknown quota remains eligible; unknown is visibly distinct from available.

## Observation and wake

A confirmed successful provider execution marks only its selected account available (`execution_success`), even if an older observation said exhausted. A recognized quota/rate-limit rejection marks only its account exhausted (`runtime_rejection`). Auth errors continue through account health, and ordinary/network/context/model/build failures do not trigger account quota failover. Existing provider-specific unambiguous classifier patterns remain the retry authority; a bare HTTP `429` is insufficient.

A valid reset timestamp within the bounded window (five minutes in the past through thirty days in the future) is used; otherwise the service stores the cooldown deadline. `PROVIDER_QUOTA_COOLDOWN_MS` defaults to 300000. One nearest-deadline timer covers all enabled exhausted accounts. Expiry sets unknown with `cooldown_expired`. Disabling/deleting accounts rearms that timer; shutdown clears it.

Availability notifications are coalesced and support multiple subscribers plus the existing compatibility callback. Todo and Orchestrator admission reuse their existing wake loops. No per-account polling or extra scheduler exists.

## Admission

Automatic candidates rank accounts by quota and health: available quota/available health, available quota/unknown health, unknown quota/available health, then both unknown. Ties use sort order, creation time and stable ID. Health rejection precedes quota rejection; eligible account capacity and aggregate provider capacity are both required. Selection still reserves under the existing pool mutex.

Exhausted accounts are excluded. Busy runnable accounts yield waiting_executor; all quota-blocked runnable accounts yield waiting_quota; unhealthy/disabled-only candidates yield no_candidates. Diagnostics include account labels and reset/capacity/exclusion reasons. A fixed or inherited retry stays on its original profile candidate, even if another candidate has capacity. Automatic failover tries the same candidate first, then the explicitly ordered profile fallback candidates.

## Durable attempts and process ownership

All Todos now record execution rounds, including tasks without review. Quota failure handling runs only from the confirmed process-exit lifecycle and matches the owned PID. Unresolved Stop retains ownership and blocks a retry. The transaction preserves the failed round/snapshot, clears confirmed ownership, marks account exhaustion, records chain history and creates one pending retry round with a new run token. Duplicate callbacks cannot create another retry.

Automatic failures are recorded in `account_failover_events`, uniquely keyed by owner, chain and attempt. `quota_chain_id` on Todos/primary turns persists the chain; account exclusions are derived from its audit rows. Admission records the replacement account. New user Retry and new logical phases start new chains. An account reset does not erase its exclusion in an active chain. If every account has already been attempted, waiting tasks need a new eligible untried account or explicit Retry/new phase; they never rotate A → B → A indefinitely.

`MAX_ACCOUNT_FAILOVERS_PER_PHASE` defaults to 3 and is clamped to a hard maximum of 8. Reaching the cap records `failover_budget_exhausted` and fails explicitly rather than pretending unused accounts have no quota.

Retries preserve the existing worktree and files. Their persisted input explains the quota interruption and asks the agent to inspect current files/tests before continuing the current phase. Account failover uses a fresh process without provider continuation flags. Resource Fabric leases follow the existing exit contract: the old run releases its binding and the new run reacquires through ordinary admission. No quota-specific resource scheduler exists.

Stop uses the existing startup generation guard and wins over a pending replacement launch. Restart with a persisted pending retry reuses that round/token instead of creating another. A process that may have launched but lost its PID/exit lifecycle retains the existing conservative recovery behavior; it is never blindly duplicated.

## Lifecycle integrations

- Implementation, review and rework each retry their current phase; completed earlier phases remain immutable.
- Orchestrator creates a fresh primary attempt row, preserves assigned unconsumed events and the same mutation idempotency namespace, and does not increment the logical planning turn budget for infrastructure quota retries. Attempt rows have distinct history indexes; the parent turn_count remains the logical budget counter.
- Interactive Sessions do not fail over. Quota is observed on their pinned account; resume rejects exhausted original accounts rather than transferring a conversation.
- Delegation workers observe their account quota and use existing failure/fallback behavior; subsequent admission avoids exhausted accounts. They do not rotate inside a micro-delegation request.
- Discussion/paused AgentForum executions observe account quota without adding a mid-turn retry lifecycle.
- Schedule-generated Todos inherit ordinary account policies and failover behavior.
- OpenCode/raw-shell, account model catalogs and provider CLI installation health remain outside this service.

## API, WebSocket and UI

- GET `/api/provider-accounts/:id/quota` returns the current bounded account observation.
- POST `/api/provider-accounts/:id/quota/reset` clears exhaustion to unknown without asserting availability or changing health.
- GET `/api/provider-quota` returns aggregates and account quota details. Existing `/api/cli/quota`, getQuotaState and getAllQuotaStates retain aggregate compatibility.
- Account list/detail responses include quota separately from health.
- `provider-account:created`, `:updated`, `:health`, `:deleted`, `:quota` invalidate mounted account views. `quota:updated` retains the provider badge contract. Backend admission never depends on WebSocket delivery.
- Account cards show state, deadline, source and observed time; the reset action means unknown. Execution history retains account labels, attempt indexes, retry links and quota failure reasons. Core English/Korean/Russian keys and placeholders remain in parity.

Quota state and audit records store no raw provider output, credential values, capabilities or SSH secrets. Reasons are redacted, normalized and limited to 1024 UTF-8 bytes. Optional observation history is not added; bounded current-state rows are used for admission. Audit lineage follows durable execution history rather than acting as an unbounded raw error telemetry stream.

## Validation

See [smoke report](Account_Aware_Quota_V2_Smoke_Report.md). Run `npx tsx scripts/account-quota-v2-smoke.ts` for the disposable synthetic suite. Run `npx tsx scripts/provider-accounts-smoke.ts <new-disposable-directory>` only for the authorized tiny real CLI Todo/primary observations. Real quota exhaustion must never be manufactured.
