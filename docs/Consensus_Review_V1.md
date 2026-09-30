# Consensus Review V1

Consensus extends the existing Review/Rework pipeline. An implementation produces one immutable review artifact and one logical `todo_execution_rounds` review row. A batch fans that round out to 2–7 independent reviewer jobs (the editor defaults to three). Each job uses one Execution Profile; that profile's candidates remain late-binding/fallback choices, never extra votes. Attempts, quota retries and a judge do not consume additional logical review rounds.

## Configuration

Open Settings → Review policies. Choose a name, description, strategy, failure policy, minimum successful reviewers, diversity preference and maximum parallel reviewers (1–7). Each member has an Execution Profile, label, integer weight (1–10), priority and enable state. Judge strategies require a judge profile. Policies and members can be edited or disabled; deleting a policy through the API disables it. Removed members are retained as retired rows for historical foreign keys.

Enable Review on a Todo and choose Single or Consensus. Single keeps the existing Review Profile selection. Consensus selects a Review Policy, inheriting the project's default policy when empty. Rework Profile is shared by both modes. Project settings provide the default mode and policy for new Todos. Existing Todos and migrated history remain Single unless explicitly changed. Review remains opt-in.

## Decisions

| Strategy | Decision |
| --- | --- |
| `majority` | Approved votes must exceed needs-changes votes; a tie needs changes. |
| `unanimous` | Every successful reviewer must approve. |
| `weighted` | Approved weights must exceed needs-changes weights; a tie needs changes. |
| `judge` | One read-only judge decides after reviewer collection. |
| `judge_on_disagreement` | Agreement decides directly; mixed verdicts invoke one judge. |

`require_all` requires valid structured results from every enabled reviewer; any irrecoverable failed job fails the batch. Collection waits for sibling jobs to settle, preserving their results. `quorum` also waits until every job is terminal, then counts only successful jobs if their number reaches the configured minimum (at least two). Failed jobs never vote. A failed judge fails the batch without falling back to a vote strategy.

Issues are merged deterministically by normalized case-insensitive description and sorted normalized file set, preserving the highest severity. Ordering uses severity, member priority and original issue order. Approved aggregate results always have an empty issues array. Individual dissent, findings and errors remain in history. Aggregates include successful/failed counts, votes, weights, strategy and judge requirement.

Only the aggregate is written as the ordinary ReviewResult on the logical review round. The existing pipeline completes an approved Todo or creates ordinary Rework for needs-changes. Batch completion, logical round completion and the next phase transition share one SQLite transaction. Rework creates a fresh review artifact and batch; the ordinary `max_review_rounds` budget still bounds that loop.

## Admission and ownership

The dispatcher wakes from ExecutorPool, account quota, Resource Fabric, completion and startup events. It admits members in priority/creation/id order, with per-batch parallelism in addition to project Todo concurrency, provider capacity, account capacity and resource capacity. A consensus Todo occupies one project slot. Its own PID remains zero; every attempt owns its PID and process identity.

`none` keeps ordinary selection. `prefer_provider` softly avoids providers already used by the implementation or batch. `prefer_provider_and_account` also softly avoids account identities. These hints operate among eligible candidates of equal priority and comparable account health/quota rank. Fixed accounts remain pinned. Impossible diversity never blocks a viable job. Every admitted attempt records selection hints and its actual identity.

Executor reservations use `consensus-review:<attempt-id>`. Resource Fabric uses `owner_type=reviewer`, `owner_id=<attempt-id>` and a unique run token. Each attempt inherits Todo resource requirements. Waiting jobs have PID zero and no executor slot; a busy resource releases the executor reservation. Snapshot, PID and identity are durable before reservation release. Reservations and PID ownership are deduplicated in provider/account usage; all persisted positive PIDs count, including recovery states.

Quota classification runs only after a real nonzero CLI exit. Automatic account policy creates another attempt inside the same job and same candidate, retaining a bounded job-scoped failover chain and excluding previously rejected accounts. Fixed/inherited policy waits for its same account. Exhausted chains fail explicitly. Invalid JSON, ordinary process failures and output limits require explicit Retry Reviewer/Judge and never cause semantic fallback.

