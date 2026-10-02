# Evaluation Campaigns V1

Project campaigns assign new, manually created Todos to persisted review strategies before execution. A campaign has 2–6 enabled arms, exactly one enabled control, positive integer weights (1–1000), and a Single Review profile or Consensus Review policy per arm. Optional Rework profile and review-round limit are the only additional treatment fields. Implementation provider, profile, model, effort, account policy, prompt, dependencies, resources, Wiki inputs and worktree settings follow the ordinary Todo path.

The feature records evidence for future routing decisions. It does not change executor selection, provider failover, scheduler admission, quota handling, Resource Fabric or orchestration decisions, and does not select a winner.

## Lifecycle and enrollment

Create and edit drafts in **Project → Automation → Analytics → Evaluation campaigns**. Auto-enroll defaults OFF. Start validates references, creates definition hashes and locks the definition. The lifecycle is `draft → running ↔ paused → completed → archived`. Pause, Complete and Archive preserve assigned Todos and their pipeline. Only unstarted, empty drafts can be deleted. Clone produces a new draft with fresh IDs and salt, unchanged treatment settings, and auto-enroll OFF.

After Start, only campaign name/description and lifecycle actions are editable. Arms, weights, control, salt, algorithm, auto-enroll and assignment cap stay locked. To change enrollment policy or treatment, clone and start a new campaign. At most one running auto-enroll campaign exists per project; both the service and a partial unique index enforce this. Optional assignment caps are 2–100000; reaching the cap atomically completes enrollment. Withdrawals still consume an assignment slot.

The ordinary manual Todo form can explicitly enroll in a running campaign or opt out. With a running auto-enroll campaign, enrollment is checked by default. The arm is revealed only after successful creation. Existing Todos, schedule-created Todos, delegated children and internal `createTodo` callers are not backfilled or auto-enrolled. The canonical manual HTTP creation path wraps Todo insertion, existing configuration updates, treatment application and assignment insertion in one immediate SQLite transaction; any failure rolls everything back. Scheduled/delegated creation cannot use that enrollment wrapper to participate.

## Assignment contract

`sha256_weighted_v1` hashes UTF-8 `assignment_salt + ':' + todo_id`. The salt is 32 cryptographically random bytes persisted as hexadecimal. Interpret the **first eight digest bytes as an unsigned big-endian 64-bit integer**, using BigInt, then take modulo the sum of enabled weights. Sort arms by `(sort_order, id)` with lexical ID ordering. Select the first cumulative half-open weight range containing the bucket. No outcome, runtime load, quota or history enters this calculation.

Independent golden vectors for salt `0123456789abcdef0123456789abcdef` and ordered weights `3:1`:

| Todo ID | Bucket | Range |
| --- | ---: | --- |
| `todo-1` | 3 | experiment `[3,4)` |
| `todo-2` | 0 | control `[0,3)` |
| `todo-3` | 3 | experiment `[3,4)` |
| `todo-4` | 1 | control `[0,3)` |
| `00000000-0000-0000-0000-000000000000` | 2 | control `[0,3)` |

Each Todo has at most one assignment. Persisted algorithm, digest, bucket, campaign/arm hashes, safe arm snapshot and assigned deep review-config hash remain immutable through retries, rework, Stop and controller restart. Production create/update routes reject `evaluation_arm_id`; they never accept a client-selected treatment.

## Integrity and timing

Assignments begin `clean`. Ordinary review-field edits return HTTP 409 `experiment_assignment_locked`. The explicit UI Override action sends `evaluation_override: true`; an actual review-config change and `clean → contaminated` transition occur atomically, preserving the original arm. Non-review changes and unchanged review values do not contaminate.

Withdrawal is available only while clean and before implementation/review start. It records `excluded / withdrawn_before_execution`, unlocks ordinary review controls and retains the assignment for audit. Contaminated/excluded states never revert to clean. Campaign-assigned Todos cannot be individually deleted through the ordinary Todo API, preventing silent removal from ITT; Stop and withdrawal are the supported task-level actions.

At the first actual implementation launch, record `first_execution_at` once. Both Single and Consensus review entry points record `review_started_at` once and check the treatment immediately before review. Canonical JSON recursively sorts object keys and orders arm/profile/policy members deterministically. The deep hash includes review mode/enablement, referenced profile IDs and enabled candidate provider/model/effort/account-policy/fixed-account configuration, candidate priority, Consensus strategy/failure/quorum/diversity/parallelism, member enabled/weight/priority configuration, judge profile, Rework profile and review-round limit. Missing references and semantic edits count as drift. Campaign/arm mismatch and review-configuration drift have separate reason codes.

