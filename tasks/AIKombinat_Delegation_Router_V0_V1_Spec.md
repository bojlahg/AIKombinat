# AIKombinat — Delegation Router V0/V1
## Telemetry + `bulk_read`

## Статус

ТЗ на следующий экспериментальный этап AIKombinat после `AgentForum Disable V1`.

Архитектурная основа: документ **AI Kombinat — Delegation Router / Cheap Worker Offloading**.

Это ТЗ намеренно делает первую реализацию уже и безопаснее исходной концепции:

```text
V0  Telemetry
    ↓
V1  bulk_read
    ↓
real-world measurement
    ↓
только потом V2 large output / logs
```

Не строить сразу универсальный computational router, persistent worker pool, generic DAG или систему дешёвого code generation.

---

# 1. Зафиксированный baseline

На момент подготовки ТЗ:

```text
repository:
bojlahg/AIKombinat

main:
819309976a2305b9f76d070c68fd9c5fad8a1d47

commit:
fix(experiments): close AgentForum-disable gaps

CI:
#66
run: 34054109156
status: SUCCESS
```

Проверено GitHub Actions:

```text
Type Check   PASS
Server Tests PASS
Client Tests PASS
Build        PASS
CI Gate      PASS
```

AgentForum сейчас:

```text
disabled by default
implementation retained
schema/data retained
recovery retained
```

Перед реализацией заново проверить актуальный `main`.

Если он продвинулся:

```text
git pull --ff-only
```

и работать от нового clean HEAD.

---

# 2. Цель

Добавить в AIKombinat второй уровень маршрутизации:

```text
Task
  ↓
Primary coding agent
  ↓
operation
  ↓
Delegation Router
  ↓
cheapest sufficient execution path
```

Но V0/V1 поддерживает только ограниченный сценарий:

```text
large exploratory file read
  ↓
delegation worker
  ↓
relevant line ranges + compact summary + verified evidence
  ↓
primary agent performs targeted reads itself
```

Главная продуктовая цель:

```text
уменьшить bulk context,
который попадает в сильную primary model,
не передавая дешёвой модели архитектурные решения.
```

---

# 3. Главный принцип

В перспективе:

```text
Tier 0
deterministic local tools

        ↓ если недостаточно

Tier 1
delegation worker
cheap / fast model

        ↓ если недостаточно

Tier 2
primary strong model
```

Но V1 **не должен утверждать, что конкретный executor дешёвый**, если у системы нет достоверной стоимости.

Core terminology:

```text
Primary Executor
Delegation Worker
Delegation Operation
```

UI может подсказать типичный профиль вроде:

```text
Antigravity / Gemini Flash
```

но core не хардкодит его.

---

# 4. Решения V0/V1, которые уже приняты

## 4.1 Не создавать второй scheduler

Использовать существующие:

```text
Model Catalog
Execution Profiles
resolveExecutionConfig
ExecutorPool
ProviderQuotaService
CLI adapters
Unified Logging
process lifecycle/recovery
```

Delegation Router не получает отдельную копию provider availability, quota или model registry.

## 4.2 Не создавать новый Delegation Profile schema в V1

Для worker выбрать обычный существующий:

```text
Execution Profile
```

Настройка Delegation хранит:

```text
worker_execution_profile_id
```

Это профиль-кандидат для delegation operations.

Если позже операции потребуют отдельной богатой policy model — сделать это после реального использования.

## 4.3 Не делать persistent worker pool в V1

V1:

```text
one delegation
→ one worker process
→ one result
→ process exits
```

Причина: streaming-stdin session у Antigravity сохраняет единый conversation context между turns. Persistent worker без строгого reset/isolation может смешивать файлы и задачи между независимыми delegation requests.

Сначала измерить реальный startup overhead.

Persistent workers — только отдельный будущий эксперимент.

## 4.4 Не выдумывать token savings

Хранить:

```text
source_bytes
source_chars
returned_chars
actual worker input/output tokens — только если provider реально сообщает
actual parent usage — только если provider реально сообщает
```

Допустимо вычислять:

```text
context_avoided_chars
reduction_by_chars
```

Не показывать фиктивные `parent tokens saved`, полученные делением символов на четыре или другой эвристикой.

No fake telemetry.

## 4.5 V1 enforcement — только conservative

Hooks здесь:

```text
cost optimization boundary
```

а не security boundary.

Если Router / worker недоступен:

```text
primary task должен иметь возможность продолжить работу.
```

Infrastructure failure не должен превращать AIKombinat в систему, которая запрещает агенту читать код и потом сама не может его прочитать.

## 4.6 Shell parsing не делать главным V1 enforcement

V1:

```text
Claude Read enforcement
+
Codex/Claude telemetry
+
MCP bulk_read
```

Codex часто читает через unified exec / Bash-like tool path.

Не писать сразу эвристический shell parser для `cat`, `sed`, `Get-Content`, Python one-liners, `awk`, `head/tail`.

Это V2 после telemetry.

Если текущий Codex реально выдаёт отдельный безопасно нормализуемый file-read tool, его можно поддержать после доказательства fixture/test, но не предполагать.

---

# 5. Non-goals V0/V1

