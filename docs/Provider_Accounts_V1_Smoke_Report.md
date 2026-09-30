# Provider Accounts V1 smoke report

Date: 2026-09-30. Platform: Windows. Baseline: `961f410709db8979a6a5ab9509b71bd94301d1d1`. Real provider execution was explicitly authorized. The smoke used a disposable Git project and a separate SQLite database; it did not change the user's CLI login.

| Provider | Installed version | Strategies verified | Observed health |
| --- | --- | --- | --- |
| Claude | 2.1.246 | inherited; synthetic environment_reference | available via auth status and real execution |
| Codex | 0.156.1 | inherited | available via login status |
| Antigravity | 1.1.21 | inherited | unknown; no verified non-mutating probe |
| OpenCode | 1.18.33 | accountless | real child completed |

## Real execution evidence

Claude Todo completed with model `sonnet` and inherited policy. Account ID `c5d7901c-9bbe-48ac-9f2b-f0dff5e735ae`, slug `existing-login`, label `Existing CLI Login` and strategy `inherited` were recorded in its execution snapshot. A short Claude Orchestrator primary turn completed and recorded the same account identity. The primary reported provider model names while preserving the requested model/account snapshot.

An additional Claude Orchestrator delegated to one OpenCode child using discovered free model `opencode/muse-spark-1.3-contributor-free`. Both child and parent completed. The child snapshot contained null account ID, label, slug, strategy and policy. SQLite `foreign_key_check` returned no violations.

The reproducible scripts are `scripts/provider-accounts-smoke.ts` and `scripts/provider-accounts-opencode-smoke.ts`. They save bounded, credential-free metadata to an ignored disposable report. The second script accepts the first script's fixture directory. Real execution requires explicit authorization and installed, authenticated CLIs; there is no paid model fallback.

## Synthetic and integration evidence

Automated coverage verifies A/B environment isolation using actual Node child processes, late credential lookup and rotation, split-chunk redaction, server-secret sanitization, immutable account identity, configuration health invalidation, stable migration IDs, clean foreign keys and unchanged legacy history. Selection tests exercise inherited, fixed and deterministic automatic policies, auth-error exclusion, disabled accounts, account/provider limits under simultaneous admission, reservation cleanup and retained process ownership. Session integration verifies original-account resume despite profile edits and rejection without rewriting history when that account is disabled. Orchestrator integration verifies independent automatic account selection on fresh turns. Client tests verify account settings, health actions, stable manual selection, OpenCode's accountless UI and saved lineage.

Local validation passed: server 77 files, 1100 tests passed (2 skipped); client 34 files, 188 tests passed. Typecheck, build and ERD checks passed. Required commands: `npm run typecheck`, `npm test`, `npm run build`, `npm run docs:erd:check`, `git diff --check`. GitHub CI status is reported with the resulting commit in the task response.

## Limitations

- Real API-key account execution was not performed; A/B references were verified with synthetic child processes.
- Codex and Antigravity expose inherited login only in V1; their non-inherited isolation contracts are not claimed.
- Antigravity health remains unknown until successful execution; no supported authentication probe was invented.
- Claude environment-reference probing remains unknown until execution; login status cannot prove an API key's validity.
- SSH rejects non-inherited account context. Account-aware quotas and automatic retry/failover remain V2 work.

Conclusion: **READY_WITH_LIMITATIONS** after local validation passes. Real Claude Todo, primary and OpenCode child smoke all passed.
