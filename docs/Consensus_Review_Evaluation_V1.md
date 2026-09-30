# Consensus Review Evaluation / Telemetry V1

Evaluation derives observational evidence from durable execution history. It never changes routing, weights, account selection, judge invocation or execution policies. Agreement and final alignment are not correctness. Human feedback coverage must accompany quality evidence; Single and Consensus tasks are not randomized.

## Canonical data and persistence

Execution remains canonical in `todos`, `todo_execution_rounds`, `consensus_review_batches`, `consensus_review_jobs`, `consensus_review_attempts`, their historical execution snapshots, quota state and `account_failover_events`. No metrics cache, mutable score registry or duplicate execution event warehouse is introduced.

Two idempotently migrated tables add previously unavailable human observations:

- `review_evaluation_feedback`: one current human label per batch, reviewer job or reviewer issue fingerprint, optional plain-text note limited to 4096 UTF-8 bytes, timestamps and a reviewer-issue snapshot.
- `review_human_actions`: manual approve/rework and reviewer/judge/review-phase retries, previous verdict and execution linkage. Actions are inserted inside the accepted execution mutation's transaction. They do not imply a quality label.

Foreign keys cascade on project/Todo/batch/job/round deletion as applicable. Existing execution rows survive migration. Evaluation follows product-history retention; Delegation Router retention does not apply. Feedback never enters prompts or Wiki automatically.

## API

`GET /api/projects/:projectId/analytics/consensus` returns period, coverage, summary, strategies, historical policy variants, failure policies, members, execution identities, diversity, judge, issues, daily agreement, failover, recurrence, feedback, Single baseline and a batch page. Existing generic analytics is unchanged.

Additional read surfaces:

```text
GET /api/projects/:projectId/analytics/consensus/reviewers
GET /api/projects/:projectId/analytics/consensus/policies
GET /api/projects/:projectId/analytics/consensus/issues
GET /api/projects/:projectId/analytics/consensus/batches/:batchId
GET /api/projects/:projectId/analytics/consensus/export.csv
```

Allowed filters: `period=7d|30d|90d|all` (default all), `reviewPolicyId`, `strategy`, `executionProfileId`, `provider`, `providerAccountId`, `model`, `offset` and `limit` (1–200). Offset is bounded at 1,000,000. Unknown filters, arrays, invalid enums and oversized/control-character values are rejected. Fixed prepared SQL parameters prevent arbitrary SQL filtering. Batch details enforce project ownership.

The main cohort window uses **batch.created_at**, not Todo creation. Identity filters select batches containing matching historical attempts; whole batches retain their votes so agreement and diversity remain meaningful. Usage is further restricted by **attempt.created_at** and matching attempt identities. Feedback belongs to the selected batch cohort and uses **feedback.created_at**; an edited current label retains its original creation window. Responses return `periodStart` (nullable), `periodEnd` and `timezone=UTC`. Persisted SQLite timestamp strings and ISO timestamps are handled as UTC.

```text
GET    /api/consensus-review-batches/:id/feedback?projectId=...
PUT    /api/consensus-review-batches/:id/feedback
PUT    /api/consensus-review-jobs/:id/feedback
PUT    /api/consensus-review-jobs/:id/issues/:fingerprint/feedback
DELETE /api/consensus-review-batches/:id/feedback/:feedbackId?projectId=...
```

PUT bodies contain `projectId`, `label`, optional `note` and optional `batchId` for job targets. Batch labels are correct/incorrect/mixed/unknown; reviewer labels useful/not_useful/mixed/unknown; issue labels confirmed/rejected/uncertain. Invalid ownership, scope, label, nonexistent reviewer issue, HTML, recognized credentials or oversized notes are rejected. A job issue must match the persisted reviewer result through the shared fingerprint helper. Mutations emit `review-evaluation:feedback-updated` with only project/batch IDs; the dashboard refreshes its selected project.

## Definitions

| Observation | Definition |
| --- | --- |
| Vote | One successful reviewer job's final result, irrespective of retry count. Failed/stopped reviewers have no verdict or weight. |
| Agreement | At least two successful reviewers and all verdicts equal. Fewer than two gives null. |
| Disagreement | Both approved and needs_changes among successful reviewers. |
| Minority | A dissenting verdict against a strict plurality in a disagreeing batch. Ties have no minority. Minority-rate denominator is eligible votes in disagreeing, non-tie batches. |
| Final alignment | Job verdict matches a completed batch's final verdict. Missing final/vote is excluded. |
| Quorum salvage | Quorum batch completes despite at least one failed reviewer. Rate denominator is quorum batches with reviewer failure. |
| Judge override | Successful judge differs from the strict reviewer majority. Tie/absence remains null, including in batch details. |
| Unique/shared finding | Exact fingerprint appears in one / at least two successful reviewer jobs. Duplicate occurrences in one job count once. |
| Aggregate contribution | Reviewer fingerprint appears in the final needs_changes aggregate. Judge issues remain a separate source. |
| Rework contribution | At least one reviewer fingerprint is included in a final needs_changes aggregate. This does not prove a bug. |
| Decisive vote | Removing a successful vote changes majority/unanimous/weighted verdict over the remaining successful vote set. Infrastructure quorum admission is held separate; no remaining votes gives null. |
| Judge trigger | Removing the reviewer leaves unanimous successful votes in a judged judge-on-disagreement batch. |
| Third reviewer | Third configured policy-order job, independent of completion order; its deterministic leave-one-out decision change, unique finding or duplication is reported. |
| Rework chain | Rework round occurs after this logical review and before the next non-retry logical review. |
| Issue recurrence | Exact previous aggregate fingerprints repeated in the next completed review after Rework. Disappearance is called notRepeatedAfterRework, not fixed/correct. |

