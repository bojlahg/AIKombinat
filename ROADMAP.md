# AIKombinat experimental roadmap

This roadmap describes directions, not release commitments. AIKombinat is intentionally used as an experimental branch of the CLITrigger idea, so priorities may change when an experiment proves useful, useless, or impressively cursed.

The main near-term theme is no longer "make one coding CLI run." The current foundation can already select among multiple executors, wait for provider/resource capacity, persist review/rework rounds, and recover failed phases. The next experiments should test whether several providers, accounts, models, and reviewers can be coordinated into something measurably more reliable and efficient than a single agent run.

---

## Track A: autonomous development ("DarkFactory")

The DarkFactory track is the main software-development direction. It aims to move from manually selecting a CLI for each task toward observable, bounded autonomy that can plan, execute, review, rework, recover, and eventually coordinate heterogeneous AI workers.

### Completed foundation

These are implemented foundations rather than future roadmap items:

- Model Catalog in SQLite.
- Claude Code / Codex / Antigravity model discovery.
- OpenCode Executor V1 for headless implementation/rework and read-only review, with exact CLI-discovered models, Execution Profiles and Executor Pool admission. [Real Muse/Stop smoke](docs/OpenCode_Executor_V1_Smoke_Report.md) verified OpenCode 1.18.33; interactive/resume, V2, backend-aware quota and Delegation worker isolation remain follow-ups.
- Provider-native effort metadata and Antigravity provider-variant resolution.
- Execution Profiles with ordered executor/model/effort candidates.
- Late runtime executor resolution and persisted execution snapshots.
- Executor Pool availability routing and provider concurrency handling.
- Provider Quota Awareness V1 with `available`, `exhausted`, and `unknown` state, runtime quota rejection handling, cooldown/reset hints when known, and `waiting_quota` admission.
- Resource Manager V1 with persisted leases, atomic acquisition, heartbeat/expiry, stale recovery, `waiting_resource`, and shared resources such as `unity.editor`, `android.emulator`, `gpu.0`, `local.llm`, and `cpu.heavy`.
- Review / Rework V1 with persisted execution rounds and bounded `implementation -> review -> rework -> review` loops.
- Execution Round Retry & Recovery V1, including retry of only the failed/stopped current phase rather than rerunning the whole Todo.
- Restart/stale-process recovery for the execution lifecycle.
- Worktree-isolated task execution, schedules, sessions, discussions, review queue, and Git tooling.
- Test hardening that blocks accidental real AI CLI launches and prevents automated tests from mutating arbitrary project/root filesystem paths.

The existing review/rework flow is already a persisted coding pipeline. A future generic pipeline engine should therefore add genuinely new capabilities, not rebuild this state machine under a more fashionable noun.

### Paused experiment: AgentForum V1

AgentForum V1 (multi-agent discussion forums over Claude/Codex/Antigravity) is
currently a **paused / disabled experimental feature**: the implementation,
schema, migrations, and historical data are retained, but the UI entry points
are hidden and the server rejects new forum activity by default. Startup
recovery and Stop/cleanup for pre-existing forums keep working. It can be
re-enabled for development with `AIKOMBINAT_EXPERIMENTAL_AGENT_FORUM=1` plus a
restart.

---

### Implemented experiment: Delegation Router V0/V1

V0 — Telemetry
- observes provider tool calls and large file reads
- records normalized, privacy-bounded metadata and hook latency
- NO prompt/source content in telemetry
- bounded 30-day retention by default

V1 — bulk_read
- first real delegated operation
- cheap worker only:
  find / filter / summarize / rank / extract
- no architecture/debugging/implementation/review verdict delegation
- main model reads selected ranges itself
- use existing Model Catalog / Execution Profiles / ExecutorPool /
  ProviderQuotaService / ResourceManager / CLI adapters
