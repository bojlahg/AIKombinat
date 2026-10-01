# Evaluation Campaigns V1 smoke report

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