Не реализовывать:

- code generation delegation;
- bug-fix delegation;
- architecture delegation;
- debugging delegation;
- race/concurrency reasoning delegation;
- security review delegation;
- final review delegation;
- mechanical code transformations;
- build/test log offloading;
- generic `summarize`;
- generic `inspect_log`;
- semantic repository-wide code search;
- persistent worker pool;
- worker conversations reused across requests;
- Provider Accounts;
- account failover;
- Dynamic Routing;
- cost optimizer;
- Consensus Review;
- QA Kombinat;
- generic pipeline/DAG;
- shell-command rewriting;
- full shell bypass enforcement;
- automatic model benchmarking;
- automatic "cheapest model" claims.

---

# 6. High-level architecture

```text
Primary AIKombinat Execution
        │
        ├── execution identity
        ├── workDir
        ├── provider/model
        └── delegationDepth = 0
        │
        ▼
Provider Tool Call
        │
        ▼
Provider Hook Adapter
        │
        ▼
NormalizedOperation
        │
        ▼
Delegation Policy
        │
        ├── allow
        ├── suggest
        └── deny-for-bulk-read
                │
                ▼
     execution-scoped Delegation MCP
                │
                ▼
          kombinat.bulk_read
                │
                ▼
        BulkRead Service
        ├── path containment
        ├── file identity
        ├── input limits
        ├── worker admission
        └── structured evidence
                │
                ▼
        Delegation Worker
     existing Execution Profile
                │
                ▼
         structured result
                │
                ▼
   validated ranges + real snippets
                │
                ▼
        Primary Agent
       targeted Read only
```

---

# 7. Parent execution identity

Delegation must be tied to a specific running AIKombinat execution.

Every supported AIKombinat-launched parent process should receive runtime context:

```text
AIKOMBINAT_EXECUTION_ID
AIKOMBINAT_EXECUTION_KIND
AIKOMBINAT_DELEGATION_DEPTH=0
```

Exact transport can be environment variables or an equivalent internal launch context.

Required properties:

- immutable for the process lifetime;
- not inferred from current Todo status after spawn;
- maps to actual persisted execution snapshot;
- includes actual parent provider/model/effectiveModel through server lookup;
- no secrets stored in ordinary execution logs.

V1 enforcement is required for:

```text
headless Todo implementation/rework execution
```

Telemetry may support Session/Discussion if the integration is already generic and safe, but their enforcement is not an acceptance criterion.

---

# 8. Recursion guard

Delegation worker must run with:

```text
AIKOMBINAT_DELEGATION_DEPTH=1
```

Rules:

```text
depth == 0
→ delegation allowed

depth > 0
→ no further delegation
→ hooks no-op / allow
→ delegation MCP not injected
```

Worker cannot recursively call another worker.

Hard maximum:

```text
maxDelegationDepth = 1
```

Do not rely only on prompt instructions.

---

# 9. Execution-scoped Delegation MCP

Current AIKombinat already has a general MCP server with project/todo/session management tools.

**Do not give this full administrative MCP surface to the delegation path.**

Create a least-privilege delegation MCP surface.

V1 exposes only:

```text
bulk_read
```

Conceptually:

```text
Primary Claude/Codex
    ↓
execution-scoped MCP connection
    ↓
AIKombinat Delegation MCP
    ↓
bulk_read
```

The MCP request must be mapped server-side to:

```text
parent execution
parent workDir
parent run identity
```

without trusting a model-supplied arbitrary workspace path.

Preferred:

```text
execution-scoped capability/header/context
```

configured by AIKombinat when the parent CLI is launched.

If provider MCP transport cannot carry a safe execution-scoped header, use a thin stdio bridge inheriting the execution context.

Do not put a long-lived bearer secret into model-visible tool arguments.

Do not expose `create_todo`, `start_todo`, `stop_todo`, session deletion, schedule deletion or other administrative MCP tools through this delegation connection.

---

# 10. Provider MCP configuration

Before implementation, inspect current installed/provider-supported MCP configuration for Claude Code and Codex.

Use provider-native temporary/execution-local configuration when available.

Requirements:

- do not destructively overwrite user MCP config;
- do not modify tracked project config merely to launch a Todo;
- temporary config removed after execution;
- generated config excluded from task Git diff;
- exact execution-scoped Delegation MCP connection injected only while delegation is enabled;
- parent process without delegation enabled receives no delegation MCP config;
- worker receives no delegation MCP.

Do not force this through arbitrary `extraOptions`.

If adapter needs new explicit fields, add typed launch options at provider edge.

---

# 11. Hook integrations

Use current provider-native `PreToolUse` hooks.

Before coding hook installer behavior, verify current official/provider CLI contract and current installed CLI version/help.

Known current contracts:

## Claude

`PreToolUse` can observe tools including `Read`, `Bash`, `PowerShell`, `Edit`, `Write`, `Glob`, `Grep` and MCP tools.

Important known limitation:

```text
@file references inserted directly into prompt
do NOT fire PreToolUse Read.
```

Do not claim complete enforcement.

## Codex

Current hooks support `PreToolUse` for Bash/unified exec, `apply_patch`, MCP and other local function tools.