Quota observations, account health/cooldown, model availability, runtime admission and actual fallback selection are excluded from this hash. Actual identities are observed separately. Stop, retry, manual Approve/Rework and ordinary provider failover do not themselves contaminate. Terminal lifecycle callbacks persist `finished_at`; retry completion refreshes that timestamp while retaining the original implementation start, so Todo wall time includes intervening waits and retries.

## Analytics and denominators

Analytics is a read-only projection of durable assignments, Todo status, execution rounds, Consensus attempts, human actions and campaign feedback. ITT is the default; it retains contamination in its assigned arm and omits pre-start withdrawals. PP includes clean assignments. Attrition is also returned over all assignments, including exclusions.

| Metric | Population / denominator |
| --- | --- |
| Assigned, started, reached review, terminal, completed, failed, stopped | Selected ITT/PP population; start/review timestamps and current Todo status. Merged counts as completed. |
| Completion/failure rate | Completed/failed divided by selected assignments. |
| Final approved / needs changes | Reached-review Todos with a completed latest final Review result; `finalReviewSamples` is explicit. |
| Rework rate | Reached-review Todos with at least one started Rework divided by reached-review Todos; numerator and denominator are explicit. |
| Manual Approve/Rework | Durable human-action counts for reached-review Todos. |
| Todo wall time | Terminal Todos with valid implementation-start and finish timestamps; sample count plus mean/P50/P95 in milliseconds. |
| Known treatment cost/I/O tokens | Sum over all started ordinary rounds plus Consensus reviewer/judge attempts, with known/started attempt coverage. I/O is input + output only; cache tokens are separate. All unknown yields null. |
| Fully covered Todo cost | Average and P50 cost include only started Todos with cost coverage 1. Raw covered/started Todo counts and coverage accompany them. |
| Feedback response/evaluation coverage | Response/evaluative count divided by reached-review Todos. |
| Helpful rate | `helpful / (helpful + not_helpful + mixed)`; unknown is a response but not an evaluative judgment. |

Review verdict, rework, manual-action and helpfulness metrics require review start in both protocols. Treatment usage, wall time and attrition retain implementation-only failures. Treatment accounting includes failed attempts, retries, account failover, Single Review, rework, review-after-rework, Consensus retries and judges. Known partial sums always carry coverage; compare average/P50 cost per fully covered Todo with raw N and coverage, never unequal-arm aggregate sums as efficiency.

Each experiment reports control value, arm value, arm-minus-control difference and arm/control ratio. Missing values remain null; a zero control yields a null ratio. Expected weighted and observed assignment distributions, clean/contaminated/excluded counts and a warning below 10 assignments are visible. There is no significance estimate, confidence interval, winner or routing recommendation.

Actual provider/account/model/effort distributions count distinct Todos for each observed identity across execution rounds and Consensus attempts. A Todo may appear in multiple identities after failover. Identity sets are descriptive, protocol-filtered and capped at 100 entries per category, with omitted counts; they do not create post-hoc treatment groups.

## Campaign feedback and privacy

Campaign feedback asks whether the overall review was helpful, symmetrically for Single and Consensus. Labels are `helpful`, `not_helpful`, `mixed`, `unknown`; one current updatable record belongs to an assignment. Feedback requires review start. Notes accept plain text up to 4 KiB UTF-8, reject HTML, and use shared secret redaction before storage. Campaign feedback is separate from Consensus batch/job/issue correctness/usefulness feedback; those records are not copied into campaign helpfulness.

Analytics and CSV use explicit safe projections, omitting prompts, descriptions, notes, outputs, issue payloads, authentication tokens, credentials, environment, authentication and full execution snapshots. CSV escapes cells and prefixes spreadsheet formula-leading content. INFO logs and WebSocket events carry bounded identifiers/status only; they never carry feedback notes or task prompts. Assignment drill-down contains safe treatment metadata and hashes, rather than full provider configuration.

## API and live updates

All routes use the existing authenticated API mount. Project-path routes scope directly to the project. ID routes require `projectId` in the query or request body and verify ownership.

| Method | `/api` path |
| --- | --- |
| GET / POST | `/projects/:projectId/evaluation-campaigns` |
| GET / PATCH / DELETE | `/evaluation-campaigns/:id` |
| POST | `/evaluation-campaigns/:id/start`, `/pause`, `/resume`, `/complete`, `/archive`, `/clone` |
| GET | `/evaluation-campaigns/:id/analytics`, `/assignments`, `/export.csv` |
| GET | `/todos/:id/evaluation-assignment` |
| POST | `/todos/:id/evaluation-assignment/withdraw` |
| PUT | `/todos/:id/evaluation-assignment/feedback` |

