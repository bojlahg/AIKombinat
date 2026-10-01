# Execution Profile Reconciliation V1

Reconciliation derives health from `cli_models`, `cli_versions`, Execution Profiles, Provider Accounts and production ExecutorPool evaluation. It observes, explains and suggests; model refresh never repairs a profile. There is no health cache, second registry, routing policy, quality ranking or automatic model/account/provider migration.

## Catalog evidence

Each successful discovery assigns a UUID `cli_versions.last_refresh_id` and stamps the models it saw with `cli_models.last_seen_refresh_id`. Provider metadata includes source, authoritative/primary-success flags, refresh time and model count. Failed attempts retain the last successful generation but set primary success false. A retained `available` row alone is not confirmation. UUIDs distinguish successive refreshes even when timestamps coincide.

| Candidate state | Evidence |
|---|---|
| current | Enabled, existing matching-provider model, available, seen in latest successful generation, valid effort/account configuration |
| unconfirmed | Failed or absent discovery evidence, or omission from non-authoritative discovery |
| stale | Successful authoritative omission, or independently missing model after successful discovery |
| invalid | Provider mismatch, unsupported effort, missing required effort/variant, malformed account policy or wrong-provider fixed account |
| orphaned | Referenced model row does not exist; legacy broken references remain visible |
| disabled | Candidate disabled |

Unknown effort capabilities preserve the existing ExecutorPool semantics and show a warning. Grouped Antigravity still requires an explicitly supported mapped effort. OpenCode does not support effort overrides.

| Profile health | Enabled-candidate catalog evidence |
|---|---|
| ready | At least one current; no stale, invalid or orphaned candidate |
| degraded | At least one current and at least one stale, invalid or orphaned candidate |
| unknown | No current, but unconfirmed candidates remain |
| blocked | No current or unconfirmed candidate |
| disabled | Profile disabled |

Catalog health and runtime state are separate. `usable` reflects a currently available ExecutorPool candidate; health does not introduce a new runtime gate. Current plus stale, in either order, is degraded. ExecutorPool can select the current fallback after rejecting a missing primary. A manual model omitted from an authoritative catalog may still be runtime-available under existing production semantics; reconciliation reports both facts.

## API and explicit repair

* `GET /api/execution-profiles/reconciliation` returns provider evidence, summary and all profiles, including disabled profiles and broken references.
* `GET /api/execution-profiles/:id/reconciliation` returns one profile plus provider evidence.
* Refresh uses existing `POST /api/models/refresh` or `/api/models/refresh/:cliTool`.
* `POST /api/execution-profiles/:profileId/executors/:candidateId/rebind` replaces a model with a confirmed same-provider model.
* `POST /api/execution-profiles/:profileId/executors/:candidateId/recreate` explicitly recreates an executor in place with a selected provider/model/effort/account policy.

GET uses `ExecutorPool.evaluateCandidate({ cachedOnly: true })`. It performs no CLI probe, discovery, inference or reservation. An absent/expired tool cache produces `runtime_unconfirmed`; refresh provider status explicitly to obtain live installation evidence. Profile, model, candidate and reference lists are batch-loaded; runtime evaluation retains the production pool's existing account/quota/capacity checks.

Candidate payloads include server-owned `repairKind`, `modelReferenceId`, nullable canonical provider, current model identity/status/source/time, catalog state/reason, runtime state/reason, configured/supported effort and capability state, account policy/identity/state, and at most ten suggestions. Only model repair candidates receive suggestions. Suggestions are current available models from the same provider, ordered by exact model value, conservative Claude family (opus/sonnet/haiku/fable), then other current models. Ordering is not a quality or version ranking. The UI also searches all current same-provider models.

Example rebind body:

```json
{
  "newModelId": "replacement-id",
  "newEffort": "provider-default",
  "expectedOldModelId": "old-id",
  "expectedProfileUpdatedAt": "2026-10-01T16:00:00.000Z",
  "confirmActiveCampaignImpact": false
}
```

Omitting `newEffort` preserves the configured effort. Definitely unsupported effort requires an explicit supported selection, `null`, or `provider-default` (where the provider permits it). The replacement must still be available and confirmed in current discovery. Account policy/account, priority and enabled state are preserved. A transaction validates ownership, preview tokens, canonical old-model provider, current account compatibility, catalog evidence and effort; updates candidate model/effort while retaining account settings; inserts an audit snapshot; and advances the profile timestamp. Audit insert failure rolls everything back. Ordinary profile edits also advance timestamps for executor-only changes.

Stable error codes: `profile_not_found`, `candidate_not_found`, `model_not_found`, `provider_mismatch`, `effort_unsupported`, `effort_required`, `reconciliation_stale` (409), `active_campaign_impact` (409), `candidate_provider_unrecoverable` (409), `invalid_account_policy`, and `rebind_failed`. Core EN/RU/KO translations cover states, reasons, repair, impact and errors.

### Repair routing closure

`getCandidateRepairKind(catalogState, reasonCode)` owns repair routing on the server. Missing model references take precedence for structural repair, including disabled candidates. Disabled candidates with an existing model and current candidates have no CTA. The UI never treats account/effort/orphan problems as successful model replacement.

