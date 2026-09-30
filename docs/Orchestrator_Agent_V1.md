# Orchestrator Agent V1

An Orchestrator is a persisted workflow for a high-level objective. It plans and delegates through fresh Claude CLI turns, then releases the primary process while waiting for a child, resource reservation or human message. It is independent of interactive Sessions and reuses ordinary Todo execution, review/rework, ExecutorPool and Resource Fabric V2.

## Use

Open a project's **Orchestrator** tab, create a goal, select an enabled Execution Profile containing an enabled Claude candidate, set budgets and Start. The chat, explicit plan/checkpoint, child links, resource requests and turn history are persisted. A human message always wakes `waiting_event`; messages during an active turn are delivered to a subsequent turn, and paused workflows remain paused.

Pause stops the primary safely, retains pending events, lets children continue and releases unclaimed requests/holds. Resume inserts a durable `system.resumed` event. Cancel uses ordinary Todo Stop for children, revokes primary access and releases unclaimed reservations. An unresolved process keeps ownership and leaves the workflow `cancelling`. Recovery-required primary PIDs must be reconciled through Stop/Pause before Resume. Raise the turn budget through PATCH or the paused workflow's turn-budget field.

## Durable state and delivery

- `orchestrators`: objective, explicit checkpoint/plan, budgets, status and timestamps.
- `orchestrator_turns`: each execution attempt, snapshot, context hash, PID/identity, terminal action and bounded errors/output.
- `orchestrator_messages`: user, assistant and system-event chat records.
- `orchestrator_events`: immutable source event data, deterministic dedupe key and delivery metadata.
- `orchestrator_operations`: tool name, input hash, result and orchestrator-wide idempotency key; source tool arguments are not copied here.
- `orchestrator_child_jobs`: parent/turn lineage to ordinary Todos; Todo is the canonical child runtime state.
- `orchestrator_resource_requests`: purpose, parent/turn lineage, claim expiry and claimed Todo for a Fabric request.

The partial unique turn index includes every retained PID, regardless of status. Five simultaneous matching events become one pending turn. Event delivery is at least once: a turn assigns a bounded batch in creation order, and events become consumed only after a successful process exit with `yield` or `finish`. Failure, Stop or interrupted startup unassigns unconsumed events. One corrective retry is allowed; another protocol/process failure fails the workflow. Turn budget exhaustion pauses it with a budget-warning event.

The terminal action is staged while the primary still runs. `waiting_event` and `completed` are published after confirmed exit with PID cleared. Events arriving between turn assignment and yield remain pending and trigger a fresh turn after exit. Any remaining matching event, including byte-budget overflow, gets a subsequent fresh turn even after a finish action. No `claude --continue` is used.

## Managed primary MCP

Each turn receives `kombinat-orchestrator`, implemented by a stdio bridge and an ephemeral loopback transport. A random capability binds to one parent and turn; parent-project ownership is checked by server operations. The transport revokes on exit/Stop, and restart invalidates old sockets. Payloads are typed and reject unknown fields, other-parent IDs, arbitrary nodes/resource keys, empty ANY conditions and oversized UTF-8 input. The turn endpoint/capability stays in the child environment, never in the database, execution snapshot, CLI arguments or application logs. Every turn gets a new capability. Its value is registered for scoped log redaction, and primary output/errors are scrubbed before capability revocation so later diagnostics cannot expose it. Server credentials never enter the primary environment.

Tools: `checkpoint_state`, `list_execution_profiles`, `list_available_capabilities`, `delegate_task`, `get_task_status`, `cancel_task`, `request_resources`, `get_resource_request`, `release_resources`, `yield`, `finish`. Every mutating tool requires an idempotency key. Identical normalized input returns the previous result; changed input or tool name conflicts. Duplicate terminal actions can complete a fresh corrective turn without duplicating their stored effects.

The primary uses only Claude candidates, regardless of the priority of other providers. Built-ins are restricted to Read, Glob and Grep, with Edit, Write, NotebookEdit, Bash, PowerShell and Agent denied. Local/project hooks and plugins are excluded from this managed launch; only the turn's explicit MCP is loaded. This is a harness tool contract, not a filesystem/OS security sandbox. The native Claude executable was verified on Windows; a shell-only npm Claude shim is not part of the real-smoked launcher contract. Administrative Claude settings can impose further restrictions.

Children receive complete instructions, an ordinary execution profile and a separate worktree by default in Git projects. Review/Rework remains the existing pipeline. No automatic sibling branch merge occurs; an integration child performs requested integration. There is no nested Orchestrator tool or live `message_task` protocol.

## Child environment

`src/server/utils/child-environment.ts` is the canonical sanitizer for ClaudeManager (spawn and PTY, including delegation workers), orchestrator primary, AI extraction, quota/model probes and the local SSH launcher. It merges execution overrides, then removes undefined values and the explicit, case-insensitive server-only list: `SESSION_SECRET` (web session signing), `AUTH_PASSWORD` (legacy web bootstrap credential), `TUNNEL_TOKEN` (tunnel authentication). Overrides cannot restore forbidden keys.