Todo creation accepts `evaluation_campaign_id` with `evaluation_campaign_enroll: true` for explicit enrollment. `evaluation_campaign_enroll: false` opts out; omission permits the project's running auto-enroll campaign. Review override uses the existing Todo PUT endpoint. Invalid input is 400, scoped missing objects 404, lifecycle/assignment conflicts 409.

Assignments and CSV default to 100 rows, permit `limit=1..200` and `offset=0..1000000`, and expose total/has-more metadata. CSV headers include `X-Total-Count`, `X-Has-More`, `X-Next-Offset`; the UI combines bounded pages into a download. Analytics responses aggregate rather than returning all histories; a 10000-assignment regression enforces bounded output size.

Events: `evaluation-campaign:created`, `:updated`, `:status`, `:assignment`, `:assignment-updated`, `:feedback-updated`. Dashboard and open Todo assignment details refresh on relevant events. EN/KO/RU core strings and placeholders retain parity. Floating UI uses the shared portal Modal and established menus.

## Persistence and validation

Four additive tables are installed after existing review evaluation migrations: `evaluation_campaigns`, `evaluation_campaign_arms`, `evaluation_campaign_assignments`, `evaluation_campaign_assignment_feedback`. Indexes cover project/status, arm ordering and campaign/arm assignments. Constraints enforce Todo/feedback uniqueness and same-campaign arm ownership. Triggers protect started definitions and monotonic assignment integrity. Migration is idempotent; no historical Todo is assigned or rewritten. The ERD generator includes all four tables.

See [testing instructions](TESTING.md) and [smoke evidence](Evaluation_Campaigns_V1_Smoke_Report.md). Before using evidence for Dynamic AI Routing V1, run real campaigns on ordinary tasks, inspect attrition/coverage/feedback and accumulate adequate samples.

## Real AI treatment acceptance

Run `npx tsx scripts/evaluation-campaign-real-ai-smoke.ts` manually with existing Execution Profiles. The command reads selection metadata from `DB_PATH` (or the ordinary repository DB) read-only and copies only catalog/profile/policy metadata and inherited account/quota state into a fresh OS-temp SQLite DB. It never copies existing tasks, credentials or ownership, opens the source for execution, logs in/out, or changes provider configuration. CLI catalog discovery and non-mutating account probes operate against the disposable state. Every enabled fallback in a selected profile must qualify; missing/stale/fixture models cannot authorize execution. OpenCode requires a live-listed free/local candidate; Claude/Codex require a confirmed inherited login. No eligible existing profile yields `SKIPPED_ENVIRONMENT`.

The seed Git repo uses Node's built-in tests and has no network dependencies. Identical manual Todos receive real 1:1 campaign assignments, with auto-enroll OFF and at most 12 candidates. Extra assignments are withdrawn before sequential Control and Experiment execution. Both use the same implementation profile, strict sandbox and isolated worktrees from the persisted failing baseline. Control runs Single Review; Experiment runs a two-member unanimous, require-all Consensus policy by default, with parallelism 2. Both treatments allow ordinary rework and cap review rounds at 2. No approval is forced and neither branch is merged.

Disposable observation tables retain actual process identities, snapshots, exits and config hashes without replacing execution services. Acceptance verifies passing tests before review and at completion, unchanged tests, changed source, real review attempts, immutable artifact identity, clean assignments, ITT/PP outcomes and empty owned PID/lease/reservation state. Unknown usage stays null. Feedback is never created by this smoke. Reports exclude prompts, credentials and provider output; bounded event logs contain only diagnostic identifiers. Default cleanup removes DB/repo/worktrees after writing evidence and retains `report.json` plus bounded logs. `--keep` retains disposable data; `--serve` also retains it and exposes only the loopback smoke controller until interruption.

Optional selectors are `--implementation-profile=<id>`, `--single-review-profile=<id>` and `--consensus-policy=<id>`. Selectors reference existing source metadata; they cannot select an arm or bypass eligibility. A supplied Consensus policy must use require-all, parallelism 2, and either two/three unanimous reviewers or a three-reviewer majority. `--timeout=<seconds>` defaults to 900; timeout/interruption stops only owned work through normal Stop, checks ownership and retains unresolved data for recovery.