Codex hook definitions require trust/review by exact hook definition hash unless managed by policy.

**Do not use `--dangerously-bypass-hook-trust` in normal product flow.**

---

# 12. Hook scope

Install hooks at user level, not into every project/worktree.

However the hook must be inert outside an AIKombinat execution.

Concept:

```text
if AIKOMBINAT delegation execution context absent:
    exit 0 immediately
```

Thus ordinary `claude` or `codex` launched manually outside AIKombinat must not be routed or blocked.

---

# 13. Hook installer safety

Add a managed hook installer service.

Requirements:

- never replace the whole user config;
- preserve existing hooks;
- install only AIKombinat-owned entry;
- idempotent install;
- idempotent uninstall;
- backup before first mutation;
- atomic write;
- malformed user config → refuse safely, no overwrite;
- no duplicate hooks;
- report detected provider version;
- report whether hook definition is installed;
- report whether a real hook event has ever been observed.

Codex-specific:

- detect `hooks.json` vs inline `[hooks]` configuration;
- do not blindly create conflicting representations in the same config layer;
- if safe automatic merge cannot be proven, show `manual_action_required`;
- expose `needs_trust` separately from `installed`.

Possible UI states:

```text
not_installed
installed_unverified
needs_trust
verified
incompatible
manual_action_required
error
```

Never equate `file patched` with `hook actually executes`.

---

# 14. Hook bridge

Do not require a heavyweight full AIKombinat application startup per tool call.

The hook bridge must:

```text
stdin native hook JSON
  ↓
provider adapter
  ↓
local AIKombinat server
  ↓
decision
  ↓
provider-native stdout JSON
```

Requirements:

- cross-platform strategy;
- fast startup;
- no project source copied to hook temp files;
- no full prompt;
- no provider secrets;
- hook process inherits execution context;
- timeout bounded.

If an already available lightweight runtime path can be reused, use it.

Do not introduce a persistent hook daemon in V1 unless unavoidable.

Record hook overhead in telemetry.

---

# 15. Hook failure semantics

This is cost optimization, not security.

For `telemetry` and `suggest`, if local AIKombinat hook endpoint is unavailable:

```text
fail open
→ allow original tool call
```

For `enforce_bulk_read`:

- server reachable + policy confidently says large full read + worker route healthy → deny;
- server unavailable → allow;
- execution context unknown → allow;
- worker profile unconfigured → allow;
- all worker candidates unavailable → allow;
- delegation is in temporary fallback grace → allow.

Never strand the primary agent because the optimization layer is broken.

---

# 16. NormalizedOperation

Provider-specific hook payloads are translated at the edge.

Suggested core type:

```ts
type DelegationOperation =
  | {
      type: 'read_file';
      path: string;
      offset?: number | null;
      limit?: number | null;
    }
  | {
      type: 'shell';
      commandKind?: string | null;
      rawLength: number;
      commandHash?: string;
    }
  | {
      type: 'unknown_tool';
      toolName: string;
    };
```

Do not persist raw shell command text by default.

Provider adapters own native payload → `NormalizedOperation` conversion.

Common policy must not inspect raw provider-specific JSON.

---

# 17. DelegationPolicy

V1 decisions:

```text
allow
suggest_bulk_read
deny_use_bulk_read
```

Do not implement generic rewrite in V1.

Inputs:

```text
operation
policy mode
parent execution
workDir
file metadata
configured thresholds
worker route health
fallback grants
delegationDepth
```

Outputs include:

```text
decision
reason code
human-readable provider response
telemetry metadata
```

Reason codes examples:

```text
targeted_read
small_file
telemetry_only
bulk_read_suggested
bulk_read_required
worker_unconfigured
worker_unavailable
fallback_grant
outside_workspace
delegation_depth
unsupported_tool
```

---

# 18. Rollout modes

Settings:

```text
disabled
telemetry
suggest
enforce_bulk_read
```

## disabled

No delegation hooks/MCP injection for execution.

Installed global hooks remain inert because no execution context is present.

## telemetry

Observe operations. Never deny.

## suggest

Add provider-visible guidance when a large exploratory read is detected. Original call remains allowed.

## enforce_bulk_read

Only conservative supported reads may be denied.

V1 required enforcement:

```text
Claude Read
```

Codex shell read blocking is NOT required in V1.

---

# 19. Read policy

Defaults are starting values, not universal truths:

```text
full_file_threshold_lines = 400
max_targeted_read_lines = 250
max_bulk_input_bytes = 1 MiB
max_bulk_input_lines = 20_000
max_worker_ranges = 8
max_total_recommended_lines = 800
worker_timeout_seconds = 60
```

Expose thresholds in settings where useful.

Targeted read with `limit <= max_targeted_read_lines` → allow.

Small full read below configured threshold → allow.

Large full read:

```text
Telemetry → record only
Suggest   → allow + additional context
Enforce   → if route healthy: deny + instruct bulk_read
            else: allow
```

---

# 20. Avoid expensive line counting in hook hot path

Hook policy must not synchronously reread a huge file from scratch on every tool call solely to count lines.

