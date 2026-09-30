# Resource Fabric V2

Resource Fabric selects a compute node independently of Executor Pool's provider/model selection. Inventory, policy, observations and persisted leases determine admission; there is no second mutable “leased” flag or stored available RAM counter.

## Configuration and operation

Open Settings → Resources. The local node is created once with a stable UUID. Scan it, set a friendly name, enable/disable scheduling, and configure CPU threads, RAM and storage reserves. GPU policies preserve detected hardware and support enabled, disabled, reserved and reserve-after-current states. Pending reservation blocks new admission and becomes effective before release wakes waiters.

Add an SSH node using a system SSH alias or a typed host, port and user. Choose system config, agent, or a private-key **path**; key contents and passphrases are never collected. Select a dedicated absolute Linux workspace root. Host keys must already be trusted by the user's SSH client. Unknown keys return manual_action_required; the application never disables strict host-key verification.

Test connection and scan are bounded, read-only, static probes. They use no sudo and do not crawl projects or inspect environment/key files. SSH execution additionally needs Python 3 and Git. V2 remote execution targets Linux; registering a non-Linux SSH host does not make it an executable V2 target.

Detected capabilities and manual overrides remain separate. Manual overrides can express boolean availability or a version string. Do not treat an override as software installation. Inventory history retains five snapshots per node; current observations are upserted. The health monitor scans enabled nodes sequentially every 30 seconds, coalesces overlapping scans, and emits observation events. Only structural/health/external-workload changes log at INFO. UI refreshes coalesce events.

## Requirements and binding

Todo, schedule and session editors accept legacy checkboxes or V2 fields without handwritten JSON. EN/KO/RU keys and placeholders are kept identical. API values use this schema:

```json
{
  "version": 2,
  "requires": {
    "platform": { "os": "linux", "distro": "ubuntu" },
    "cpu": { "threads": 8, "min_physical_cores": 4 },
    "memory": { "bytes": 17179869184 },
    "resources": [{ "kind": "gpu", "count": 2, "min_vram_bytes": 8589934592, "same_node": true }]
  },
  "prefers": { "capabilities": { "docker": true } }
}
```

All resources bind to one node. Hard requirements reject incompatible nodes with persisted reason codes. Soft preferences rank eligible nodes and available GPU instances; stable IDs break ties. Capability comparators support exact values and numeric >=, <= and == versions. Physical-core minima describe topology remaining after a conservative thread-reserve equivalence, not OS CPU affinity.

Admission runs matching and request/binding/lease writes in one SQLite transaction. CPU thread and memory-byte amounts share the authoritative resource_leases table with exclusive GPUs/custom resources. RAM also needs recent observed headroom minus a safety margin and current leases. CPU/RAM leases are scheduling reservations; V2 does not enforce cgroups, affinity or hardware memory quotas. Storage is an observed workspace-volume minimum, not a storage allocation.

GPU UUIDs identify hardware; CUDA_VISIBLE_DEVICES uses bound node-local indices. A GPU with compute PIDs or substantial used VRAM is conservatively external-busy and cannot be allocated by default. Desktop utilization alone does not imply compute ownership. Missing or >90-second-old GPU/RAM telemetry fails admission conservatively. Rescans preserve GPU UUID IDs and manual policies. The first detected local GPU materializes the legacy gpu.0 alias without creating a second allocatable GPU.

Every successful request has an immutable binding copied into the execution snapshot. A bound request remains immutable history after completion; requests/bindings API activity is derived from leases or unresolved remote executions, never historical status alone. Waiting requests hold no process. Release, unreserve, better observations and inventory/health changes wake the existing coalesced admission loop. Requires cannot be changed for an active binding. Settings links capacity/GPU leases to Todo, executor/model, PID, timestamps and logs; Stop/ForceStop use process ownership checks.

## Execution transport and recovery

Local launch supplies GPU environment hints. Headless raw-shell executes the supplied command in a native noninteractive shell and exits; interactive raw-shell retains its terminal behavior. SSH Resource Fabric V2 supports headless raw-shell Todos. Remote OpenCode is unsupported in V2; capability probing is retained for future work. Remote interactive sessions, resume, review pipelines and image attachments are rejected. ExecutorPool remains provider/account concurrency admission and is not a hardware pool.