**THIS RUN IS ACCEPTANCE EVIDENCE, NOT COMPARATIVE QUALITY EVIDENCE.** One completed Todo per arm verifies assignment → implementation → review → analytics. It cannot identify a better, cheaper or more helpful treatment. Status is **READY** after the 2026-10-02 real bootstrap `PASS` and [delivered-fix green CI](https://github.com/bojlahg/AIKombinat/actions/runs/36979939589) for `6e8add0`. CI runs synthetic/unit coverage only; it never invokes the real-provider command.

## Disposable profile bootstrap (2026-10-02)

The real smoke requires `--allow-real-ai` before any implementation, review, retry or rework can launch. Without it, successful non-inference checks return `PRECHECK_READY`. Existing-profile selection remains available without the bootstrap flag.

```bash
npx tsx scripts/evaluation-campaign-real-ai-smoke.ts --bootstrap-disposable --bootstrap-provider=claude --implementation-model=claude-haiku-4-5-20251001 --review-model=claude-haiku-4-5-20251001 --implementation-effort=provider-default --review-effort=provider-default
```

For an explicitly authorized real run, append `--allow-real-ai`. Bootstrap supports Claude, Codex and free/local OpenCode models. Both exact models must belong to the explicit provider and appear in its latest successful refresh; non-authoritative Claude presence is accepted. Missing models never trigger fallback. Effort is checked against model capabilities; OpenCode effort overrides are rejected. `provider-default` maps to null.

Only disposable profiles are created. Enabled inherited accounts are probed without login/logout; known account exhaustion blocks selection and unknown quota is allowed. `--bootstrap-account` is explicitly rejected in V1 because credential-bearing account configurations are never copied. Bootstrap rejects existing profile/policy selectors, creates one candidate per profile, proves reconciliation READY/current/no-repair, and proves exact ExecutorPool selection with zero reservations. The generated policy uses two distinct reviewers, unanimous/require-all, and normal capacity admission.

`--max-real-ai-processes=<n>` defaults to 8 and requires at least 5. A guard at both native AI spawn paths refuses the next launch once the limit is consumed, including retries and rework. Failed spawn attempts conservatively consume budget; persisted process evidence separately counts actual launches. Review rounds remain capped at two. Runtime snapshots are compared with the explicit provider/model/effort/account policy. The requested model must also equal the resolved effective model.

Source DB/WAL/SHM SHA-256 fingerprints are recorded before/after read-only copying. A changed fingerprint returns `source_changed_concurrently`, never an unchanged-source claim. Prefer running with the normal app stopped. Reports retain bounded identifiers, snapshots, exits, duration and coverage; they exclude prompts, credentials and raw provider transcripts. Cleanup proves no owned Todo/reviewer PID, resource lease or ExecutorPool reservation.

**THIS RUN IS ACCEPTANCE EVIDENCE, NOT COMPARATIVE QUALITY EVIDENCE.** Promotion still requires real smoke PASS plus delivery-commit green CI.

The 2026-10-02 exact Haiku bootstrap run now passed Control implementation/Single Review, Experiment implementation/two-reviewer Consensus, ITT/PP, immutable artifacts and clean ownership cleanup. Read-only source fingerprints matched; five real processes were used. See [PASS evidence](Evaluation_Campaigns_V1_Smoke_Report.md#real-ai-pass-closure--2026-10-02). Evaluation Campaigns V1 is **READY**: [delivered-fix CI](https://github.com/bojlahg/AIKombinat/actions/runs/36979939589) for `6e8add0` completed successfully. Smoke process triggers never call JavaScript functions that read the executing SQLite connection; actual review-start hashes are captured outside triggers. Implementation tests run at artifact collection before the completed-status transition.

Duration semantics: Todo wall-clock remains assignment.first_execution_at → assignment.finished_at and can include quota/executor waits, review/rework, human pause and manual retry delay. Process wall-clock (attemptWallDuration) is locally observed attempt runtime, independently of provider telemetry. Provider-reported duration (providerDuration) is available only when the provider reports it. Both metrics expose known sums, started-attempt counts and coverage in every phase and attrition/ITT/PP population. Waiting attempts with no start are excluded; invalid negative/nonfinite values are ignored and known zero is retained. Failures, stops and recovery preserve observable wall time without fabricating provider duration.

For example, implementation 10s + human wait 30m + retry 10s gives Todo wall-clock ≈ 30m20s and summed process wall time ≈ 20s.

The compatibility column duration_ms is deprecated: ordinary aliases provider_duration_ms; Consensus aliases attempt_wall_duration_ms. Canonical treatment aggregates never read this mixed legacy column. API/CSV exposes known_attempt_wall_duration_ms, attempt_wall_duration_attempts_known/total/coverage and known_provider_duration_ms, provider_duration_attempts_known/total/coverage. Arm metrics expose the equivalent camelCase fields.