Implement metadata caching keyed by stable metadata such as:

```text
canonical path
size
mtime
```

or use a fast byte threshold as an initial guard before line counting.

Do not let telemetry mode add hundreds of milliseconds to every tool call.

Measure hook decision latency.

---

# 21. `bulk_read` contract

V1 tool:

```text
kombinat.bulk_read
```

Model-visible input should be minimal:

```ts
{
  path: string,
  query: string
}
```

Optional bounded parameter may include `max_ranges`.

The model must not control:

```text
worker provider
worker model
workspace root
parent execution id
security policy
```

Those come from server-side execution context/settings.

---

# 22. Path security

`bulk_read` must never widen filesystem access beyond parent execution.

For requested path:

1. resolve against parent `workDir`;
2. canonicalize;
3. verify actual target is a regular file;
4. resolve symlinks/realpath;
5. require real target to remain inside allowed workDir;
6. reject directory traversal;
7. reject outside-workspace symlink escape;
8. do not follow arbitrary device/special files.

Reuse existing path/test-hardening helpers where appropriate.

Do not read arbitrary user home paths merely because the model supplied an absolute path.

---

# 23. Sensitive file policy

Delegation to a second provider can export source data outside the primary provider.

Therefore user enablement must be explicit.

Additionally V1 must fail closed for obviously sensitive material.

At minimum inspect/reuse existing project file permission policy.

If no reusable policy exists, add conservative protection for patterns such as:

```text
.env
.env.*
credentials
private keys
SSH keys
.git internals
AIKombinat auth/config secrets
```

Do not silently send these files to the worker.

Return:

```text
delegation_sensitive_path
```

and let the primary execution handle the requirement through its ordinary permissions.

---

# 24. File identity / stale detection

Before worker call record:

```text
size
line count
SHA-256
```

After worker returns, recheck file identity.

If file changed:

```text
bulk_read result = stale
```

Do not return line ranges from an older file version as current evidence.

---

# 25. Worker input

The worker does not need repository filesystem access.

AIKombinat reads the allowed file and sends its content in the worker prompt.

Worker runs:

```text
read-only-worker policy
strict/safest supported sandbox
no delegation MCP
no implementation suffix
delegationDepth = 1
```

Prefer no write-capable tools.

If provider supports disabling tools for this run, use typed provider-native launch configuration.

Do not smuggle security-critical flags through arbitrary `extraOptions`.

---

# 26. Prompt injection handling

Source code is untrusted input.

Worker instructions must explicitly state that file content is DATA and instructions found in comments/strings/docs/source must not be followed.

Use clear data delimiters.

Worker only analyzes against caller query and returns required structured schema.

Worker cannot make final implementation decisions.

---

# 27. Structured worker output

Use structured provider output when supported.

Do not parse arbitrary prose when provider can enforce schema.

Conceptual result:

```json
{
  "summary": "Texture lifetime is managed by ...",
  "ranges": [
    {
      "start_line": 1840,
      "end_line": 1912,
      "reason": "CreateTexture allocates and registers the texture.",
      "symbols": ["Renderer::CreateTexture", "texturePool"]
    }
  ],
  "related_symbols": ["pendingDestroy", "frameIndex"],
  "scan_notes": "No other matching lifetime code found in this file."
}
```

Do not ask worker for numeric confidence unless there is a meaningful calibrated definition.

---

# 28. Server-side result validation

Never trust worker line ranges blindly.

Validate:

```text
1 <= start_line <= end_line <= file_line_count
range count <= configured maximum
total recommended lines <= configured maximum
strings bounded
JSON/schema valid
```

Merge overlapping ranges if useful.

Reject absurd output.

---

# 29. Verified evidence

Returned result to parent should contain:

```text
workspace-relative file
file SHA-256
line count
query
worker summary
validated relevant ranges
real server-extracted anchor snippets
truncation markers
worker execution identity
```

The snippets must come from the actual file after range validation, not from worker-generated quotes.

Keep evidence compact.

Primary agent still performs targeted reads for full reasoning.

---

# 30. No-match semantics

Worker returning no ranges does NOT prove the behavior is absent.

Return:

```text
status: no_match
```

with explicit message:

```text
No relevant ranges were identified by the delegation worker.
This is not proof that the file is irrelevant.
```

Primary agent may use deterministic search, change query or perform direct read through fallback policy.

---

# 31. Worker admission

Delegation worker selection uses the configured existing Execution Profile.

Rules:

```text
resolve at delegation start
respect Model Catalog
respect provider availability
respect ExecutorPool
respect ProviderQuotaService
respect actual model/effort compatibility
persist actual resolved execution snapshot
```

Do not resolve an effective model twice.

Worker snapshot records actual provider, logical model, `effectiveModel`, effort, execution profile and candidate.

---

# 32. Avoid parent/child deadlock

A parent process may already occupy provider capacity.

Delegation must never wait indefinitely for a worker slot that only becomes free when the parent finishes.

V1 rule:

```text
bounded immediate admission
```

If no worker candidate is immediately/quickly available:

```text
delegation_unavailable
→ grant direct-read fallback
```

Do not put the parent into a long-lived `waiting_executor` while the parent itself holds required capacity.

