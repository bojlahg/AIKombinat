# Evaluation Campaigns Real-World Pilot V1

## Scope and current gate

Evaluation Campaigns V1 is READY: real acceptance PASS and delivery CI for `6e8add0` are recorded in [the acceptance report](Evaluation_Campaigns_V1_Smoke_Report.md#real-ai-pass-closure--2026-10-02).

On 2026-10-02 the user explicitly requested a temporary test project, a simple task and limited AI usage. This supersedes real-work-only scope for the setup exercise, but does not turn synthetic work into real-world evidence. The real-world Pilot remains NOT_STARTED; its clean terminal sample is zero. No routing/default promotion is authorized.

## Temporary setup exercise, frozen before Start

Application: AIKombinat 0.2.49 at `23efeeb360d3caa7a77796fd8b4fe31545622ee9`.
Separate database and Git fixture: `data/pilot-20261002/`; existing application data is not opened or copied. Loopback server: `http://127.0.0.1:3747`, no tunnel. Runtime files are ignored local test artifacts, not a supported setup helper.

Project: `Campaign Pilot Setup Test`, ID `294fad7f-913e-4c12-8712-ede75ba48efd`.
Campaign: `Single vs Consensus — Temporary Setup Test V1`, ID `2f3a9a94-1df3-46c5-a951-739a30f8eff3`.
Project and draft campaign were created through product UI. Start freezes the definition; its hash is recorded in the report. Auto-enroll OFF; weights 1:1; normal `sha256_weighted_v1`; no forced arm, retro-enrollment or extra task generation for balance.

| Setting | Control | Experiment |
|---|---|---|
| Review mode | Single | Consensus |
| Implementation and Rework profile | `0e906c0c-1769-431d-ad61-e7f654012446` | Same |
| Single/member review profile | `dd95c1a1-5a87-45ce-8069-7a582d4e68cc` | Same profile, two independent jobs |
| Consensus policy | None | `5129fb2e-d558-4a1d-a227-0560848e6294` |
| Max review rounds | 2 | 2 |
| Allocation weight | 1 | 1 |

Both profiles use exact `claude-haiku-4-5-20251001`, provider-default effort, inherited-default account policy, one enabled candidate and no alternative model. Both reconciled READY; ExecutorPool selected the exact candidates with zero reservations. Policy: unanimous, require_all, two members, parallel reviewers=2, judge OFF. Implementation/worktree/resource/retry settings are identical for any participating task; only one task will run in this exercise.

Task: correct `Helo` to `Hello` in a one-line JavaScript export; run the existing Node test. Worktree ON, maximum implementation turns=6, no dependencies/install, no automatic delegation. Hard launch guard permits at most three total implementation/review/rework processes, persisted across restart. The startup inference probe is disabled in this temporary launcher. A process cap is not a token or currency cap; report only provider-exposed usage and coverage. Do not rerun after quota/auth/provider failure.

## Real-world protocol, deferred

Choose one actual working project and create a separate campaign named `Single vs Consensus — Real-World Pilot V1` before enrollment. Freeze explicit healthy profile/policy identities and hashes, prompts, account/failover, resources/worktrees, priority and retries before Start. Use the same two-arm policy above, explicit enrollment and auto-enroll OFF. No synthetic setup Todo enters that campaign.

Before real enrollment, freeze an explicit sensible implementation max-turn setting and record it in the protocol, identical across both arms. The synthetic setup exhausted `max_turns=6`, while its authorized retry completed with `max_turns=20`; use that evidence when choosing the frozen setting. No global max-turn default changes. The real Pilot remains NOT_STARTED and temporary setup evidence remains excluded.

Target: at least 30 clean terminal real Todos, at least 12 per arm; minimum exploratory target 20, preferred 30–50. Exclude withdrawal, pre-execution abort, contamination, environment-only failure and manual treatment drift from primary PP. Retain exclusions and contamination in integrity/attrition evidence and applicable ITT; existing product ITT omits pre-start withdrawals. Distinguish environment, agent/product, user stop and unknown failures.

Request real human Helpful/Not helpful labels after review, aiming for at least 50% coverage, preferably 70%+. Never create labels from tests, AI judgments or agreement. Report Helpful/labeled and labeled/total, raw N, known usage/coverage, persisted durations, disagreement batches/Consensus batches, unique/shared findings and Todos with rework/terminal Todos. Existing product rework and feedback denominators differ: preserve their definitions and derive the Pilot denominators explicitly rather than relabeling them. Unknown usage stays unknown; absent waiting durations stay unavailable. Agreement is not correctness.

Checkpoints near 10 and 20 clean terminal Todos; final at 30–50, with at least 8 per arm for any descriptive interpretation (prefer 12–15). Below 10 per arm, descriptive only; below 30% human coverage, no quality interpretation. No winner badges, significance claims or adaptive model/prompt/allocation changes.

Pause immediately for config corruption, treatment leakage, broken isolation, reviewer artifact mutation, owned-process leaks or integrity falsely remaining clean after drift. Treatment/assignment/prompt/analytics semantics changes require closing/versioning the campaign. Ordinary environment outages can be recorded and resumed. Verify assignment/round/feedback persistence through restart before considering auto-enrollment; current product freezes auto-enroll at Start, so a change requires a separately versioned definition.

Reuse Campaigns, Consensus Analytics, Human Feedback and bounded CSV exports. Track Todo, arm, optional category, integrity, terminal state, rework, real human feedback and notes without private source/provider dumps. Final report records frozen identities, application version, dates, ITT/PP, exclusions, failure modes, coverage and limitations. Follow-up automation requires a separate task and evidence-backed hypothesis; no automation is a valid outcome.

## Explicitly authorized temporary retry

After the initial closed exercise failed, the user explicitly requested another verification on 2026-10-02. The same synthetic Todo was retried through the ordinary execution-round retry route, preserving its worktree, assignment, original failed round and closed campaign definition. Only the temporary implementation turn limit changed from 6 to 20; the local persisted process cap changed from 3 to 4 total (one previous plus at most three new launches). This is a documented test intervention, not a frozen real-world Pilot treatment. No new Todo, forced arm, review-policy change, human label or routing change was introduced.

The retry reached real two-process Consensus approval and completed. It remains excluded from the real-world sample. See [the retry report](Evaluation_Campaigns_Real_World_Pilot_V1_Report.md#authorized-retry--2026-10-02). Safe terminal-event diagnostics were collected only by the ignored temporary launcher; production logging/parser behavior was not changed.

Duration semantics: Todo wall-clock remains assignment.first_execution_at → assignment.finished_at and can include quota/executor waits, review/rework, human pause and manual retry delay. Process wall-clock (attemptWallDuration) is locally observed attempt runtime, independently of provider telemetry. Provider-reported duration (providerDuration) is available only when the provider reports it. Both metrics expose known sums, started-attempt counts and coverage in every phase and attrition/ITT/PP population. Waiting attempts with no start are excluded; invalid negative/nonfinite values are ignored and known zero is retained. Failures, stops and recovery preserve observable wall time without fabricating provider duration.

For example, implementation 10s + human wait 30m + retry 10s gives Todo wall-clock ≈ 30m20s and summed process wall time ≈ 20s.

The compatibility column duration_ms is deprecated: ordinary aliases provider_duration_ms; Consensus aliases attempt_wall_duration_ms. Canonical treatment aggregates never read this mixed legacy column. API/CSV exposes known_attempt_wall_duration_ms, attempt_wall_duration_attempts_known/total/coverage and known_provider_duration_ms, provider_duration_attempts_known/total/coverage. Arm metrics expose the equivalent camelCase fields.
