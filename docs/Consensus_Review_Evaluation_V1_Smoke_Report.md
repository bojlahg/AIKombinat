# Consensus Review Evaluation V1 smoke evidence

Recorded 2026-10-01 (user timezone UTC+05). Existing real history was opened read-only and backed up into disposable OS-temp SQLite databases. Migrations and evaluation ran only on those copies. No production mutation, provider invocation, login change or model change was required.

## Existing-history smokes A/B

Reproducible command: `npx tsx scripts/consensus-evaluation-smoke.ts <existing-smoke.db>`. The script writes a bounded metric report beside its disposable database and checks foreign keys.

| Evidence | Homogeneous accepted history | Heterogeneous failed history |
| --- | --- | --- |
| Source fixture | `aikombinat-consensus-real-sQGo7u/smoke.db` | `aikombinat-consensus-real-Mq6SiG/smoke.db` |
| Batch | `f50f74c5-3782-40e9-8421-1eead8062cc1` | `805032ee-5a60-496a-89f8-0fb0c154f23f` |
| Status/final | completed / approved | failed / null |
| Successful / failed reviewers | 2 / 0 | 2 / 1 |
| Agreement of successful reviewers | true | true |
| Providers / accounts / models | 1 / 1 / 1 | 2 / 2 / 2 |
| Provider diverse | false | true |
| Known reported USD | 0.1714406 | 0.0943194 |
| Known input+output tokens | 732 | 1089 |
| Cost/token coverage | 2/2 = 100% | 2/3 = 66.67% |
| Duration coverage | 2/2 = 100% | 3/3 = 100% |
| Batch wall time | 17517 ms | 17189 ms |
| Summed attempt duration | 20385 ms | 32451 ms |

Both copies passed foreign-key checks. The heterogeneous history correctly retains agreement among two successful Claude reviewers without turning the failed require-all batch into approval. Existing real Codex compatibility limitations are described in [Consensus V1 evidence](Consensus_Review_V1_Smoke_Report.md); evaluation measures that failure without changing it.

## Synthetic evaluation smokes C–J

`src/server/services/__tests__/consensus-analytics.test.ts` uses temporary in-memory SQLite with the real schema and analytics/feedback/router code. It covers:

- explicit correct/useful/confirmed/rejected/uncertain labels, idempotent upsert and feedback coverage; unknown/uncertain excluded from confirmed/rejected denominators;
- mixed Single/Consensus cohorts without synthetic consensus baseline rows;
- majority/weighted/unanimous decisive counterfactuals and minority/tie semantics;
- conditional/always judge, failed judge, majority change and tie N/A;
- shared/unique findings, severity promotion and execution/evaluation fingerprint parity;
- needs_changes → Rework → next Review exact recurrence/disappearance;
- one job/two attempts/one vote/one durable failover, known usage and incomplete coverage;
- unknown usage, zero-denominator nulls, historical snapshot identity and policy edit stability;
- validated periods/identity filters, API sections/details, cross-project rejection, feedback CRUD and CSV privacy;
- idempotent migration, retained history and safe cascade deletion with clean foreign keys;
- a 10,000-batch fixture processed through bounded pages with exact aggregate counts; no brittle elapsed-time SLA;
- more than 200 issue fingerprints and explicit overflow, with frequency-based retention.

Existing pipeline/retry/consensus lifecycle tests also assert transactional human action rows for manual approve/rework and reviewer/judge/review-phase retry. No action is converted into feedback.

## UI smoke

`src/client/src/__tests__/components/ConsensusAnalytics.test.tsx` renders a seeded mixed-cohort analytics response and verifies all principal sections, historical identities, unknowns, usage coverage, low samples, observational evidence, filters, period changes, CSV link, batch drill-down and all three feedback PUT controls. Core locale parity is tested separately.

A built-client browser smoke also passed in Russian on an isolated loopback server using a disposable copy at `aikombinat-evaluation-ui-rcOo0H/ui.db`. Two explicitly synthetic findings were added only to that copy. The UI displayed every key section, historical account/model identity, descriptive decisive votes, null judge override, low samples and usage coverage. Saving batch correct, reviewer useful, issue confirmed and issue rejected refreshed the dashboard: batch coverage 100%, reviewer coverage 50%, issue coverage 2/2 = 100%, one confirmed and one rejected finding. The source accepted-history database remained untouched. Screenshots were saved as local delivery artifacts; browser layout was visually checked.

The first fully parallel Windows server run encountered an existing temporary-workspace cleanup EBUSY lock. The two-worker rerun and subsequent exact `npm test` closure passed. Final server closure passed 80 files / 2447 tests (two pre-existing skips); client closure passed 36 files / 198 tests. The production build passed after granting the requested build access to overwrite existing generated `dist` files; the initial restricted build was blocked by EPERM. Typecheck, ERD freshness and whitespace validation passed. Final commit/CI are reported at delivery.

## Acceptance gate and limitations

Required closure: `npm run typecheck`, `npm test`, `npm run build`, `npm run docs:erd:check`, `git diff --check`, then normal commit/push and final GitHub CI. The delivery response identifies the final commit and its CI evidence; no earlier unrelated CI is accepted.

This is observational analytics, with exact conservative fingerprints only. Single-round cost/token coverage is unavailable in existing persistence. Group/detail/export limits are disclosed and filters or batch pagination support further inspection. No automatic routing, provider selection, score registry, estimated waiting telemetry or causal quality claim is introduced.