Do not exceed configured provider concurrency to solve the deadlock.

---

# 33. Worker failures

Classify through existing provider failure handling.

Examples:

```text
quota_exhausted
auth_error
transport_error
timeout
invalid_structured_output
process_failure
cancelled
```

Provider quota updates still apply when a real quota-exhausted response is observed.

Do not mark quota exhausted for invalid JSON, EPIPE, timeout or ordinary model error.

---

# 34. Direct fallback grant

Prevent useless loops:

```text
full Read denied
→ agent calls bulk_read
→ worker unavailable
→ agent retries full Read
→ denied again forever
```

After delegation infrastructure failure, create a short-lived one-use fallback grant scoped to:

```text
parent execution
canonical file
current file identity/hash
```

Example:

```text
TTL: 60 seconds
uses: 1
```

Next matching full read:

```text
allow
reason = delegation_failed_fallback
```

Consume the grant once.

Also grant fallback for worker timeout, transport failure, invalid result and `no_match` when caller retries direct read.

Do not grant it for sensitive-path refusal or outside-workspace request.

---

# 35. Parent cancellation

Track active delegations by parent execution.

If parent Todo/rework is stopped:

```text
cancel active delegation worker
```

Use existing fail-closed process stop contract.

Do not forget worker PID or release provider slot before confirmed termination.

Late worker completion after parent cancellation must be ignored.

---

# 36. Persisted Delegation Run lifecycle

A worker is a real AI CLI process.

Do not create another unmanaged child-process class.

Add persisted lifecycle sufficient for:

```text
running
completed
failed
cancelled
recovery_required
```

Suggested table:

```text
delegation_runs
```

Fields may include:

```text
id
parent_execution_id
parent_owner_type
parent_owner_id
operation
status
execution_profile_id
execution_snapshot
source_path_relative
source_sha256
source_bytes
source_chars
source_lines
query_hash / bounded query metadata
started_at
finished_at
latency_ms
process_pid
process_identity
worker_input_tokens nullable
worker_output_tokens nullable
returned_chars
context_avoided_chars
error_code
error_detail_bounded
```

Do not persist full source content, full worker prompt or full worker output.

---

# 37. Delegation worker process recovery

Extend existing recovery semantics to delegation worker PIDs.

On server restart:

### PID dead

```text
mark interrupted/failed
clear PID/identity
release provider/resource ownership
```

### identity mismatch

```text
PID is not ours
never signal
clear stale ownership
```

### identity match

The caller MCP request is gone after restart.

Terminate/reconcile the worker safely or place it in recovery-required until safe termination completes.

Do not pretend the delegation can resume its old request.

### identity unverifiable

```text
do not signal blindly
retain provider ownership
recovery_required
passive reconciliation
```

Reuse generic process identity/recovery helpers.

Do not invent weaker PID-only logic.

---

# 38. ExecutorPool accounting

A running or unresolved delegation worker consumes provider capacity.

Add it to existing active usage calculation without double counting.

Owner identity example:

```text
delegation:<delegation_run_id>
```

Release exactly once.

Do not count completed/failed runs with no retained PID.

---

# 39. ResourceManager

V1 worker usually needs no special physical resource beyond provider execution.

Do not invent a fake resource such as `cheap.worker`.

If a selected profile later maps to a local model requiring a real shared resource, use existing ResourceManager semantics.

No parallel resource scheduler.

---

# 40. V0 Telemetry

V0 ships before enforcement is enabled.

Observe tool calls through hooks.

For every relevant tool observation record:

```text
event id
timestamp
parent execution id
parent provider
parent model/effectiveModel
tool name
normalized operation
workspace-relative path when safe
requested offset
requested limit
file size when cheaply available
policy mode
decision
decision reason
hook latency
```

For shell store by default:

```text
tool
command kind if safely derivable
raw command length
command hash
```

Do NOT store raw command text by default.

---

# 41. Telemetry privacy

Never store in normal telemetry:

- file contents;
- prompt contents;
- complete shell command;
- environment variables;
- credentials;
- OAuth/session tokens;
- full provider stdout/stderr;
- full MCP auth/context token.

Unified log also must not record them.

Use existing redaction/logger rules.

---

# 42. Telemetry retention

Tool-call telemetry can grow quickly.

Implement bounded retention.

Suggested default:

```text
30 days
```

or reuse an existing app telemetry/log retention setting if semantically suitable.

Add cleanup through normal startup/maintenance path.

No unbounded SQLite growth.

---

# 43. Actual Delegation telemetry

For each `bulk_read` run record:

```text
Delegation ID
Parent execution/provider/model
Operation
Relative source path
Source bytes/chars/lines
Resolved worker provider/model/effectiveModel/effort
Latency
Actual worker input/output tokens if provider reports them
Returned chars
Context avoided chars
Status
Failure code
Fallback granted?
```

Compute:

```text
context_avoided_chars = max(0, source_chars - returned_chars)
```

Label it as characters, not tokens.

---

# 44. Task-level report API

Provide a server API to summarize delegation for Todo / execution round.

Example:

