# Execution Profile Reconciliation V1 — Disabled Orphan Recovery Closure Report

Date: 2026-10-02 (Asia/Yekaterinburg). Baseline: `21becf95b682215fe8d7249265a50cf49835f37a` (task records successful baseline CI #90, attempt 1). Baseline CI is not evidence for the closure delivery commit.

## Repair routing and recovery

The canonical server helper returns `none` for current/disabled healthy candidates, `model` for stale/unconfirmed model evidence, `effort` for unsupported/required/invalid-variant effort, `account` for invalid account policy, and `recreate` for orphaned references/provider mismatch. A missing model reference takes precedence over disabled for structural repair, while catalog state remains `disabled`. Table-driven tests cover this routing. Only model repair opens the replacement modal. Account/effort actions expand the profile, scroll the stable candidate target and focus the relevant select. The expanded disabled orphan row shows Disabled, Missing model reference, neutral copy and Recreate executor through the existing modal; model/account/effort CTAs are absent. EN/RU/KO key and placeholder parity passes.

Orphan payloads carry no fabricated provider: `provider=null`, `currentModel=null`, `suggestions=[]`. Matching optimistic tokens followed by generic rebind yield **409 candidate_provider_unrecoverable**, including when the replacement ID is missing. Stale tokens retain the existing concurrency error. The recreate flow requires explicit provider and a model available in its latest successful discovery. A provider without confirmed models shows “Refresh catalog first” and cannot apply.

Recreate preserves candidate ID, priority, enabled state and creation time through the shared production transaction, audit, optimistic tokens and campaign-impact confirmation. Previous effort/account policy/fixed account are not silently copied: the UI starts with provider-default effort, inherited-default account policy and no account ID. Grouped Antigravity requires explicit supported mapped effort. Tests verify preserved priority 7 and disabled state; the disposable orphan smoke preserves priority 9 and enabled state. Generic model rebind retains same-provider enforcement and validates current account compatibility before committing or auditing. Invalid compatibility returns `invalid_account_policy`; injected audit failure still rolls candidate/timestamp back. Running snapshots and completed history remain immutable, while future late binding uses repaired configuration.

Missing-reference rows render from reconciliation separately from ordinary profile rows. Ordinary name and visible healthy effort/priority saves succeed with a disabled orphan present. Executor replacement compares persisted and submitted IDs and model existence, preserving an omitted hidden orphan without rewriting any of its fields or timestamps. Server PATCH tests verify original orphan contents, row count/IDs, advancing profile timestamps and ready reconciliation. Visible executor removal still works; enabled orphans retain the existing UI save guard. No optional orphan-remove endpoint, invented selectable model option or schema change is introduced.

## Attention lifecycle

Every reconciliation load counts degraded/unknown/blocked profiles, excluding disabled profiles. The surface is now “Execution profiles needing attention” and includes invalid account/effort candidates. Client tests verify **2 → 1 → 0**, followed by banner removal, both after successive model repairs and after ordinary account/effort saves. Ordinary save reloads profiles and reconciliation. Both `execution-profile:updated` and `model-catalog:updated` perform one health reload and count recalculation. Ordinary PATCH now broadcasts the canonical profile update event.

Runtime/profile health continues to ignore disabled candidates. Current plus disabled orphan is **READY**, adds zero to attention count and selects the same healthy candidate in ExecutorPool. An enabled profile with only disabled candidates retains the existing blocked result. Disabled structural repair availability does not change catalog refresh, stale/current, suggestions or campaign eligibility semantics.

## Real discovery and disposable smoke

`npx tsx scripts/execution-profile-reconciliation-smoke.ts --report=docs/execution-profile-reconciliation-smoke-evidence.json` returned **PASS**. [Machine-readable evidence](execution-profile-reconciliation-smoke-evidence.json) records source read-only access, unchanged DB/WAL/SHM fingerprints and no inference. No source configuration was repaired and no login/logout was requested.

| Provider | Source | Primary success | Authoritative | Models seen |
|---|---|---|---|---:|
| Claude | claude-documented | yes | no | 10 |
| Codex | codex-app-server | yes | yes | 8 |
| Antigravity | antigravity-model-command | no | no | 0 |
| OpenCode | no successful source | no | no | 0 |

Real copied configuration has **0 ready, 3 unknown, 0 degraded, 0 blocked, 0 disabled** profiles. Existing stale/unconfirmed references remain visible and untouched. Antigravity discovery could not write its CLI log/crash files within the sandbox; the report records failed discovery rather than claiming current evidence. Synthetic closure fixtures are independent of that installed-provider limitation.

Independent synthetic fixtures prove stale → model, invalid effort → effort, invalid account → account, and orphaned → recreate. Legacy dangling reference creation temporarily disables FK enforcement only in the disposable database, immediately reenables it, and uses the production service for repair. Generic orphan rebind fails with the stable 409 code. Explicit recreate succeeds with the same candidate ID, preserved priority/enabled state, inherited-default account, null account ID and provider-default effort; that orphan profile becomes **current/ready**. The independent invalid effort/account fixtures remain invalid. The model-only synthetic rebind also changes blocked → ready and preserves high effort.

The added current plus disabled-orphan fixture stays **READY** before and after repair, with zero attention impact. Name and healthy-priority saves preserve the orphan row exactly and retain both executor IDs. Recreate preserves the same ID, priority 9, `is_enabled=0` and creation time; unsafe old effort/fixed account are reset to null effort, inherited-default policy and null account ID. The final report has **3 audit rows** and a passing foreign-key check. Source DB/WAL/SHM fingerprints remain unchanged; no inference is launched.

## Real-AI Campaign regression

`npx tsx scripts/evaluation-campaign-real-ai-smoke.ts` returned **SKIPPED_ENVIRONMENT** after explicit user authorization for the real-provider regression run. No existing profile has both verified current discovery and authorized inherited/free-local candidates under the established smoke policy. No implementation/review was executed, no assignment or comparative quality evidence is claimed, and cleanup verified no retained ownership, leases or reservations. The final controller report was written to `aikombinat-campaign-real-ai-MyiKjs/report.json` under the system temporary directory before guarded cleanup. The deliberately failing seed pre-test is expected by this smoke's acceptance contract.

Evaluation Campaigns V1 remains **READY_WITH_LIMITATIONS** until actual Real-AI PASS and delivered-commit green CI.

## Validation and delivery

Final local validation: **2623 server tests passed, 2 skipped; 244 client tests passed**. Server reconciliation coverage has 33 passing tests; client routing/attention coverage has 10 passing tests, in addition to existing model-modal/settings coverage. Typecheck, standalone smoke-script typecheck, production build, ERD check and Git whitespace check pass.

Execution Profile Reconciliation V1 closure satisfies local acceptance; **READY** requires the delivered commit's green GitHub CI, verified and linked in the delivery response. Baseline green CI is not substituted for that check. Evaluation Campaigns V1 remains **READY_WITH_LIMITATIONS**.