Normal SSH/OpenCode admission fails with `remote_opencode_unsupported_v2` after matching and before worktree/bundle preparation, capability probes or remote launch. The launch-failure path releases acquired resources and the executor reservation; immutable requests/bindings remain inactive history. Direct transport calls enforce the same rejection. Developer-only `AIKOMBINAT_EXPERIMENTAL_REMOTE_OPENCODE=1` permits the future execution path; it defaults OFF, accepts only the exact value `1`, still requires fresh identity/connection-specific compatible CLI capabilities and the exact remote model, and does not make remote OpenCode a supported V2 feature. Provider credentials must be configured independently on the remote host.

Remote launch packages the **committed HEAD** as a Git bundle (16 MiB maximum), clones it to <workspace-root>/jobs/<binding-UUID>/repo and checks out that commit. Local uncommitted changes and external files are not transferred. Output is polled in bounded chunks; artifacts remain in that isolated remote workspace, with no automatic merge/download. Setup does not install dependencies. Avoid histories larger than the bundle limit.

Before launch, preparing ownership is persisted with a placeholder PID and remote binding/workspace. A detached remote supervisor persists Linux PID, /proc start ticks, boot ID and host fingerprint before launching the command. Probe/Stop verify host and process identity before signalling the owned process group. A numeric remote PID is never interpreted as a local PID.

Startup recovery runs before health monitoring/admission. Matching live or unverifiable remote processes retain leases and become recovery-required; confirmed exit releases; a process mismatch clears stale ownership without signalling a bystander. An interrupted pending launch can adopt a verified supervisor identity. Missing supervisor state remains unresolved for explicit investigation. TTL alone never frees unresolved remote ownership. Controller restart does not reattach output streams; safely stop or reconcile retained execution.

Drain/maintenance prevent new admission while preserving running ownership. Disable retains inventory/history. A node with execution history cannot be deleted; disable it instead. Connection edits with active leases are rejected. An alias resolving to a different host fingerprint becomes identity_changed and retains old ownership.

## Persistence and API

[ERD](ERD.md) documents compute_nodes, compute_node_connections, inventory_snapshots, resource_policies, resource_instances, resource_requests, resource_bindings, resource_binding_items, resource_observations, remote_executions and resource_leases. Capacity is derived from node inventory and policy, so a second capacity-pool ledger is unnecessary. Legacy string arrays remain accepted, unknown keys are validated against SQLite, and V1 custom instances materialize idempotently. Sessions keep local-only admission.

The /api/resources namespace offers node CRUD/test/scan/history/policy, GPU policy actions, requests/bindings/leases, matcher preview and owned Todo Stop/ForceStop. It returns connection metadata/key paths, never key bodies or passphrases. Runtime logs redact bounded diagnostics and exclude prompts, bundles and provider output. Opt-in project debug logging retains its existing prompt/raw-output behavior.

## OpenCode shell prerequisite

The installed version audited was OpenCode 1.18.33, tag commit 51ef4be1d3c122f18fefb510dca8d778571f4f18. Its [shell scanner](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/tool/shell.ts) includes redirected-statement text in permission patterns; its [wildcard matcher](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/util/wildcard.ts) interprets '*' broadly, and [permission evaluation](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/permission/index.ts) uses the last matching rule. A broad command prefix is not a shell sandbox.

Managed config now uses exact routine test/build/status/diff commands, trailing deny rules for shell syntax, and a generated local plugin using the documented [tool.execute.before hook](https://opencode.ai/docs/plugins/). Before bash execution it rejects redirection, pipelines, composition, substitution, newlines and NUL in the raw command. Regression tests execute the generated hook and verify normal commands and bypass attempts. Local and remote managed config install the same hook.

Residual risk is explicit: git add/commit and vitest argument patterns remain broad; approved repository scripts, Git hooks, arbitrary file-edit tools and other configuration/plugins can perform filesystem/process actions. This is a guardrail under OpenCode's plugin contract, not OS-enforced isolation, a provider worker contract, or proof against all malicious command encodings. No new billable OpenCode model run was performed for this prerequisite audit.

## Validation

Status: **READY_FOR_ORCHESTRATOR**. See [final closure](Resource_Fabric_V2_Final_Closure_Report.md) and [test guide](TESTING.md). The earlier [acceptance closure](Resource_Fabric_V2_Acceptance_Closure_Report.md) verified real GPU binding/contention/wake and disposable controller restart/Force Stop. Final closure verified reserve-after-current on a freshly scanned, safely free local RTX 5060 Ti: reservation applied before waiter admission, no transient lease, automatic wake after unreserve, completed fixtures and inactive history. External workloads were untouched. Remote OpenCode is outside the V2 contract. Orchestrator Agent V1 remains a separate subsequent task.
