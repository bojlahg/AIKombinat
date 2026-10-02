# Evaluation Campaigns V1 smoke report

Current status (2026-10-02): **READY**. The explicit disposable Haiku campaign is **PASS** and the [delivered fix CI](https://github.com/bojlahg/AIKombinat/actions/runs/36979939589) for `6e8add0` is **SUCCESS**. Earlier limitations below describe historical runs.

Date: 2026-10-01. Baseline: accepted Consensus Review Evaluation / Telemetry V1 on `b6b4115`. Conclusion: **READY_WITH_LIMITATIONS**, subject to the delivered commit's required GitHub CI gate. Local runtime/UI checks below do not establish comparative review quality.

## Validation

Required checks: `npm run typecheck`, `npm test`, `npm run build`, `npm run docs:erd:check`, `git diff --check`. The final full test run passed 82 server files (2481 passed, 2 skipped) and 37 client files (206 passed). Campaign-specific coverage is 30 server tests and 8 client tests, including independent golden vectors, two 10000-ID distribution samples (1:1 and 3:1), crash rollback, all implementation fields against an opted-out paired Todo, internal/schedule/delegated boundaries, cap/lifecycle conflicts, deep profile/policy drift, runtime fallback identities, monotonic integrity, feedback privacy/timing, ITT/PP/attrition and denominators, bounded 10000-assignment analytics/CSV, HTTP ownership and locale/UI behavior. Full suites also cover ordinary Single/Consensus Review, failover, quota, orchestration and resource admission.

On this workstation, the installed main SQLite native addon belongs to Electron's ABI, whereas Node 22 uses a different ABI. Tests and the disposable controller used a separately installed Node-compatible addon under ignored `node_modules/.cache/campaign-node`, injected with a local NODE_OPTIONS preload. The application's Electron addon, lockfiles and tracked dependency configuration were retained. Earlier attempts without the correct runtime failed at native-module loading; Electron-based broad testing also hit Windows Git-fixture cleanup permissions. The final standard Node suite uses the compatible isolated binding and normal fixture filesystem access.

Typecheck, full build, ERD freshness and diff whitespace checks passed. A final fresh disposable-controller run after the last schema/UI changes again passed enrollment, restart, override, feedback and twice-applied existing-history migration. The IDs below refer to the earlier UI-observed run so its browser actions and screenshot can be correlated.

ERD: 72 tables, 851 columns and 114 column-level relationships in the generated document, plus SQLite's composite campaign/arm ownership constraint. No production database was used for enrollment or provider work.

## Real controller enrollment and restart

Run `npx tsx scripts/evaluation-campaign-smoke.ts`, optionally with `--migration-source=<existing-smoke.db>` and `--serve` for UI inspection. The script creates a disposable OS-temp directory, SQLite DB, local project and loopback Express controller using production routes. It does not launch an AI provider.

Recorded root: `C:\Users\bojla\AppData\Local\Temp\aikombinat-campaign-smoke-qMECIv`. Machine-readable evidence is `report.json` in that directory.

| Field | Recorded value |
| --- | --- |
| Campaign | Review Strategy Baseline Smoke |
| Project | `a045a04b-d611-4d0e-9f0a-21d296ab6263` |
| Campaign ID | `e4c593c9-7d57-48f4-a3c7-862422b06801` |
| Control / experiment | Single Review / Consensus Review, weights 1:1 |
| Status / auto-enroll | Running / OFF |
| Definition hash | `dcc6215ee260b85ed85e7cb2a95254746f2a8944830f610b28050cef1d3ad978` |
| Enrolled Todo | `e912c91f-c21e-4e4e-b75c-03426af3e6b2` |
| Selected arm / bucket | Consensus / 1 of 2, selected range `[1,2)` |
| Arm ID | `1c55d608-2e94-43b2-8470-236e40c67dd6` |
| Assignment digest | `c942656c6482258194933ceb2ef8da2fcd479c551fff0768ab4a9c30cf4c6613` |

Real HTTP enrollment preserved implementation provider/model/effort, prompt, resources, worktree and priority, while applying the selected review strategy. Controller stop/restart preserved arm, digest, bucket and both definition/config hashes. A normal review edit returned 409; explicit override kept the arm and changed integrity to contaminated. The immediate analytics snapshot retained that assignment in ITT and omitted it from PP. An insertion-failure regression separately proved no partial Todo or assignment survives a crash inside creation.

## Explicit synthetic review/feedback observations

The second Todo, `4fef5477-b476-49e2-8c19-f83980db3783`, used explicit synthetic lifecycle timestamps, a completed approved Review result and a fixture execution identity. Feedback before review was rejected; after review, real feedback PUTs inserted helpful and updated the same record to not_helpful. The third Todo, `75288225-48b6-49b3-ab8c-850350d25cad`, was reserved for pre-start withdrawal UI verification.

The script's initial snapshot had 3 assignments, all randomly assigned Consensus, with clean 2 / contaminated 1 / excluded 0. ITT: assigned 3, started 1, reached review 1, terminal/completed 1, failed/stopped 0, approved final review 1, needs-changes 0, rework 0/1. PP: clean 2, contaminated excluded from PP 1, reached review 1. Whole-Todo cost/tokens were null, with known coverage 0/3 in ITT and 0/2 in PP. Feedback: responded 1, evaluative 1, helpful 0, not_helpful 1, mixed/unknown 0; response/evaluative coverage 1/1 and helpful rate 0/1. The 3 ms duration is fixture timing, not AI execution performance. No control comparison can be inferred from this tiny one-arm realized sample.

## Browser UI smoke

The disposable running controller was exercised in the Codex in-app browser:

- Created **UI Lifecycle Smoke** with Single control, Consensus experiment, weights 1:1; verified auto-enroll defaults OFF, then opted into ON while still a draft and started it through the UI.
- Ordinary Todo form defaulted participation ON for that running auto-enroll campaign, hid the assigned arm before creation and disabled competing review controls. Created **Browser enrolled Todo**, `bec3e280-2267-4c10-ba62-9eaf0ceaabd8`, assigned to UI Consensus.
- Reopened Todo editing, verified locked review fields, invoked explicit Override, disabled review and saved. The same arm remained and integrity became contaminated with the manual-override reason.
- Paused/resumed the original campaign and completed the UI campaign. Inspected ITT default and PP toggle, expected/observed distributions, low-sample warning, missing usage coverage and assignment explanation.
- Withdrew the original third Todo before execution. Original campaign retained 3 audit assignments but became clean 1 / contaminated 1 / excluded 1; ITT assigned 2, PP clean 1, reached review 1 in each. Feedback was changed to helpful through UI and analytics refreshed to helpful 1/1.
- Switched RU → EN → KO and back, checking translated controls and metrics. Locale/placeholder parity is also enforced by the suite.
- CSV UI action completed without an application error. HTTP regressions inspect CSV content, bounded pagination, privacy, null handling and formula escaping. The in-app browser did not expose a captured file-download event, so disk-download capture is not claimed as verified.
- Visual inspection found a long campaign editor extending beyond the viewport with a transparent surface. Added an opaque card and scroll limit, rebuilt and verified the form fits and scrolls.

The saved dashboard screenshot is a visual proof of the UI fixture, not evidence of completed AI review. Browser-created campaigns and Todos belong solely to the disposable database.

## Existing-history migration

A read-only SQLite backup of the previous accepted evaluation smoke fixture (`aikombinat-evaluation-ui-rcOo0H\ui.db`) was copied into the new disposable root. Running `initDatabase` twice preserved counts: Todos 1, Consensus batches 1, reviewer jobs 2, Consensus evaluation feedback 4, provider accounts 3 and quota states 3. Foreign-key check was empty after both migrations. Source state was untouched. This historical fixture had zero orchestrators/turns; a separate populated regression checks retention of existing orchestrator and completed-turn contents, ordinary Todos, schedules and quota rows.

## Limitations and next step

No real AI review was launched: this session did not establish a safe/free provider execution path. The task permits recording this limit; enrollment, persistence and UI were verified against a real controller, while Review outcomes are explicitly synthetic. Provider usage and comparative quality remain unproven by this smoke. Real fallback/retry/admission behavior is covered by existing regression suites, not presented as a new live-provider campaign run.

Post-start auto-enroll/cap changes require cloning, consistent with the immutable-definition rule. Assignment history cannot be deleted individually. CSV file capture in the in-app browser remains unverified even though the button, request/content and export logic are covered. Final delivered-commit GitHub CI must be observed green before acceptance is claimed in the delivery response.

Next: run real campaigns and accumulate evidence before Dynamic AI Routing V1. Inspect rework, attrition, wall time, whole-Todo known usage and human helpfulness with their denominators; do not choose a winner from a handful of observations.

## Real AI treatment acceptance

The new command is `npx tsx scripts/evaluation-campaign-real-ai-smoke.ts`. The final script was exercised on 2026-10-01 with `--keep --timeout=120` and again with ordinary cleanup (`--timeout=120`). Both returned **SKIPPED_ENVIRONMENT**, not PASS. Evaluation Campaigns V1 remains **READY_WITH_LIMITATIONS**. Machine-readable retained-run evidence is committed in [Evaluation_Campaigns_Real_AI_Environment.json](evidence/Evaluation_Campaigns_Real_AI_Environment.json); its script SHA-256 identifies the tested source independently of the pre-delivery baseline commit.

| Field | Observation |
| --- | --- |
| Source checkout | `b91ddbdf1336dd202a6f94b54dbe2d7367120864` plus the closure working-tree changes |
| OS / Node | Windows `10.0.26200` x64 / `v22.16.0` |
| CLI versions | Claude Code `2.1.246`; Codex `0.159.2`; OpenCode unavailable |
| Retained root | `C:\Users\bojla\AppData\Local\Temp\aikombinat-campaign-real-ai-k6IYIo` |
| Baseline Git SHA | `239528ffbba48339b603faaf089c07ac3f9cf33d` |
| Seed pre-test | FAIL, exit 1, no transport error; Node built-in tests cover below/inside/above range |
| Current catalog | Claude documented discovery succeeded; Codex live model/list succeeded |
| Inherited account probes | Claude available; Codex auth_error; Antigravity unsupported for this smoke |
| Eligible existing profiles | None: enabled candidates use obsolete or fixture model names absent from current discovery |
| Campaign / assignments | Not created; candidate count 0; no selected Control or Experiment |
| Implementation / reviews | Not launched; no implementation/review PIDs, rounds, batches or attempts |
| ITT / PP / usage / identities | Not reached; no real treatment analytics or usage is claimed |
| Human feedback | Auto-created NO; coverage 0 |
| Cleanup | No owned Todo PID, running reviewer attempt, lease or ExecutorPool reservation |

The source store was opened read-only for configuration metadata; all migrations, model refreshes and account health/quota writes used a fresh disposable `smoke.db`. No existing Todo/session/repository was used as an execution target. No provider login/logout, account switch, credential provisioning or provider configuration write was performed. A confirmed Claude login alone does not authorize replacing the source profiles with invented model selections; every enabled candidate must pass current-catalog and ExecutorPool checks.

The default-cleanup root, `aikombinat-campaign-real-ai-SdLafb`, retains `report.json` and bounded diagnostic logs. Its DB and seed repo were confirmed removed after the report was written, with `cleanup.safe=true` and `retained=false`. The `--keep` root intentionally retains disposable DB/repo evidence. All runtime event logs omit message bodies, prompts and provider output and cap total event bytes at 128 KiB.

Local validation: 13 provider-free smoke logic tests; full server suite 2,590 passed / 2 skipped across 85 files; client suite 229 passed across 40 files. Server/client typecheck, explicit script typecheck, full build, ERD freshness and diff checks passed. The local SQLite module was rebuilt for Node 22 after an ABI mismatch; generated build artifacts required ordinary sandbox escalation. No tracked dependency or production runtime code changed. Final delivered-commit GitHub CI must be observed separately in the delivery response.

**THIS RUN IS ACCEPTANCE EVIDENCE, NOT COMPARATIVE QUALITY EVIDENCE.** This environment run verifies safe refusal, reporting, the failing seed and cleanup. It does **not** close real implementation → Single/Consensus review → analytics acceptance. A future real PASS with one Todo per arm would establish that pipeline only; it would not rank treatments, prove cost/quality differences, or justify Dynamic AI Routing.

## Disposable bootstrap closure — 2026-10-02

**THIS RUN IS ACCEPTANCE EVIDENCE, NOT COMPARATIVE QUALITY EVIDENCE.** Campaigns remains **READY_WITH_LIMITATIONS**; Reconciliation remains **READY**.

The final non-inference preflight returned **PRECHECK_READY** with Claude 2.1.246, exact `claude-haiku-4-5-20251001` for implementation and review, provider-default/null effort and inherited-default account policy. Fresh `claude-documented` discovery succeeded and was non-authoritative. The inherited account was healthy with unknown quota. Both new disposable profiles were READY/current/no-repair, exact ExecutorPool selection succeeded, reservations=0, and AI processes=0. Cached reconciliation avoids probing unrelated copied providers.

The real campaign run returned **FAIL**. Real deterministic assignment found Control and Experiment in two candidates, with no excluded extras. Control launched implementation PID 36672 with persisted identity and the exact Haiku snapshot, then exited 1 and reached failed. No reviewer or Experiment implementation launched; seed baseline tests failed as intended, but implementation correctness, review outcomes and ITT/PP terminal acceptance were not reached. Budget used 1/8. No approval was injected or model substituted. The provider failure cause was not recorded in bounded evidence, so no authentication or model-availability conclusion is asserted.

Source DB/WAL/SHM fingerprints matched before/after both runs. Source opened read-only; no production profiles or accounts were changed. Owned processes were dead; Todo/reviewer PIDs, leases and reservations were all empty. Cleanup was safe. An attempt to retry outside the restricted shell was rejected by automatic approval review because inherited credentials and external service costs require explicit user authorization. No retry bypass was used.

Machine-readable [bootstrap evidence](evaluation-campaign-real-ai-evidence.json) contains both reports and their tested script hashes. These identify the tested source independently of the pre-delivery baseline commit; the failed run precedes final quota/duration/reporting refinements. Earlier zero-launch setup failures exposed and fixed the projects router mount and invalid delegation-disable value in the smoke.

Local validation passed: server 2,634 tests (2 skipped), client 244 tests, typecheck, explicit smoke-script typecheck, build and ERD freshness. Final guard/report refinements passed repeat validation before delivery. Delivery CI is reported against the pushed commit; no READY promotion is claimed.

## Real-AI PASS closure — 2026-10-02

**THIS RUN IS ACCEPTANCE EVIDENCE, NOT COMPARATIVE QUALITY EVIDENCE.** Real-AI acceptance is **PASS** and Evaluation Campaigns V1 is **READY** after [delivered-fix CI](https://github.com/bojlahg/AIKombinat/actions/runs/36979939589) completed successfully for `6e8add0b33e60fe2e61de3f4b8e3ab1c87e320c8`. All five required jobs passed on run attempt 1. Reconciliation remains **READY**.

The earlier restricted-shell implementation exited 1 and emitted `provider-account.health` immediately after failure. The manager emits that event for a nonzero exit only when provider output matched an authentication rejection. This identifies an inference authentication failure in that run; the exact provider text was not retained, so the underlying credential/network restriction is not further asserted. The same inherited login and exact Haiku model executed successfully outside the restricted shell after explicit user authorization. No credentials, login/logout state, production profile or account settings were changed.

The first unrestricted reproduction then exposed a separate smoke instrumentation defect: `Failed to start Claude CLI: This database connection is busy executing a query`. The review PID trigger invoked a SQLite UDF that reread the executing connection to compute the configuration hash. The corrected triggers perform SQL-only evidence inserts; actual configuration hashes are captured outside the trigger at CLI start and polling. Artifact collection happens before the implementation round is marked completed, so the smoke now tests the still-running implementation/rework round at that boundary. A real SQLite regression covers PID persistence, actual config hashing and immutable first-hash capture.

The exact target stayed Claude `claude-haiku-4-5-20251001` for both implementation and review, null/provider-default effort, inherited-default account, fresh successful non-authoritative `claude-documented` catalog. Both bootstrap profiles are ready/current/no-repair, and preflight selected exact candidates with zero reservations. Account health was available; preflight quota was unknown.

| Evidence | Result |
|---|---|
| Campaign | `9648b8ea-599c-442f-9ebc-4023e4afaa88` |
| Assignment search | 3 real candidates; 1 extra withdrawn before execution |
| Control implementation | PID 17232; exit 0; deterministic tests PASS |
| Control Single Review | PID 6704; exit 0; approved; one logical round; no Consensus batch |
| Experiment implementation | PID 27496; exit 0; deterministic tests PASS |
| Consensus reviewers | PIDs 31912 and 19876; independent identities/jobs; both exit 0 |
| Consensus aggregate | One batch, two reviewers, unanimous/require-all, approved |
| Final Todos | Both completed; clean assignments; review-start hashes match |
| Artifact | Same immutable consensus identity; unchanged after review |
| Tests and package | Unchanged; `src/math.js` changed in both worktrees |
| ITT / PP | Each arm: assignments=1, started=1, reachedReview=1, terminal=1, completed=1 |
| Rework / manual overrides | 0 / 0 |
| Usage coverage | Cost and token coverage 1/1 in each arm; only provider-exposed values |
| Human feedback | No auto-created labels; zero responses |
| Process budget | 5/8; no retries or rework |
| Source safety | Read-only; DB/WAL/SHM fingerprints identical; no profile/account mutation |
| Cleanup | All five identities dead; Todo/reviewer PIDs=0, leases=0, reservations=0 |

The retained disposable root is `C:\Users\bojla\AppData\Local\Temp\aikombinat-campaign-real-ai-Y9vRlh`. Only the bounded report is committed in [machine evidence](evaluation-campaign-real-ai-evidence.json); raw task/provider output and disposable DB are not committed. The runner SHA-256 records the tested source; the final helper extraction preserves the same SQL and is covered by the SQLite regression. Local checks passed: 2,635 server tests (2 skipped), 244 client tests, typecheck, explicit runner typecheck, build, ERD freshness and diff check. CI never launches provider AI.