| State/reason | repairKind | Action |
|---|---|---|
| current / latest_refresh_seen; disabled / candidate_disabled | none | No repair CTA |
| disabled / model_not_found | recreate | Explicit recreate modal; candidate stays disabled |
| weak_omission; refresh_unconfirmed; authoritative_omission; model_missing | model | Replace model modal |
| effort_unsupported; effort_required; invalid_provider_variant | effort | Expand profile, scroll row, focus effort select |
| invalid_account_policy | account | Expand profile, scroll row, focus account policy select |
| orphaned / model_not_found; provider_mismatch | recreate | Explicit recreate modal |

Orphaned payloads have `currentModel=null`, `provider=null`, and `suggestions=[]`. The retained `modelReferenceId` supplies the optimistic old-model token. Generic rebind validates ownership and optimistic tokens first, then rejects an absent old model with `409 candidate_provider_unrecoverable`, even if the proposed replacement is also missing. It never guesses a provider. Cross-provider model rebind still fails with `provider_mismatch`. Invalid existing account configuration fails with `invalid_account_policy` before a model repair can commit.

Recreate requires an explicit `provider`, `newModelId`, account policy and fixed account if applicable, alongside the same optimistic/campaign tokens. Its effort defaults to provider default; grouped Antigravity requires an explicit supported mapped effort. Only available models seen in the selected provider's latest successful refresh can be applied. Without those models the UI says “Refresh catalog first” and disables Apply. The UI starts with no provider/model selection, `accountPolicy=inherited_default`, `providerAccountId=null`, and provider-default effort. It does not copy previous effort or fixed account. Priority, enabled state, candidate ID and creation time remain intact. The shared transaction/audit/timestamp/event path preserves existing snapshot and campaign guarantees; no new schema is introduced.

Candidate rows have `execution-candidate-<candidateId>` targets and account/effort control refs. Missing-reference rows render from reconciliation even though the ordinary profile query omits missing model joins. A disabled orphan shows Disabled, Missing model reference, neutral EN/RU/KO copy and Recreate executor through the existing `ProfileRecreateModal`. It offers no model/account/effort repair. Runtime/profile health still ignores every disabled candidate: current plus disabled orphan remains ready with zero attention impact; an enabled profile containing only disabled candidates retains the existing blocked result.

Ordinary name/description/enabled/order and visible executor edits are allowed with disabled orphaned references present. Executor replacement loads persisted IDs and model existence, compares submitted IDs, and retains hidden orphan rows absent from the DTO without rewriting their configuration or timestamps. Omitting a visible executor still removes it intentionally. Enabled orphan rows retain the existing UI save guard. Missing references never appear as invented selectable models. No separate orphan-remove endpoint is introduced.

References include review policies (members and judges) and running campaigns (review/rework arms, policy references and enrolled implementation profiles). Any running campaign reference requires `confirmActiveCampaignImpact=true`. Confirmation does not rewrite campaign hashes or suppress normal drift/contamination detection. Snapshots, running processes and completed history remain unchanged; future late binding uses the repaired model.

`execution_profile_rebind_audit` stores nullable profile/candidate references, provider, old/new model IDs/values/labels, old/new effort, `manual_ui`/`manual_api` source and timestamp. Deletion nulls the references while preserving snapshots. It stores no credentials, environment values, prompts or output. Audit history and rollback UI are outside V1.

Catalog refresh broadcasts `model-catalog:updated`; model repair, recreate and ordinary PATCH profile save broadcast `execution-profile:updated` through the existing broadcaster. Settings displays health badges, calm degraded/unknown explanations, candidate repair buttons, model usage counts, affected-profile links and all stale/unconfirmed/invalid/orphaned candidates under “Execution profiles needing attention”. Every reconciliation load recalculates the non-modal attention banner from degraded/unknown/blocked profiles, excluding disabled profiles. Ordinary save reloads profiles and reconciliation; either WebSocket event triggers one reconciliation reload and count recalculation. The shared portal Modal previews old/new model and effort plus preserved fields and campaign impact.

## Smoke commands

```sh
npx tsx scripts/execution-profile-reconciliation-smoke.ts
npx tsx scripts/execution-profile-reconciliation-smoke.ts --profile=<id> --candidate=<id> --new-model=<value> --new-effort=high
npx tsx scripts/evaluation-campaign-real-ai-smoke.ts
```

The reconciliation smoke opens source configuration read-only, copies configuration metadata into a fresh disposable DB, refreshes installed providers, reports real health, verifies no profile mutation, and fingerprints the source DB/WAL/SHM before and after. Without an explicit target it proves stale → model and blocked → ready using synthetic configuration; additional disposable fixtures prove invalid effort → effort, invalid account → account, orphaned → recreate, stable generic orphan rejection, explicit recreate preserving safe fields and ready health; it does not select or run a real replacement model. `--source-db=<path>` and `--report=<path>` are supported. Disposable configuration copies only inherited account contexts and no Todo/session/history/prompt data. Running campaign data is not copied, so smoke impact counts describe the disposable store, not a live-source campaign inventory.

Real-AI Campaign smoke evaluates ordered candidates without reservations. Stale unavailable fallbacks are diagnostic only. The first production-available candidate must be confirmed by discovery and authorized inherited/free-local under the smoke safety policy. An earlier available but unconfirmed/unauthorized candidate is not silently bypassed: doing so could launch a different candidate than preflight approved. All-stale profiles remain ineligible. Reconciliation PASS does not establish Real-AI Campaign PASS.

See [smoke evidence](Execution_Profile_Reconciliation_V1_Smoke_Report.md). Campaign readiness can advance only after actual Real-AI PASS and final green CI.