- no second scheduler
- one delegation -> one worker execution in V1
- no persistent worker pool yet
- delegationDepth prevents recursion
- disabled by default; telemetry is the recommended first enabled mode
- Claude full-file `Read` supports conservative suggest/enforce; Codex shell reads remain telemetry-only
- worker lifecycle is fail-closed: every persisted PID is ownership regardless of status, startup/cancel/timeout races are CAS-guarded, and single-flight passive reconciliation releases capacity safely
- worker admission requires proven isolation: Claude is tool-less in disposable scratch; Codex/Antigravity are unsupported as V1 workers and skipped without affecting their primary execution paths
- managed hooks use portable app-data launchers, copied-bridge SHA-256 integrity, and definition-specific verification; primary Claude Delegation MCP injection preserves unrelated MCP configuration
- finished parent execution telemetry follows bounded retention without deleting unresolved child ownership

Current next step:
Broaden the [first real-world Claude V1 smoke](docs/Delegation_Router_V1_Real_World_Smoke_Report.md)
across varied repositories. It verified the hook, MCP worker, enforce-mode targeted
reads, and real character/latency metrics, while showing a worker relevance miss
and suggest-mode non-adoption after a full read. Measure fallback frequency,
primary follow-through, task/review outcomes, and total cost before wider rollout.

Next experiment (not implemented):
V2 — large output / logs
- test/build/compiler output summarization

---

### Following experiment cluster: Provider Accounts

Make provider identity account-aware instead of assuming one global login per CLI.

Conceptually:

```text
Provider
  -> Provider Account
      -> Executor
          -> Model / Effort
```

Examples:

```text
Claude
  -> personal
  -> work

Codex
  -> main
  -> backup

Antigravity
  -> ag-1
  -> ag-2
  -> ag-3
  -> ag-4
```

This must be a generic layer for Claude, Codex, Antigravity, and future providers. Do not implement an Antigravity-only account switcher and then rediscover the same concept twice more.

#### Provider Accounts V1

Status: **READY_WITH_LIMITATIONS** — isolated runtime identity is shipped; verified authentication strategies remain provider-specific.

Expected concerns:

- persistent account records with stable IDs and human labels;
- provider-specific authentication strategies kept at the provider edge;
- no raw OAuth/session secrets copied into ordinary execution snapshots;
- account enable/disable and health/auth state;
- account-level concurrency/capacity;
- account identity persisted in each execution snapshot;
- one account remains bound to a run/session for the lifetime of that CLI process;
- manual execution never silently changes account unless the user explicitly selected an automatic account policy.

Authentication may differ by provider (`system_keyring`, isolated OS user/security context, API key, OAuth profile, config directory, environment, external helper, etc.). Generic orchestration should consume an account context without depending on how that provider stores credentials.

#### Account-aware Quota V2

Status: **READY** — persisted account quota, derived aggregates, account cooldown/wake, APIs and live UI are accepted at the Evaluation Campaigns V1 baseline. See [implementation](docs/Account_Aware_Quota_V2.md) and [smoke evidence](docs/Account_Aware_Quota_V2_Smoke_Report.md).

Move quota state from only the provider level to the provider-account level.

Instead of:

```text
antigravity = exhausted
```

support:

```text
antigravity/ag-1 = exhausted
antigravity/ag-2 = available
antigravity/ag-3 = unknown
antigravity/ag-4 = available
```

Preserve the existing rules:

- `unknown` does not block execution;
- known `exhausted` blocks that account;
- provider/account concurrency and provider/account quota are different reasons;
- aggregate provider availability is derived from eligible accounts, not stored as a competing mutable truth;
- never fabricate reset times, model-level limits, or remaining percentages.

#### Quantitative quota telemetry

Where a provider exposes stable data, capture more than the V1 state:

```text
provider/account
  state
  observedAt
  resetAt
  window type
  used / remaining percentage or units when actually exposed
  source
  confidence / freshness
```

Possible windows may include short rolling limits, weekly limits, account-wide limits, or model-specific limits, but only when the provider actually exposes them.

The system must remain useful without quantitative telemetry. Reactive detection of a real quota-exhausted response is a valid source of truth when no reliable remaining-usage API exists.

#### Automatic Account Failover