## Evidence and process lifecycle

All reviewers read the same logical round prompt and artifact identity. Shared prompt storage is reused; attempt `input_payload` remains null. Artifact identity and the SHA-256 of shared evidence are checked before admission, at completion, before aggregation and by the existing finalizer. Changed evidence fails closed with `review_artifact_changed` and stops sibling processes; it never publishes approval for changed code.

Launches reuse the provider's ordinary strict, headless, read-only review mode. V1 admission supports local Claude, Codex and OpenCode. Raw shell, remote reviewer transport and Antigravity are excluded until their review isolation contract is proven. The judge receives the same evidence and bounded structured reviewer findings, explicitly marked untrusted; it cannot edit or run Rework.

Stop cancels admission, waits for an in-flight launch to persist identity, then uses the existing identity-aware process stop. Unresolved termination retains PID, account/provider capacity and resource ownership in `recovery_required`. Only confirmed exit, dead PID, identity mismatch or successful termination releases ownership. Passive recovery is single-flight and precedes ordinary review startup reconciliation. It preserves live/unverifiable processes, marks vanished interrupted attempts failed, resumes waiters and aggregates already completed votes without relaunching them. Explicit Stop intent persists across restart.

Retry Reviewer/Judge reopens only that failed/stopped job in the same unfinalized batch and adds a lineage-linked attempt. Completed siblings remain unchanged. Retry rejects stopped Todos, superseded rounds, active ownership, changed artifacts and finalized batches. Whole Review retry uses the existing retry service and creates a new logical round with freshly collected evidence. Human Approve/Rework also reject retained reviewer ownership.

## Storage, API and UI

Tables: `review_policies`, `review_policy_members`, `consensus_review_batches`, `consensus_review_jobs`, `consensus_review_attempts`. Unique indexes enforce one batch per review round, one judge per batch, one reviewer per member and one active attempt per job. Todo/round deletion cascades history. Resource owner CHECK constraints migrate transactionally; migration is idempotent and verifies foreign keys. See [ERD](ERD.md).

| Method | Path (under `/api`) | Behavior |
| --- | --- | --- |
| GET / POST | `/review-policies` | List / create policies. |
| GET / PATCH / DELETE | `/review-policies/:id` | Read / edit / disable. |
| GET | `/todos/:todoId/consensus-reviews` | Durable batches, jobs and attempts. |
| GET | `/consensus-review-batches/:id` | One detailed batch. |
| POST | `/consensus-review-jobs/:id/retry` | Retry one reviewer or judge. |

Existing Todo/Project APIs accept `review_mode`, `review_policy_id`, `default_review_mode` and `default_review_policy_id` as appropriate. Existing Todo/project Stop endpoints stop consensus ownership too. Policy validation enforces counts, weights, quorum, parallelism, known profiles and judge configuration.

Review Timeline shows strategy, batch/job/attempt states, selected profile/provider/account/model/effort, duration/cost when reported, verdicts, dissent, issues, errors, aggregate votes/weights and reviewer/judge retries. WebSocket `consensus-review:batch-created`, `batch-updated`, `job-created`, `job-updated`, `attempt-updated`, `completed` events trigger API refreshes; DB history remains the source of truth. EN/KO/RU core keys share placeholder parity.

## Bounds and limitations

Review prompt plus judge input is capped at 256 KiB; extracted output at 64 KiB; each structured result at 24 KiB; persisted errors at 1 KiB with shared redaction. Claude stream-json parsing extracts assistant/final result text rather than tool/metadata frames, decodes split UTF-8 and persists nullable usage telemetry. Missing provider usage stays null. Diagnostic logs contain bounded lifecycle metadata, never shared prompts or complete raw output. No credentials, environment values or MCP capabilities enter consensus records.

Consensus is an experiment, not evidence that extra reviewers improve quality or save tokens. Real heterogeneous model/account effectiveness, real judge behavior, real quota exhaustion and real fault recovery still need provider-specific observations. Automated lifecycle coverage uses synthetic streams with the real database, pipeline and selected real admission services. See [acceptance evidence](Consensus_Review_V1_Smoke_Report.md).
