# AIKombinat experimental roadmap

This roadmap describes directions, not release commitments. AIKombinat is intentionally used as an experimental branch of the CLITrigger idea, so priorities may change when an experiment proves useful, useless, or impressively cursed.

## Track A: autonomous development ("DarkFactory")

The DarkFactory track is the main software-development direction. It aims to move from manually selecting a CLI for each task toward a resumable, observable pipeline that can plan, execute, review, and rework tasks with bounded autonomy.

### Foundation - current / in progress

- Model Catalog in SQLite.
- Claude Code / Codex / Antigravity model discovery.
- Provider-native effort metadata.
- Execution Profiles with multiple executor candidates.
- Runtime executor resolution.
- Execution snapshots/history.
- Worktree-isolated task execution.
- Scheduled execution, sessions, discussions, review queue, and Git tooling inherited from CLITrigger.
- CI gate for typecheck, tests, and build.

### Next: Executor Pool

Replace simple "first eligible candidate" selection with an executor pool that can consider current availability.

Expected concerns:

- installed CLI / authenticated provider;
- per-provider concurrency slots;
- model availability;
- task compatibility;
- deterministic fallback order;
- clear WAITING_EXECUTOR state instead of mysterious retries.

### Next: quota awareness

Read provider quota/rate-limit information when a stable source exists.

Principles:

- distinguish `available`, `exhausted`, and `unknown`;
- never invent model-level quota data that the provider does not expose;
- release an executor when runtime quota rejection occurs;
- allow another eligible executor when policy permits.

### Next: Resource Manager

Add shared resource leases for things that cannot be used by every task simultaneously.

Examples:

- `unity.editor`
- `android.emulator`
- `gpu.0`
- `local.llm`
- `cpu.heavy`

Requirements include atomic acquisition, lease expiry/heartbeat, stale recovery, and WAITING_RESOURCE without consuming normal project concurrency.

### Next: Review / Rework

Make review a first-class workflow stage rather than only a human UI action.

Desired loop:

```text
implementation
  -> review
      -> approved
      -> rework request
          -> implementation round N+1
```

The review layer should expose summaries, diffs, QA evidence, and bounded rework rounds.

### Later: resumable pipelines

Compose planning, execution, QA, review, and rework into a persisted pipeline.

A useful pipeline must survive:

- application restart;
- provider quota exhaustion;
- executor failure;
- stale processes;
- resource waits;
- partial task completion;
- human approval points.

Autonomy without recovery is just a more elaborate way to lose state.

---

## Track B: broader AI Kombinat experiments

The repository name is intentionally broader than autonomous coding. Future experiments may include independent "workshops" that reuse the same scheduling, resource, model, logging, and pipeline infrastructure.

Possible areas:

- batch image generation;
- image transformation / asset production;
- multimodal QA;
- transcription and summarization;
- audio/music utility pipelines;
- local LLM/VLM jobs;
- scheduled research or data-processing tasks;
- mixed pipelines where coding agents produce tooling used by media or data jobs.

These ideas should only become core features if they share enough infrastructure with the main application to justify living here.

---

## Architectural principles

1. **One mutable source of truth per concept.** Avoid parallel mutable registries that slowly disagree with each other.
2. **Provider adapters at the edge.** Generic orchestration should not depend on one CLI's naming or output quirks.
3. **No silent semantic fallback.** If a requested effort/model is unsupported, report it instead of quietly changing the request.
4. **Weak discovery is not authority.** Partial or malformed provider output must never destroy known-good state.
5. **Late binding where availability matters.** Resolve executors when work starts, not days earlier when the task is created.
6. **Everything autonomous should be observable.** Persist decisions, snapshots, errors, retries, and reasons for waiting.
7. **Bounded automation.** Retries, rework rounds, token/cost budgets, and time limits need explicit ceilings.
8. **Experiments stay replaceable.** Avoid compatibility burdens for designs that have not earned them yet.

---

## Not the immediate goal

The current roadmap does not require turning AIKombinat into a hosted multi-tenant SaaS, a universal agent protocol, or a fully autonomous company simulator.

The near-term goal is smaller and more useful: make local AI-assisted development substantially more reliable, inspectable, and capable of finishing longer chains of work without constant manual babysitting.
