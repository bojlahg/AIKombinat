# Evaluation Campaigns Real-World Pilot V1 — setup exercise report

## Result

Real-world Pilot: **NOT_STARTED**. Temporary setup exercise: **CLOSED — implementation CLI failed before review**. The user requested a temporary test project and one inexpensive task; this is synthetic operational evidence, not a completed real-world Pilot or review comparison. Real-world clean terminal progress remains **0/30**, Control=0, Experiment=0.

Prerequisite Campaigns acceptance remains READY. [Delivered-fix CI](https://github.com/bojlahg/AIKombinat/actions/runs/36979939589) was independently checked: success at `6e8add0b33e60fe2e61de3f4b8e3ab1c87e320c8`. This exercise does not replace or invalidate that earlier real two-arm PASS.

## Frozen setup and dates

Date: 2026-10-02, Asia/Yekaterinburg (UTC+05:00). Test campaign Start 14:40:00.445; implementation 14:41:50.995–14:42:10.715; explicit completion 14:44:10.164. App 0.2.49, source commit `23efeeb360d3caa7a77796fd8b4fe31545622ee9`.

Project `294fad7f-913e-4c12-8712-ede75ba48efd`, `Campaign Pilot Setup Test`, separate local DB/Git state under `data/pilot-20261002/`. The loopback server was started by the agent on port 3747 and shut down after the exercise. Existing application DB/profiles/accounts were not opened or copied. Local test state is retained for inspection; raw logs/DB are not committed.

Campaign `2f3a9a94-1df3-46c5-a951-739a30f8eff3`, `Single vs Consensus — Temporary Setup Test V1`, status completed, auto-enroll OFF, two arms, weights 1:1, `sha256_weighted_v1`. Definition hash: `39f25df43a7d2b76d89e680d391138533115667ffc6098b2f50bfef4849b22cb`.

Both arms share Implementation/Rework profile `0e906c0c-1769-431d-ad61-e7f654012446`. Single reviewer and both Consensus members use `dd95c1a1-5a87-45ce-8069-7a582d4e68cc`. Exact Claude Haiku `claude-haiku-4-5-20251001`, null/provider-default effort, inherited-default account policy, no model alternative. Reconciliation READY for both profiles; exact ExecutorPool selection succeeded, initial reservations=0. Consensus policy `5129fb2e-d558-4a1d-a227-0560848e6294`: unanimous, require_all, two members, max_parallel_reviewers=2, judge OFF. Max review rounds=2 in both arms. Worktree ON, no resource requirements, max implementation turns=6, max concurrent Todos=1, dependency install and delegation OFF.

Safe definition fingerprints (SHA-256 of recursively key-sorted JSON for the profile executor/policy projections in the machine evidence; these are report fingerprints, not new product integrity hashes):

| Identity | Fingerprint |
|---|---|
| Implementation/Rework profile | `be130f6599e329c52ed2b42d30d6bdb97e800155220d81f91a6814d3040edd4b` |
| Reviewer profile | `d3b9b58dbffba9bce103dbd9c4b82f813b6c8171136956294766ee01afcd00a3` |
| Consensus policy | `6f129a4d96d490f4e22f2fd7d7991ca8664cba1a8f6229f6c3e9dd28fb6fa4c6` |

Project, campaign creation, Start, enrollment, Todo launch and campaign completion used product UI. Disposable profile bootstrap and test repository creation used existing services/local tooling. The temporary launcher capped managed AI launches at three across restarts and suppressed the separate startup inference quota probe. Product startup still performed ordinary provider catalog diagnostics; no inference usage from those diagnostics is claimed.

## Sample and operational observations

Exactly one Todo was created: `58722ff5-ae8c-441e-9c5c-ea54f95c49ad`. Task: fix spelling in a one-line JavaScript export and run the existing Node test. Normal deterministic assignment selected Consensus, bucket 1; no forced arm, balancing tasks, retries, feedback labels or manual approvals were added.

| Todo | Arm | Category | Integrity | Terminal | Rework | Human feedback | Notes |
|---|---|---|---|---|---|---|---|
| `58722ff5-ae8c-441e-9c5c-ea54f95c49ad` | Consensus | bugfix fixture | clean | failed | 0 | none | Synthetic; excluded from real-world sample |

| Metric, temporary campaign | Single | Consensus |
|---|---:|---:|
| Product ITT assignments / started / terminal | 0 / 0 / 0 | 1 / 1 / 1 |
| Product PP assignments / started / terminal | 0 / 0 / 0 | 1 / 1 / 1 |
| Reached review / completed / failed | 0 / 0 / 0 | 0 / 0 / 1 |
| Contamination / integrity exclusions | 0 / 0 | 0 / 0 |
| Rework / review rounds | 0 / 0 | 0 / 0 |
| Whole-Todo median, raw N | unavailable, N=0 | 19,720 ms, N=1 |
| Known whole-Todo cost, coverage | unknown, 0/0 | $0.0426689, 1/1 |
| Product known tokens (input + output), coverage | unknown, 0/0 | 883 (49 + 834), 1/1 |
| Human helpful / labeled | 0/0 | 0/0 |
| Human labeled / all assigned Todos | 0/0 | 0/1 |
| Product feedback coverage denominator (reached review) | 0/0 | 0/0 |

The product PP counts integrity-clean implementation failures. It does not enforce the real-world-only sampling rule: this fixture is excluded explicitly at the report level, with real-world ITT/primary PP samples zero. Human coverage is insufficient for any quality interpretation. Product token totals above omit separately reported cache tokens: cache-read=179,389; cache-creation=9,678. These are reported separately rather than treating 883 as all billable/cache-inclusive tokens. Cost is provider-exposed usage, not an invoice or a remaining-quota estimate.

Implementation PID 34764 was durably recorded and exited with code 1. One managed AI process was used out of the cap of three. The ordinary round remained failed; neither Single Review nor the two Consensus reviewers ran. No account retry/failover, rework, review duration, agreement/disagreement batch, shared/unique finding, manual override or judge observation exists in this run. Waiting durations were not measured. Agreement is not correctness.

The agent independently ran `node --test` in the worktree: 1 test PASS. Git diff: one file, one insertion, one deletion. This confirms the tiny code edit, not successful completion of the AI pipeline and not human review feedback. Provider result metadata reported 7 turns with a configured maximum of 6; the persisted failure reason only says CLI exit 1. Turn-limit exhaustion is plausible but not proven by the bounded evidence, so failure classification remains **unknown**, not a claimed quota/auth outage.

## Persistence, cleanup and limitations

A real server restart after enrollment preserved assignment ID `790bd617-691f-4464-a081-6c49552b2315`, arm, hashes and clean state; total assignments remained one. A prior draft restart preserved the campaign. Restart preservation of completed review rounds and submitted human feedback was not exercised because neither existed. Auto-enrollment remains OFF.

Final persisted ownership: Todo PIDs=0, reviewer PIDs=0, resource leases=0; PID 34764 was absent from the process inventory. The test server received ordinary SIGTERM cleanup and stopped. The campaign was explicitly completed through UI and its definition retained unchanged. No further AI work was launched to spend the remaining budget.

Existing bounded [assignment CSV](evidence/Evaluation_Campaigns_Pilot_V1_Setup_Test.csv) and [safe machine evidence](evidence/Evaluation_Campaigns_Pilot_V1_Setup_Test.json) retain identifiers, timestamps, usage and terminal/integrity evidence. No secrets, task prompt, raw provider transcript or private source dump is included. Definition/protocol: [Pilot V1](Evaluation_Campaigns_Real_World_Pilot_V1.md).

Observed difference: none can be inferred. Only one treatment was assigned and it never reached review. No winner, quality score, routing hypothesis or default change is supported. Real-world dogfooding still requires an actual working project and useful manual Todos; the target and later checkpoints remain pending.

Validation scope: no production code, schema, translation or routing change. The temporary launcher is retained only as ignored local test state. Delivery includes documentation and bounded evidence; local validation results are reported in the delivery response, and delivery CI is separate from the earlier prerequisite CI.

Local delivery validation passed: server/client typecheck; server 2,635 tests passed, 2 skipped (87 files, final run with two workers); client 244 tests passed (42 files); full build; ERD freshness; diff whitespace checks. Earlier server runs encountered 5-second Git test timeouts and Windows EBUSY cleanup; the final two-worker run passed without changing product/tests. Build initially encountered sandbox EPERM on existing generated artifacts and passed with authorized write access. Delivery CI has not been observed at report authoring time.
