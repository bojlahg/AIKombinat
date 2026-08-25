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

---

### Next experiment cluster: Provider Accounts

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

### Next experiment: Consensus Review V1

Use multiple independent reviewers instead of treating one model's verdict as authoritative.

Initial shape:

```text
Implementation
  -> Reviewer A
  -> Reviewer B
  -> Reviewer C
  -> Consensus
      -> approved
      -> needs_changes
      -> judge/escalation when configured
```

V1 should prefer independent structured reviews over free-form multi-agent debate. Each reviewer produces its own persisted result using the review contract, then a deterministic consensus strategy aggregates the results.

Initial strategies worth supporting or experimentally comparing:

- majority vote;
- unanimous approval;
- weighted vote;
- judge model;
- judge only when reviewers disagree.

Design goals:

- reviewers may use different providers, accounts, models, and effort levels;
- prefer provider diversity where policy requests it;
- avoid using the implementation account as every reviewer when alternatives exist;
- persist every individual verdict plus the aggregate decision;
- retain bounded review/rework rounds;
- account quota, provider quota, concurrency, and shared resources still apply to every reviewer;
- one failed reviewer must have explicit policy semantics rather than silently disappearing from the vote.

Consensus should be observable enough to answer whether it actually improves defect detection or merely multiplies token usage with democratic ceremony.

---

### Experimental evaluation: Consensus strategies

Once Consensus Review V1 exists, use it as an experiment rather than immediately declaring one strategy "smart."

Track evidence such as:

- agreement/disagreement rates by provider/model/account;
- defects found by only one reviewer;
- false-positive/noise rates;
- rework rounds caused by each reviewer;
- final human approval/rejection where available;
- elapsed time;
- token/cost usage where providers expose it;
- whether a judge improves disagreement resolution enough to justify its cost.

This data can later inform routing instead of hardcoding folklore into the scheduler.

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
