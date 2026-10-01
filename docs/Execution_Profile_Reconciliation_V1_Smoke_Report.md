# Execution Profile Reconciliation V1 — Smoke Report

Date: 2026-10-01 (Asia/Yekaterinburg). Baseline: `1ad1228fbfeb265a847e1027af2834b6a1a9232d`.

## Real discovery and disposable repair

`npx tsx scripts/execution-profile-reconciliation-smoke.ts --report=docs/execution-profile-reconciliation-smoke-evidence.json` returned **PASS**. Source DB was opened read-only; DB/WAL/SHM fingerprints were unchanged. Only disposable configuration was repaired. No inference, login/logout or account switch was requested. [Machine-readable evidence](execution-profile-reconciliation-smoke-evidence.json) contains IDs and model/configuration metadata, without credentials, prompts or provider output.

The first sandboxed discovery attempt encountered provider access restrictions. The final run used installed provider access and produced:

| Provider | Source | Primary success | Authoritative | Models seen |
|---|---|---|---|---:|
| Claude | claude-documented | yes | no | 10 |
| Codex | codex-app-server | yes | yes | 7 |
| Antigravity | antigravity-models | yes | yes | 7 |
| OpenCode | opencode-models | no | no | 0 |

| Health | Profiles |
|---|---:|
| ready | 1 |
| degraded | 0 |
| unknown | 2 |
| blocked | 0 |
| disabled | 0 |

`Antigravity Flash` is ready with current `gemini-3.7-flash`. The profiles requiring attention are:

| Profile | Candidate model | Catalog state | Reason |
|---|---|---|---|
| Deterministic Order | Claude `m-1` | unconfirmed | weak_omission |
| Deterministic Order | Codex `m-2` | stale | authoritative_omission |
| Deterministic Order | Antigravity `m-3` | stale | authoritative_omission |
| Priority Test | Claude `claude-3.7-sonnet` | unconfirmed | weak_omission |
| Priority Test | Codex `gpt-5` | stale | authoritative_omission |

These retained manual rows can remain production-runtime available despite stale catalog evidence. No source repair was made. Suggestions remain same-provider; full exact/family/alternative classifications and candidate IDs are in the JSON evidence. Claude Sonnet references receive same-family suggestions; arbitrary fixture model identities receive alternatives, not guessed family/version mappings. OpenCode supplies no confirmed replacements on this machine.

The default synthetic disposable repair changed `reconciliation-synthetic-old` → `reconciliation-synthetic-current`, preserved `high` effort, and changed **blocked → ready**. It inserted **1 audit row**. Foreign-key validation passed. No real model was chosen automatically. Running campaign references were **0 in disposable configuration**; live-source campaigns were not copied.

## Runtime and API regressions

Automated tests prove current primary + stale fallback and stale primary + current fallback are degraded, runtime-usable, smoke-eligible and reservation-free; all stale is blocked and smoke-ineligible. Weak and failed discovery do not create false stale. API GET is cache-only and launches no discovery. Rebind rejects stale previews, wrong providers and unsupported effort; preserves account/priority/enabled fields; rolls candidate/timestamp back on injected audit failure; and leaves an existing running Todo snapshot unchanged while future selection uses the replacement.

Running campaign references are detected through direct profiles and policy members/judges. Apply without impact confirmation fails; confirmed apply changes ordinary review configuration hashing, preserving drift detection. Migration is idempotent and leaves existing profiles untouched. UI tests cover badges/usage links, searchable replacements, effort choice, old/new preview, campaign confirmation and localized errors. EN/RU/KO key and placeholder parity is green.

## Real-AI Campaign rerun

`npx tsx scripts/evaluation-campaign-real-ai-smoke.ts --keep` returned **SKIPPED_ENVIRONMENT**. No existing profile had both a current discovery-confirmed candidate and an authorized inherited/free-local candidate under the smoke policy. Antigravity is available for reconciliation but excluded by the established Real-AI Campaign safety policy. The existing Claude profiles are unconfirmed, and their Codex candidates are absent from authoritative discovery.

No implementation/review process was launched. No assignment, inference cost, token savings or comparative quality evidence is claimed. Cleanup verified no retained process ownership, leases or reservations. The disposable controller report was retained locally at `aikombinat-campaign-real-ai-8GgAMI/report.json` under the system temporary directory. Evaluation Campaigns V1 remains **READY_WITH_LIMITATIONS**.

## Validation and delivery

Final local validation: **2605 server tests passed, 2 skipped; 234 client tests passed**. Typecheck, production build, ERD check and diff whitespace check passed. Focused reconciliation coverage has 15 passing tests, including persisted history, fixed-account preservation and cold runtime cache. GitHub CI is verified for the delivered commit separately; an earlier baseline CI result is not used as delivery evidence.

Execution Profile Reconciliation V1: **READY** after delivery validation. Evaluation Campaigns V1: **READY_WITH_LIMITATIONS**, pending a real eligible-profile acceptance PASS.