```json
{
  "toolObservations": 147,
  "largeReadsObserved": 12,
  "bulkReadRuns": 8,
  "bulkReadSucceeded": 7,
  "fallbacks": 1,
  "sourceCharsProcessed": 284300,
  "returnedChars": 21600,
  "contextAvoidedChars": 262700,
  "workerInputTokens": 81000,
  "workerOutputTokens": 4200,
  "averageLatencyMs": 4800
}
```

Token fields nullable/partial when provider did not expose them.

No fabricated percentage by tokens.

Character reduction percentage is allowed and must be labelled as character reduction.

---

# 45. Settings

Add:

```text
Settings
└── Delegation
```

Minimal V0/V1 controls:

```text
[ ] Enable Delegation Router

Mode:
Telemetry
Suggest
Enforce bulk read

Worker Execution Profile:
[ profile selector ]

Bulk read:
Full-file threshold: 400 lines
Max targeted read: 250 lines
Max file input: 1 MiB
Worker timeout: 60 s

Claude hook:
Installed / Needs verification / Verified / Error
[Install] [Remove]

Codex hook:
Installed / Needs trust / Verified / Error
[Install] [Remove]

Statistics:
Observed tool calls
Bulk reads
Successful delegations
Fallbacks
Source chars processed
Chars returned
Character reduction
Average worker latency
```

Do not build a full analytics dashboard yet.

---

# 46. Explicit data-sharing warning

Enabling V1 means project source may be sent to a different configured provider.

Settings must state clearly:

```text
bulk_read sends the selected file content to the configured Delegation Worker Execution Profile.
```

If worker profile changes provider, user should be able to see that before enabling enforcement.

No silent provider switching.

---

# 47. Settings persistence

Use existing app settings storage for simple Delegation settings.

Suggested keys/concept:

```text
delegation.enabled
delegation.mode
delegation.worker_execution_profile_id
delegation.bulk_read.full_file_threshold_lines
delegation.bulk_read.max_targeted_read_lines
delegation.bulk_read.max_input_bytes
delegation.worker_timeout_seconds
```

Do not add a new config file if app settings already fit.

Validate bounds server-side.

---

# 48. UI / i18n

All new UI strings through core i18n.

Required:

```text
EN
KO
RU
```

Identical key and placeholder sets.

No hardcoded English/Korean/Russian in React components.

---

# 49. Hook status API

Provide server endpoints for:

```text
GET delegation settings/status
PUT delegation settings
GET hook status
POST install hook
POST remove hook
GET delegation statistics
```

Exact REST paths follow current route conventions.

Do not allow arbitrary filesystem path from client for hook config.

Server chooses known user config locations.

---

# 50. Hook installation and user config tests

Use temp HOME/config roots.

Required Claude tests:

1. existing unrelated hooks preserved;
2. existing deny/ask/settings preserved;
3. install adds one AIKombinat hook;
4. repeated install does not duplicate;
5. remove removes only AIKombinat entry;
6. malformed JSON is not overwritten;
7. backup/atomic behavior;
8. external ordinary Claude run without AIKombinat env causes hook no-op.

Required Codex tests:

1. existing hooks preserved;
2. `hooks.json` safe merge;
3. detect conflicting inline hooks representation;
4. `needs_trust` not reported as verified;
5. never use `--dangerously-bypass-hook-trust`;
6. repeated install idempotent;
7. remove only managed hook;
8. malformed config fail-safe.

No real home directory mutation in tests.

---

# 51. Hook adapter tests

Use recorded/synthetic payload fixtures.

Claude:

```text
Read large full file
Read targeted range
Read small file
unknown tool
Bash event telemetry
```

Codex:

```text
Bash/unified exec telemetry
MCP tool telemetry
apply_patch telemetry
unknown local function
```

Verify provider-native output shape.

No real Claude/Codex launch in automated tests.

---

# 52. `bulk_read` file tests

Use TestWorkspace/temp repos.

Required:

1. relative file inside workDir succeeds;
2. absolute path inside workDir canonicalizes safely;
3. `..` escape rejected;
4. symlink to external file rejected;
5. internal symlink handled only if real target remains inside root;
6. directory rejected;
7. special/non-regular file rejected where platform supports;
8. sensitive `.env` rejected;
9. oversized file returns bounded explicit error;
10. file changing during worker call returns stale;
11. UTF-8/Cyrillic/CJK source preserved;
12. binary file rejected in V1.

---

# 53. Structured result tests

Fake worker only.

Cases:

```text
valid ranges
overlapping ranges
out-of-bounds range
too many ranges
too many total lines
invalid JSON
empty result
no_match
hallucinated snippet text
```

The returned anchor snippets must always come from real test file content.

---

# 54. Admission tests

Use fake providers/admission.

Required:

1. configured worker profile selects available candidate;
2. quota-exhausted candidate not selected;
3. unavailable model not selected;
4. effectiveModel frozen once;
5. worker snapshot contains exact selected provider/model/effort;
6. parent holds Claude slot, worker Antigravity available → succeeds;
7. parent holds only available slot for same provider → delegation does not deadlock;
8. no candidate available → direct fallback grant;
9. worker timeout → fallback grant;
10. provider quota error updates existing quota service correctly.

