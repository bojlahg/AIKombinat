# Execution Profile Reconciliation V1 — Repair UX Closure Report

Date: 2026-10-02 (Asia/Yekaterinburg). Baseline: `e60deab7fd57691572655d027a2be02d174f8dc4` (baseline CI #89 succeeded). Baseline CI is not evidence for the closure delivery commit.

## Repair routing and recovery

The canonical server helper returns `none` for current/disabled, `model` for stale/unconfirmed model evidence, `effort` for unsupported/required/invalid-variant effort, `account` for invalid account policy, and `recreate` for orphaned references/provider mismatch. Table-driven tests cover every required reason and disabled precedence. Only model repair opens the replacement modal. Account/effort actions expand the profile, scroll the stable candidate target and focus the relevant select. Current and disabled candidates have no repair CTA. EN/RU/KO key and placeholder parity passes.

Orphan payloads carry no fabricated provider: `provider=null`, `currentModel=null`, `suggestions=[]`. Matching optimistic tokens followed by generic rebind yield **409 candidate_provider_unrecoverable**, including when the replacement ID is missing. Stale tokens retain the existing concurrency error. The recreate flow requires explicit provider and a model available in its latest successful discovery. A provider without confirmed models shows “Refresh catalog first” and cannot apply.

Recreate preserves candidate ID, priority, enabled state and creation time through the shared production transaction, audit, optimistic tokens and campaign-impact confirmation. Previous effort/account policy/fixed account are not silently copied: the UI starts with provider-default effort, inherited-default account policy and no account ID. Grouped Antigravity requires explicit supported mapped effort. Tests verify preserved priority 7 and disabled state; the disposable orphan smoke preserves priority 9 and enabled state. Generic model rebind retains same-provider enforcement and validates current account compatibility before committing or auditing. Invalid compatibility returns `invalid_account_policy`; injected audit failure still rolls candidate/timestamp back. Running snapshots and completed history remain immutable, while future late binding uses repaired configuration.

Missing-reference rows render from reconciliation separately from ordinary profile rows. Ordinary save cannot silently discard an orphan hidden by an inner join; it requests recreation first. There is no invented selectable model option and no schema change.

## Attention lifecycle

Every reconciliation load counts degraded/unknown/blocked profiles, excluding disabled profiles. The surface is now “Execution profiles needing attention” and includes invalid account/effort candidates. Client tests verify **2 → 1 → 0**, followed by banner removal, both after successive model repairs and after ordinary account/effort saves. Ordinary save reloads profiles and reconciliation. Both `execution-profile:updated` and `model-catalog:updated` perform one health reload and count recalculation. Ordinary PATCH now broadcasts the canonical profile update event.

## Real discovery and disposable smoke

`npx tsx scripts/execution-profile-reconciliation-smoke.ts --report=docs/execution-profile-reconciliation-smoke-evidence.json` returned **PASS**. [Machine-readable evidence](execution-profile-reconciliation-smoke-evidence.json) records source read-only access, unchanged DB/WAL/SHM fingerprints and no inference. No source configuration was repaired and no login/logout was requested.

| Provider | Source | Primary success | Authoritative | Models seen |
|---|---|---|---|---:|
| Claude | claude-documented | yes | no | 10 |
| Codex | codex-app-server | yes | yes | 7 |
| Antigravity | antigravity-models | yes | yes | 7 |
| OpenCode | opencode-models | no | no | 0 |

Real copied configuration has **1 ready, 2 unknown, 0 degraded, 0 blocked, 0 disabled** profiles. Existing stale/unconfirmed references remain visible and untouched.

Independent synthetic fixtures prove stale → model, invalid effort → effort, invalid account → account, and orphaned → recreate. Legacy dangling reference creation temporarily disables FK enforcement only in the disposable database, immediately reenables it, and uses the production service for repair. Generic orphan rebind fails with the stable 409 code. Explicit recreate succeeds with the same candidate ID, preserved priority/enabled state, inherited-default account, null account ID and provider-default effort; that orphan profile becomes **current/ready**. The independent invalid effort/account fixtures remain invalid. The model-only synthetic rebind also changes blocked → ready and preserves high effort. **2 audit rows** are inserted and the final foreign-key check passes.

An initial sandboxed run could not access Antigravity CLI log locations. Installed-provider access was used for the final PASS; source fingerprints remained unchanged throughout. An early combined synthetic fixture hit the existing executor uniqueness constraint; final smoke uses independent profiles for the different problems.

## Real-AI Campaign regression

`npx tsx scripts/evaluation-campaign-real-ai-smoke.ts` returned **SKIPPED_ENVIRONMENT**. No existing profile has both verified current discovery and authorized inherited/free-local candidates under the established smoke policy. No implementation/review was executed, no assignment or comparative quality evidence is claimed, and cleanup verified no retained ownership, leases or reservations. The final controller report was written to `aikombinat-campaign-real-ai-YxVrZB/report.json` under the system temporary directory before guarded cleanup. The deliberately failing seed pre-test is expected by this smoke's acceptance contract.

Evaluation Campaigns V1 remains **READY_WITH_LIMITATIONS** until actual Real-AI PASS and delivered-commit green CI.

## Validation and delivery

Final local validation: **2621 server tests passed, 2 skipped; 243 client tests passed**. Server reconciliation coverage has 31 passing tests; client routing/attention coverage has 9 passing tests, in addition to existing model-modal/settings coverage. Typecheck, production build, ERD check and Git whitespace check pass. The first sandboxed build could not overwrite existing generated outputs; the final build passed with the required output access.

Execution Profile Reconciliation V1 closure satisfies local acceptance; **READY** requires the delivered commit's green GitHub CI, verified and linked in the delivery response. Baseline green CI is not substituted for that check. Evaluation Campaigns V1 remains **READY_WITH_LIMITATIONS**.
