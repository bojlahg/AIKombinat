# Provider Accounts V1

Provider accounts give executions a stable authentication identity independently of model selection. Settings → Agents → Accounts manages labels, descriptions, enabled state, concurrency and health. Credentials are never entered into the app: Claude environment-reference accounts store only an environment variable name. Define that variable in the server environment and restart the server after changing its value.

## Supported provider contracts

| Provider | Strategies | Non-mutating health probe |
| --- | --- | --- |
| Claude | inherited; environment_reference | `claude auth status --json` for inherited login |
| Codex | inherited | `codex login status` |
| Antigravity | inherited | Unknown; no verified probe |
| OpenCode / raw-shell | Accountless | Outside Provider Accounts V1 |

An inherited account uses the CLI's existing login. Startup creates one compatibility account per supported provider without changing CLI login state. Claude references are resolved immediately before launch into `ANTHROPIC_API_KEY`; conflicting Claude token variables and all configured reference source variables are removed from the child environment. V1 does not support credential-file copying, global login switching or unsupported provider strategies. Non-inherited accounts are rejected for SSH execution.

## Selection and ownership

Execution profile candidates support `inherited_default`, `fixed` and `automatic`. Manual Todo, Schedule and Session selection supports inherited login or a fixed account ID. Fixed selection never silently falls back. Automatic selection prefers enabled, healthy accounts, then unknown accounts, ordered deterministically by sort order, creation time and ID. Auth-error and unavailable accounts are ineligible. V2 ranks quota availability before health, then applies deterministic account ordering. Probes run only on explicit request, never during rendering.

Admission enforces both provider aggregate capacity and account concurrency, with synchronous reservations under the pool selection mutex. Persisted process ownership continues to count even after a workflow leaves running status. A running process retains its resolved account when settings change. Fresh primary turns can independently choose accounts; Session resume requires the original saved account and rejects unknown or ineligible identity.

Snapshots store account ID, slug, label, strategy and requested policy. They contain no credential or resolved environment value. Renaming an account does not rewrite history. Legacy snapshots remain readable as Legacy / Unknown; accountless executions have null account identity. Schedules copy their account policy and ID into generated Todos. Quota now follows [Account-aware Quota V2](Account_Aware_Quota_V2.md): account observations are canonical, provider state is derived, and only automatic account policies rotate after a confirmed quota rejection.

## Storage and API

`provider_accounts` has stable IDs, provider/slug uniqueness, a unique inherited account per provider, bounded concurrency (1–32), health state/reason/time and ordering. Idempotent migration adds account policy and foreign keys to Todos, Sessions, Schedules, Discussion agents and profile candidates. Candidate uniqueness includes policy and account ID, preserving same-model candidates for different accounts. Compatibility accounts retain IDs across restarts.

`/api/provider-accounts` supports list/create; `/:id` supports read/update/delete; `/:id/test` probes health; `/capabilities` reports supported contracts. Deletion rejects inherited accounts, persisted references and active reservations. Configuration edits invalidate cached health. Health reasons are bounded and redacted; raw probe output is not stored.

Runtime credentials have a scoped redaction lifetime through confirmed process exit. Output is redacted before replay, raw chunks, diagnostics and opt-in debug logs; streaming redaction handles credentials split across chunks. Server authentication/tunnel secrets remain excluded by the existing child environment sanitizer. Neither runtime binding nor probing mutates global `process.env`.

See [smoke evidence and limitations](Provider_Accounts_V1_Smoke_Report.md), [ERD](ERD.md) and [testing](TESTING.md).

V1 status: READY_WITH_LIMITATIONS (provider-specific account strategy limits remain). Account lifecycle and quota WebSocket events are supplied by V2.