Status: **READY** — automatic Todo/Review/Rework and Orchestrator attempts are bounded, preserve workspaces and durable lineage; fixed/inherited accounts and interactive Sessions stay pinned. Accepted at the Evaluation Campaigns V1 baseline. Next experiment: **Evaluation Campaigns V1**.

On a classified account-level provider failure:

```text
run on account A
  -> quota_exhausted
  -> mark A exhausted
  -> choose another eligible account B
  -> retry the current execution phase
```

Requirements:

- switch only after the old CLI process is fully terminated;
- preserve the existing worktree/current filesystem state;
- create a fresh execution attempt and snapshot for the replacement account;
- continue from current workspace state rather than blindly repeating completed work;
- prevent account loops (`A -> B -> C -> A -> ...`);
- if all eligible accounts are exhausted, enter `waiting_quota` until the earliest known reset or a quota/account state update;
- treat authentication failures separately from quota exhaustion;
- do not rotate accounts for ordinary build failures, agent mistakes, process crashes, invalid review JSON, or unrelated network errors.

This account-aware layer should become part of Executor Pool admission rather than a separate parallel scheduler.

---

### Consensus Review V1 implementation — READY_WITH_LIMITATIONS

Local validation, a real two-process Claude majority smoke and [implementation commit CI](https://github.com/bojlahg/AIKombinat/actions/runs/36775239802) passed for `ef3b764`. Acceptance: **READY_WITH_LIMITATIONS**. See [implementation and supported boundaries](docs/Consensus_Review_V1.md) and [real/synthetic evidence](docs/Consensus_Review_V1_Smoke_Report.md).

One logical Review round now fans out to 2–7 independent reviewer jobs with durable attempts. Majority, unanimous, weighted, judge and judge-on-disagreement retain individual dissent and a deterministic aggregate. Quorum/require-all, account quota failover, provider/account capacity, Resource Fabric waiting, read-only artifact checks, Stop/recovery and ordinary bounded Rework share the existing execution pipeline.

Real AI consensus is verified; heterogeneous diversity has synthetic evidence only because the installed Codex CLI failed with the configured model. Existing login/model state was preserved. Local Claude/Codex/OpenCode review is supported; remote, Antigravity and raw-shell reviewers are excluded pending isolation contracts.

The next experimental step is to collect agreement/disagreement, unique defects, rework causes, judge invocation/cost, provider/account/model observations and human outcomes. Dynamic AI Routing follows measured evidence.

---

### Consensus Review Evaluation / Telemetry V1 — READY

Implemented observational evaluation derives durable Consensus history, job votes, attempt usage/coverage, historical member/execution identities, policy variants, exact unique/shared findings, deterministic marginal contributions, judge behavior and review/rework chains. Explicit human feedback and human action audits are separate persisted observations. Project Analytics includes the dashboard, batch drill-down, feedback controls and bounded CSV export. See [definitions and boundaries](docs/Consensus_Review_Evaluation_V1.md) and [acceptance evidence](docs/Consensus_Review_Evaluation_V1_Smoke_Report.md). Accepted baseline `b6b4115` passed GitHub CI #82; no routing policy changes are enabled by evaluation.

### Evaluation Campaigns V1 — READY_WITH_LIMITATIONS

Project campaigns now assign new manual Todos deterministically to locked weighted review arms, preserve atomic assignment/configuration through restart, and expose integrity, attrition, ITT/PP, whole-Todo usage coverage, symmetric helpfulness feedback and raw control comparisons. Ordinary implementation selection, admission, failover and orchestration stay on their existing paths. See [definition and API contract](docs/Evaluation_Campaigns_V1.md) and [controller, migration and browser smoke evidence](docs/Evaluation_Campaigns_V1_Smoke_Report.md).

Real enrollment, controller restart and browser lifecycle/override/withdrawal/feedback passed on disposable state. Review outcomes in this smoke are explicitly synthetic because no safe/free live-provider path was established. Final acceptance requires the delivered commit's green GitHub CI. Next: run real campaigns and accumulate evidence before Dynamic AI Routing V1.

Real AI treatment acceptance now has a reproducible manual command, `npx tsx scripts/evaluation-campaign-real-ai-smoke.ts`, with disposable DB/Git state, existing-profile eligibility, real 1:1 assignment search, bounded Single/Consensus execution, process/artifact/integrity/analytics evidence and guarded cleanup. The 2026-10-01 run reported **SKIPPED_ENVIRONMENT**: existing profiles reference models absent from current discovery; no AI implementation/review was launched. **READY_WITH_LIMITATIONS** is retained. Promote to READY only after real PASS plus delivered-commit green CI. One Todo per arm is acceptance evidence, not comparative quality evidence; no routing, winner selection or promotion is introduced.

Track evidence such as:

- agreement/disagreement rates by provider/model/account;
- findings observed by only one reviewer;
- confirmed/rejected finding labels with feedback coverage;
- rework rounds caused by each reviewer;
- final human approval/rejection where available;
- elapsed time;
- token/cost usage where providers expose it;
- how often a judge changes the reviewer majority, together with known cost and coverage.

Agreement is not correctness. Accumulate ordinary real batches and practical human issue labels before the next separate experiment: Dynamic AI Routing V1.

---

### Later: Dynamic AI Routing

Move beyond a static ordered fallback chain.

A router may choose among eligible execution profiles/providers/accounts/models/effort levels using task characteristics plus live availability:

```text
task intent / complexity / required capabilities
  + provider/account availability
  + quota telemetry
  + resource availability
  + historical quality/cost evidence
    -> execution choice
```

Principles:

- routing decisions must be persisted and explainable;
- no silent semantic fallback;
- weak or missing telemetry should reduce confidence, not invent certainty;
- deterministic/manual profiles remain available as a control group and escape hatch.

---

### Later: cost / quality escalation policies

Experiment with staged policies instead of always spending the most expensive model first.

Examples:

```text
cheap implementer
  -> cheap reviewer
  -> disagreement / failed review
  -> stronger reviewer or judge
```

or:

```text
medium effort
  -> failed phase
  -> retry with higher effort
```

The point is not "cheapest wins." The point is to measure when escalation improves success enough to justify latency and quota consumption.

---

### Later: DarkFactory Planner / decomposition

Add a planning stage that can turn a larger goal/spec into bounded executable work rather than requiring a human to pre-create every Todo.

Expected responsibilities:

- decompose a goal into tasks;
- define dependencies and acceptance criteria;
- assign or recommend execution profiles;
- identify required shared resources;
- define human approval points;
- cap task count, depth, retries, review rounds, time, and cost/token budgets;
- persist the plan so restart/recovery does not require replanning from scratch.

Planner output should be inspectable and editable before execution. Autonomous decomposition that cannot explain what it created is just automated backlog pollution.

---

### Later: generic resumable pipelines / DAGs

Only after there are enough genuinely different step types, generalize the existing coding state machine into a broader persisted workflow abstraction.

A future pipeline may look like:

```text
Research
  -> Implement
  -> Run Unity
  -> Capture screenshot
  -> VLM QA
  -> Rework
  -> Build artifact
  -> Human approval
```

Useful generic pipeline capabilities may include:

- typed steps/executors;
- dependencies / DAG execution where actually needed;
- persisted inputs, outputs, artifacts, and execution snapshots;
- retry/recovery per step;
- resource/account/provider admission per step;
- conditional branches;
- human approval gates;
- restart recovery;
- artifact handoff between heterogeneous executors.

Do not replace the working Review/Rework execution-round model just to achieve abstraction purity. Generalize only when multiple real workflows prove the common shape.

---

## Track B: broader AI Kombinat experiments

The repository name is intentionally broader than autonomous coding. Independent "workshops" may reuse the same scheduling, account, resource, model, logging, artifact, and pipeline infrastructure.

Candidate workshops:

- batch image generation;
- image transformation / asset production;
- multimodal QA;
- transcription and summarization;
- audio/music utility pipelines;
- local LLM jobs;
- local VLM jobs;
- scheduled research or data-processing tasks;
- mixed pipelines where coding agents produce tooling used by media or data jobs.

These should not each invent their own scheduler, retry logic, resource locks, account handling, or telemetry format. They belong in AIKombinat only when enough infrastructure is genuinely shared.

---

## Architectural principles

1. **One mutable source of truth per concept.** Avoid parallel mutable registries that slowly disagree with each other.
2. **Provider adapters at the edge.** Generic orchestration should not depend on one CLI's naming, authentication storage, quota messages, or output quirks.
3. **Account identity is execution identity.** Once Provider Accounts exist, snapshots and capacity decisions must record the actual account used, not merely the provider.
4. **No silent semantic fallback.** If a requested provider/account/model/effort is unsupported, report it instead of quietly changing the request unless an explicit automatic policy permits a fallback.
5. **Weak discovery is not authority.** Partial or malformed provider output must never destroy known-good state.
6. **No fake telemetry.** Unknown quota, reset, remaining usage, cost, capability, or resource data stays unknown.
7. **Late binding where availability matters.** Resolve executors/accounts when work starts, not days earlier when the task is created.
8. **Everything autonomous should be observable.** Persist decisions, snapshots, errors, retries, account switches, reviewer verdicts, and reasons for waiting.
9. **Bounded automation.** Retries, account failovers, rework rounds, planning depth, token/cost budgets, and time limits need explicit ceilings.
10. **Recovery before cleverness.** A less sophisticated policy that survives restart and partial failure is more useful than a brilliant one that loses state.
11. **Experiments stay replaceable.** Avoid compatibility burdens for designs that have not earned them yet.
12. **Measure experimental features.** Consensus, routing, judges, and escalation policies should produce evidence that can be compared against simpler baselines.

---

## Not the immediate goal

The current roadmap does not require turning AIKombinat into a hosted multi-tenant SaaS, a universal agent protocol, a provider-account farming tool, or a fully autonomous company simulator.

The near-term goal is smaller and more useful: make local AI-assisted development substantially more reliable, inspectable, quota-aware, account-aware, experimentally measurable, and capable of finishing longer chains of work without constant manual babysitting.

## Orchestrator Agent V1 implementation — READY

Implemented and locally accepted with real Claude Opus 4.7 and exact free Muse child execution: durable orchestration/turns/chat/inbox/idempotency, automatic fresh-process wake, ordinary Todo review/rework and worktrees, bounded Resource Fabric holds with reserve-before-wake and same-binding claim, budgets, safe controls/recovery and EN/KO/RU UI. Real delegation/review, parallel siblings/integration, CPU contention/handoff and human-message wake passed; a two-controller synthetic restart preserved state and prevented duplicate mutations. See [design](docs/Orchestrator_Agent_V1.md) and [acceptance evidence](docs/Orchestrator_Agent_V1_Smoke_Report.md). Security closure adds canonical server-secret stripping, a 256 KiB UTF-8 primary context cap, byte-bounded event delivery and drained headless streams; 100 local raw-shell repetitions and a real post-fix Claude checkpoint/finish smoke passed. Remote CI status is part of final delivery; V1 provider/depth/ANY boundaries remain product scope constraints. Subsequent extensions stay separate tasks.

## Resource Fabric V2 implementation

Resource Fabric V2 is **READY_FOR_ORCHESTRATOR**: detected local/SSH nodes, policy and observations, deterministic matching, persisted bindings, exclusive GPU/custom and quantitative CPU/RAM leases, ownership UI, and isolated Linux SSH headless raw-shell execution. See [design and boundaries](docs/Resource_Fabric_V2.md) and [final closure](docs/Resource_Fabric_V2_Final_Closure_Report.md). Real GPU binding/contention/wake, controller restart and Force Stop passed; final reserve-after-current proved reservation-before-wake, no transient/double lease and automatic unreserve wake on a safely free local RTX 5060 Ti. External workloads were untouched. Remote OpenCode is unsupported in V2; capability probing is retained for future work, behind a default-OFF developer execution switch. Orchestrator Agent V1 now uses its bounded holds and binding handoff. Executor Pool and provider quota remain separate layers.