---

# 55. Fallback loop tests

Required:

```text
large full Read
→ hook deny
→ bulk_read fails
→ fallback grant
→ same parent/file/hash full Read
→ allowed once
→ grant consumed
```

Also:

```text
different file
→ grant does not apply

file changed hash
→ old grant does not apply
```

---

# 56. Cancellation/recovery tests

Required:

1. parent stop cancels running delegation;
2. confirmed worker exit releases provider slot once;
3. unresolved stop retains PID/provider ownership;
4. late worker exit releases exactly once;
5. restart with dead worker reconciles;
6. restart identity mismatch never kills unrelated PID;
7. unverifiable identity fails closed;
8. stale recovery cannot clobber newer run;
9. cancelled parent ignores late worker result.

Reuse existing process identity helpers.

No real OS process kills.

---

# 57. V0 rollout behavior

First implementation stage:

```text
mode = telemetry
```

No tool blocking.

Acceptance for Phase V0:

- hooks can be installed safely;
- hook events arrive for AIKombinat-launched parent;
- manual non-AIKombinat CLI stays untouched;
- telemetry persists;
- statistics API works;
- hook overhead measured;
- no prompts/source content in telemetry.

Commit can remain one task/one final commit, but implementation should verify V0 behavior before enabling V1 enforcement code paths.

---

# 58. V1 rollout behavior

After V0 tests are green implement:

```text
execution-scoped Delegation MCP
bulk_read
worker profile admission
structured evidence
fallback grants
Claude Read suggest/enforce
```

Default after upgrade:

```text
Delegation Router disabled
```

If user enables it, recommended first mode:

```text
telemetry
```

Do not automatically enable `enforce_bulk_read` for existing users.

---

# 59. Performance requirements

Telemetry hook path is synchronous in provider flow.

Measure it.

Target for local successful telemetry decision:

```text
median <= 100 ms
```

Prefer substantially lower.

No strict failure if CI host jitter exceeds that in unit tests; performance test may use generous deterministic boundary.

More important invariant:

```text
no model call from PreToolUse hook itself.
```

The worker runs only after explicit `bulk_read`.

---

# 60. Quality / success criteria

V1 is considered technically successful when:

1. large reads can be identified without breaking normal tool usage;
2. primary agent can call `bulk_read`;
3. worker returns validated relevant ranges;
4. parent can targeted-read those ranges;
5. worker cannot recursively delegate;
6. source cannot escape workDir;
7. sensitive obvious secrets are not delegated;
8. no unmanaged worker process is introduced;
9. worker admission respects existing quota/concurrency;
10. fallback prevents routing loops;
11. telemetry is honest and bounded;
12. feature is reversible/disabled by default.

Product usefulness is **not** declared from unit tests.

After shipping V1, run real coding tasks and measure:

```text
character reduction
worker latency
fallback frequency
whether primary follows suggested ranges
task success / review outcome
```

Do not hardcode a 40/60/90% savings claim into product logic.

---

# 61. Manual integration smoke

Automated tests must never run real AI providers.

After automated validation, if developer machine has authenticated CLIs and user environment allows a small smoke:

### Claude parent

1. Enable Delegation Router telemetry.
2. Run a small AIKombinat Todo.
3. Confirm real Claude hook event observed.
4. Confirm ordinary targeted Read still works.

### Codex parent

1. Verify hook installation state.
2. If Codex reports `needs_trust`, do not bypass trust automatically.
3. After manual trust, confirm a real event reaches AIKombinat.

### `bulk_read`

Use a harmless temporary/test repository file large enough to exceed threshold.

Run one delegation through configured worker profile.

Confirm:

```text
structured result
validated ranges
verified snippets
worker execution snapshot
telemetry
no repo writes by worker
```

Do not use private production secrets for smoke.

If real provider smoke cannot be performed, report `NOT RUN`, not PASS.

---

# 62. Logging

Use shared logger.

Useful bounded events:

```text
delegation.hook.observed
delegation.policy.decision
delegation.run.started
delegation.run.completed
delegation.run.failed
delegation.run.cancelled
delegation.fallback.granted
delegation.fallback.used
delegation.hook.install
delegation.hook.remove
delegation.recovery
```

Never log full file content, full query if it may contain source/context, raw shell command, full worker prompt/output, delegation auth token or provider credentials.

---

# 63. DB / ERD

Schema changes are expected for persisted telemetry/run lifecycle.

Use normal migrations.

Update ERD through repository generator.

No destructive migration.

Existing DB must upgrade safely.

Old builds/data do not need delegation backfill.

---

# 64. Documentation

Update:

```text
ROADMAP.md
README only if needed
AGENTS.md only for durable new engineering invariants
```

ROADMAP: mark `Delegation Router V0/V1` as implemented only when all acceptance criteria are met.

Do NOT prematurely mark V2 large output/logs, persistent workers or adaptive routing as implemented.

Add a concise technical doc, suggested:

```text
Docs/Delegation_Router_V0_V1.md
```

covering architecture, settings, hook status, bulk_read contract, telemetry semantics, known limitations, hook removal and Codex trust requirement.

---