Inspection of server sources, `.env.example` and SETUP found no additional server-only environment credential consumer. Tunnel name/hostname/enabled, session identifiers and ordinary configuration are not credentials. MCP/application credentials configured in SQLite are not inherited through `process.env`. Provider variables such as `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` remain inherited; no wildcard token/key removal is used. PATH, HOME/USERPROFILE, TEMP/TMP, CLI login/config paths, execution capabilities and Electron's node override remain available. The real Claude smoke uses the existing stored login, with no added provider API key. The independent remote Python helper strips the same three keys on the remote host; it does not inherit the controller environment.

## Resource reservations

Requests accept capability requirements, never concrete node IDs, instance keys or GPU indices. Waiting requests are processed through the existing ResourceManager, coalesced with normal capacity signals and ordered by `(created_at, id)`. Todo callbacks remain installed; the orchestrator adds notifications without replacing Todo wake behavior. Provider/executor admission is separate from hardware matching.

A successful request atomically creates the Fabric binding/leases, assigns a server-controlled five-minute claim deadline, and only then inserts `resource.fulfilled`. Valid holds survive controller restart without a PID. A single timer schedules the nearest deadline; there is no per-request polling. Expired, invalid or paused/terminal-parent holds release their leases and emit a durable event.

`delegate_task(resource_request_id)` copies the exact requirements into the child and links the reservation. The binding remains parent-owned while the child waits for executor/quota. Only after ExecutorPool admission, ResourceManager atomically transfers request/lease owner and run token to the child, preserving the binding ID and binding items. There is no release/reacquire gap. If the hold expires before admission, the child acquires through ordinary Resource Fabric using the copied requirements. The parent cannot release child-owned resources. Child release updates reservation history and emits `resource.released`.

The ResourceManager's CHECK migration rebuilds the two affected tables transactionally, preserving IDs, all existing columns, indexes and referenced bindings, then verifies foreign keys. Existing Todo/Session rows remain intact; repeated startup is idempotent.

## Budgets and limits

Defaults/hard caps: primary turns 32/128; total children 24/100; concurrent active children 4/16; active unclaimed requests 2/8; mutating operations per turn 64. Waiting children count as active. Claimed requests belong to child execution; waiting/bound unclaimed requests count against the parent's resource budget. Finish rejects active children, unresolved PIDs and active requests/holds.

UTF-8 input limits: objective/child instructions/finish summary 32 KiB; message/checkpoint/plan/event 16 KiB; purpose/wait reason 2 KiB; title 256 characters. Oversized correctness inputs are rejected. Automatic context includes explicit checkpoints, bounded children/resources/events and recent chat, not full logs, diffs or hidden reasoning. Only the provider's public result text and reported model labels are extracted from output envelopes.

The serialized primary context has a hard **256 KiB UTF-8** cap (`ORCHESTRATOR_CONTEXT_MAX_BYTES`). Objective, explicit state/plan, budgets, assigned events and all active child/resource snapshots are mandatory. Recent messages (newest first from the latest 12), terminal children and released/expired resource history are appended in that priority order only while they fit. Messages are presented chronologically after selection. `context_truncated`, `omitted_messages`, `omitted_terminal_children` and `omitted_historical_resources` report omissions. JSON is canonical, valid and deterministic for the same DB state; no serialized-string slicing or hidden reasoning storage is used.

Events are assigned in `(created_at ASC, id ASC)` order, at most 64 and **128 KiB for the complete serialized event array**, including envelopes/commas. Overflow stays unassigned/unconsumed and is delivered by a fresh turn. A single event exceeding that share, or mandatory state exceeding the aggregate cap (including JSON escaping), is an explicit protocol/configuration failure; correctness-critical inputs are never silently truncated. Context construction fails before primary launch and normal retry/redelivery preserves the inbox.

## API and recovery

`GET/POST /api/projects/:projectId/orchestrators`; `GET/PATCH /api/orchestrators/:id`; POST `start`, `pause`, `resume`, `cancel`; GET/POST `messages`; GET `children`, `resources`, `events`, `turns`; POST `resources/:requestId/release`. Routes use the existing authenticated `/api` boundary. WebSocket notifications include creation, status, messages, turns, events, child and resource updates.

Startup reconciles Fabric leases, existing Todo processes, primary PID/identity, child terminal events, holds and pending wake events before enabling dispatch. Live matching or unverifiable primary ownership is retained for explicit recovery; mismatched PIDs are never signalled. Interrupted turns cannot consume events based solely on a recorded terminal action. Clean shutdown revokes and safely stops owned primaries; waiting workflows retain their state. No external/unrelated process is a Stop target.

Status: **READY**. Security closure and real post-fix smoke are recorded in the acceptance report.

## V1 boundaries

Claude primary only; depth one; ANY wake conditions; no running-child message injection; no provider-continuation dependency; no remote OpenCode; no automatic sibling merge; no generic DAG; no checkpoint-aware arbitrary training pause; no hard cross-provider dollar budget. Remote child execution still obeys existing V2 constraints, including no remote Review/Rework or OpenCode bypass.

See [smoke evidence](Orchestrator_Agent_V1_Smoke_Report.md), [setup](SETUP.md), [testing](TESTING.md) and [ERD](ERD.md).