`review-issue-identity.ts` is shared with the execution aggregator: trim, collapse whitespace, lowercase description and sorted normalized files. No semantic clustering or LLM matching occurs. Highest severity wins consistently. Fingerprints are SHA-256 encodings of that conservative identity.

Historical job rows preserve member labels, profile IDs, weights and ordering. Historical snapshots preserve provider, account ID/label/strategy/policy, profile ID/name, executor candidate, requested/effective model and effort. Unknown legacy fields stay null. Current renamed profiles/accounts/policies are never substituted. Policy variants hash canonical batch strategy, failure policy, quorum, diversity, sorted reviewer profile/weight/priority values and judge profile.

Member tables count jobs; identity tables expose provider, provider+model+effort, provider+account and provider+account+model+effort. Votes/findings belong to the final execution identity. Attempt usage belongs to each actual attempt identity, so failed account A's usage is not attributed to successful account B. Rows sort by job count, with sample counts and low-sample warnings below ten observations. No model leaderboard or quality score exists.

## Usage, diversity and bounds

Known USD/tokens/duration sum non-null provider-reported values without correction. Cost coverage counts attempts with cost; token coverage requires both input and output token fields; partial fields still contribute to known additive totals. Duration coverage counts non-null attempt duration. Unknown totals are explicitly named known totals and accompanied by coverage; zero-denominator rates are null.

Batch duration is created-to-finished wall time. Summed reviewer attempt time and judge wall time are distinct; parallelismRatio is summed known reviewer time divided by known batch wall time, not exact speedup. Waiting duration is not invented. Durable failover rows supply counts and eventual job outcomes.

Diversity counts observed providers/accounts/effective models/provider-account pairs across reviewer identities, including attempted failed providers. Unknown identities do not manufacture extra distinct values. Requested diversity, achieved flags and identity coverage are returned. Comparisons label homogeneous/unknown together rather than treating missing identities as evidence of diversity.

The Single cohort derives existing `review_mode=single`, phase=review history and result snapshots. Round costs/tokens are not independently persisted, so their coverage and exact totals remain unknown; Todo-wide usage is not attributed to a review. Policy/strategy-specific queries intentionally omit the Single cohort. Derivable Single round duration and rework linkage are shown.

Analytics reads batches in 200-row keyset chunks and fetches jobs, attempts, feedback, rounds, actions and failovers in sets. SQL computes top fingerprints/member/identity keys and exact wall-time percentiles without collecting all batches or all distinct durations in JavaScript. Useful batch/job/feedback/action indexes support those access paths.

Responses bound members and execution identity groups to 100 each, policies to 100, issues to 200, daily dates to the latest 200 and batch pages to 200. Overflow flags explicitly disclose omissions. Policy overflow retains the first 100 variants in batch-ID scan order; filters expose further variants. Issue/member/identity retention is based on observed frequency/count, never a quality score. Summary totals remain independent of row limits. Batch details bound issue/attempt/feedback/action arrays to 200; narrow batch/project filters for additional inspection. CSV exports the current bounded batch page with total/has-more headers; advance offset for more pages.

The dedicated `/issues` endpoint also paginates fingerprints by `offset`/`limit` and returns total/hasMore, so findings beyond the dashboard's bounded first page remain accessible. Batch pagination and issue pagination are independent; root-response `offset` applies to batches.

Exports include only batch identifiers, historical policy variant, decision counts, diversity, known usage/coverage, duration and batch feedback label. JSON identity fields are explicitly whitelisted; raw prompts, configuration, env, MCP capabilities, credentials, stdout/stderr and SSH data are excluded. Issue text/files and snapshot labels are bounded and credential-redacted. CSV quotes fields and neutralizes formula-leading text.

## Product surface and evidence

Project Analytics offers Overview and Consensus Review tabs. Consensus includes summary usage/coverage, daily agreement, strategy/policy tables, separate member/identity views, diversity, judge, issues, feedback coverage, Single comparison, paginated batches and inline batch/reviewer/issue feedback. All added strings have matching EN/KO/RU keys and placeholders. Observational evidence and low-sample warnings remain visible. See [validation and smoke evidence](Consensus_Review_Evaluation_V1_Smoke_Report.md).

Dynamic AI Routing remains a separate future experiment, only after enough real execution and explicit human-label evidence accumulates.