# 65. Known V1 limitations — document honestly

Must explicitly document:

1. Claude `@file` references can bypass `PreToolUse Read`.
2. Codex may read through shell/unified exec; V1 does not attempt complete shell parsing.
3. Hooks are cost optimization guardrails, not sandbox security.
4. Worker quality may miss implicit cross-file context.
5. `no_match` is not proof of absence.
6. One process per delegation adds startup latency.
7. Parent tokens saved are not known unless provider gives enough real usage data.
8. Worker profile must be explicitly configured.
9. Codex non-managed hooks may require manual trust.
10. V1 handles one file per `bulk_read`.

---

# 66. AGENTS.md / Git discipline

Before implementation:

```text
check unresolved conflicts
check working tree
git pull --ff-only
```

If clean sync fails:

```text
STOP
```

Never use stash, reset --hard, rebase, force checkout, force push or blanket conflict resolution.

After successful implementation/validation:

```text
commit
normal git push
STOP
```

Do not continue into V2 in the same execution.

---

# 67. Recommended implementation model

This task touches provider hooks, MCP, process lifecycle, DB, security/path containment, ExecutorPool, quota, React settings and i18n.

Use a strong coding model with high/max supported reasoning effort.

Do not delegate implementation of this feature itself to a cheap worker.

---

# 68. Validation

Mandatory:

```bash
git diff --check
npm run typecheck
npm run test:server
npm run test:client
npm run build
npm run docs:erd:check
```

If schema changed:

```bash
npm run docs:erd
npm run docs:erd:check
```

Also run targeted suites for:

```text
delegation settings
delegation hook adapters
hook installer
bulk_read
delegation lifecycle/recovery
ExecutorPool
ProviderQuotaService
execution config/model resolution
cli adapters
MCP
process recovery
test filesystem hardening
settings UI
i18n parity
```

No real AI CLI in automated tests.

---

# 69. Acceptance criteria

Task is complete only when all are true.

## V0

1. Delegation Router settings exist and default disabled.
2. Telemetry mode exists and never blocks tools.
3. Claude hook can be installed without destroying user config.
4. Codex hook can be installed safely or reports manual/trust requirement.
5. Non-AIKombinat CLI runs are unaffected.
6. Hook event maps to parent execution.
7. Telemetry contains no source/prompt/raw shell content.
8. Telemetry retention is bounded.
9. Statistics API works.
10. UI shows honest hook states.

## V1

11. Execution-scoped Delegation MCP exists.
12. It exposes only `bulk_read` in V1.
13. `bulk_read` is scoped to actual parent workDir.
14. Outside-root/symlink escape is rejected.
15. Sensitive obvious secret paths are not delegated.
16. Worker uses configured existing Execution Profile.
17. Worker goes through existing model/provider admission.
18. Worker `effectiveModel` resolves once.
19. Worker cannot recursively delegate.
20. Worker has no write-capable repo workflow.
21. Worker result is structured.
22. Line ranges are validated server-side.
23. Evidence snippets come from real file.
24. File mutation during delegation is detected as stale.
25. Worker failure grants bounded direct fallback where appropriate.
26. Router cannot deadlock parent waiting for its own provider slot.
27. Parent cancellation cancels worker.
28. Worker PID/identity is recoverable after restart.
29. Unresolved worker continues to consume provider capacity.
30. Claude large `Read` can suggest/enforce bulk_read.
31. Targeted reads remain allowed.
32. Worker unavailability makes enforcement fail open.
33. Codex shell parsing is not falsely claimed complete.
34. Actual worker token usage stored only when provider exposes it.
35. Character reduction telemetry is clearly labelled.
36. UI shows configured worker profile/provider.
37. Data-sharing warning is visible.
38. EN/KO/RU parity passes.
39. Full server tests pass.
40. Full client tests pass.
41. Typecheck passes.
42. Build passes.
43. ERD check passes.
44. `git diff --check` passes.
45. Commit is pushed normally.
46. Agent stops after successful push.

---

# 70. Completion report

Report must contain:

```text
Branch:
Commit SHA:
Push:
CI:
```

## V0 telemetry

- hook integration strategy;
- Claude installation state;
- Codex installation/trust state;
- telemetry fields;
- retention;
- measured hook latency.

## V1 bulk_read

- MCP transport/context scoping;
- file containment;
- sensitive path policy;
- worker Execution Profile;
- structured output contract;
- range validation;
- verified evidence;
- fallback logic;
- cancellation/recovery.

## Persistence

- tables/migrations;
- ERD status;
- no source content persisted.

## Tests

Exact results for targeted tests, server tests, client tests, typecheck, build, ERD and diff check.

## Real provider smoke

For each:

```text
Claude hook:
Codex hook:
bulk_read worker:
```

state explicitly:

```text
PASS
FAIL
NOT RUN
```

Do not equate mocked tests with real provider integration.

---

# 71. Next task — DO NOT START

After this task is reviewed and real-world data has been collected:

```text
Delegation Router V2
large output / logs
```

Potential scope:

```text
build output
test output
compiler diagnostics
large shell stdout
inspect_log
summarize
```

Do not implement V2 during V0/V1.
