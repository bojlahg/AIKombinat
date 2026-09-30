# Resource Fabric V2 final acceptance closure

Conclusion: **READY_FOR_ORCHESTRATOR**.

The remaining real reserve-after-current gate passed. Remote OpenCode's final
production contract is **UNSUPPORTED_IN_V2**; it is a future enhancement, outside
V2 acceptance. Earlier real SSH GPU contention/wake, controller restart,
natural-exit recovery and Force Stop evidence remains in the
[acceptance closure report](Resource_Fabric_V2_Acceptance_Closure_Report.md).
No Orchestrator Agent, child orchestration or new scheduler was implemented.

## Baseline

- Commit: `149793f00b69b2f5730b5cde3718a17f2f2d9f36`, plus the final closure changes.
- Successful run: 2026-09-30, 14:20:36–14:21:18 Asia/Yekaterinburg (UTC+05:00).
- Controller: Windows 10.0.26200 / x86_64, Node.js v22.16.0.
- Local: Ryzen 9 9950X3D, 16 cores / 32 threads, 61.58 GiB RAM; RTX 3070
  (8 GiB) and RTX 5060 Ti (15.93 GiB).
- Authorized SSH alias `dualist`: Ubuntu 24.04 / x86_64, Xeon E5-2699 v3,
  18 cores / 36 threads, 31.17 GiB RAM; two RTX 3070 GPUs (8 GiB each).

Both nodes were freshly scanned through production Resource Fabric, with a
second fresh scan of the selected node immediately before admission. All
application state, policies, audit tables and Git fixture projects used a
disposable temporary database. Existing SSH trust/configuration was used with
BatchMode and strict host-key checking; no trust or host configuration changed.

## GPU selected

| Property | Evidence |
|---|---|
| Node | Local workstation, `03e5bf43-7b70-43e8-92eb-2f913c488439` |
| Model | NVIDIA GeForce RTX 5060 Ti |
| Safe hardware UUID suffix | `89aeee1e` |
| Node-local index | 1 |
| VRAM | 17,103,323,136 bytes / 15.93 GiB |
| Instance | `687eefc2-7814-43af-a4ac-9bf0276152ce` |
| Scan eligibility | No compute PIDs, 0 used VRAM; ordinary production matcher admitted |

Both Todos used the same exact instance requirement, scoped to this node.
The committed Python fixture asserted `CUDA_VISIBLE_DEVICES=1`, queried that
index with `nvidia-smi`, asserted its exact hardware UUID, slept 18 seconds for
A / 5 seconds for B, and wrote `gpu-result.txt`. No GPU computation, ML
framework installation or GPU memory allocation was needed for this scheduler
acceptance drill.

## Reserve-after-current

Todo A: `bdb74231-144a-47c5-9dda-72830f516cbb`, PID **6380**, binding
`0f8ba491-81ff-48de-80d8-6d6593b07b6f`.

Todo B: `e75bbf8c-3a75-4378-849d-646a9d7d1a37`, eventual PID **62728**, binding
`5a6ba2e0-0b8e-455a-aa40-3bdc5afb9978`.

Both bindings were persisted and copied into execution snapshots. The leases
API verified A's exact instance ownership and persisted PID. Reservation and
unreserve used the normal `PUT /api/resources/instances/:id/policy` action.

| Time (Asia/Yekaterinburg) | Event and assertion |
|---|---|
| 14:20:47.382 | A acquired the exclusive GPU lease. Running/PID/binding verified at 14:20:48.045. |
| 14:20:48.078 | B `waiting_resource`, PID 0, zero leases, no partial allocation. |
| 14:20:48.094 | Reserve-after requested while A was still running: `policy=enabled`, `desired_policy=reserved`, A lease active. |
| 14:21:05.674 | A exited 0 after its hold; GPU lease released. |
| 14:21:05.674 | In the same release transaction, desired policy applied: `policy=reserved`, `desired_policy=null`. |
| 14:21:07.246 | After the release/wake and 1.5-second observation interval, B still waiting, PID 0, zero leases. No B acquisition had occurred. |
| 14:21:07.246 | Unreserve persisted `policy=enabled`; the normal availability callback woke admission. |
| 14:21:07.253 | B automatically acquired the same GPU; no manual Retry. |
| 14:21:08.205 | B running with persisted PID 62728 and one GPU lease. |
| 14:21:12.672 | B exited 0 and released its GPU lease. Both historical bindings returned `active=0`. |

## Race evidence

Disposable SQLite AFTER triggers captured **every** selected-GPU lease insert,
delete and policy update, including changes between polling checks. These
triggers only recorded observations; they did not block or alter admission.
The persisted event sequence was:

```text
1 A acquire       enabled / null      leases=1
2 reserve pending enabled / reserved  leases=1
3 A release       enabled / reserved  leases=0
4 reserve applied reserved / null     leases=0
5 unreserve       enabled / null      leases=0
6 B acquire       enabled / null      leases=1
7 B release       enabled / null      leases=0
```

Assertions rejected any acquisition with policy other than enabled, any pending
desired policy, or more than one concurrent GPU lease. Before unreserve, the
audit contained **zero B acquisitions**, so a lease that appeared and disappeared
between polls could not evade verification. Maximum concurrent GPU leases:
**1**. B never leased while desired/policy reserved. Automated regression also
attempts admission inside the release callback and verifies unreserve callback
admission.

## External workloads

Untouched. Fresh scans rejected the local RTX 3070 (compute PIDs, about 2.09 GiB
VRAM use) and both remote RTX 3070 GPUs (external PIDs 195505 / 194230, about
3.28 / 3.42 GiB use). The selected 5060 Ti was free. No external process was
stopped, signalled, displaced or force-reserved. Production projects, policies
and controllers were not modified. Only the first failed disposable fixture
was stopped by the harness after its own identity-verified timeout cleanup.

## Remote OpenCode contract

**UNSUPPORTED_IN_V2**. A fresh read-only remote version probe found OpenCode
absent. No software installation, paid model invocation, model fallback or
remote AI edit/test smoke was attempted. SSH's supported V2 executor is headless
raw-shell. EN/KO/RU UI and current documentation state the unsupported contract.

The normal orchestrator rejects SSH/OpenCode with
`remote_opencode_unsupported_v2` after binding and before worktree/bundle
preparation, capability probes or remote launch. Direct transport calls reject
before inspecting the workspace. A real disposable SSH/OpenCode Todo
`4c2ab4d9-43d4-4a75-bc91-7204e4e6d829` acquired one CPU/RAM allocation and then
failed with that exact reason. Verified afterward:

- PID 0, no remote execution row/process, no leases.
- Historical binding inactive; executor slot released.
- Clear unsupported reason in the Todo's error log.

Developer-only `AIKOMBINAT_EXPERIMENTAL_REMOTE_OPENCODE=1` is default OFF and
does not change the supported V2 contract. ON still requires fresh node-specific
V1-compatible capability and exact-model checks. Probing, conditional
`--standalone`, model presence/absence, cache freshness, and identity/connection
invalidation remain covered for future work.

## Fixes and unsuccessful attempts

The first local attempt exposed that headless raw-shell opened an interactive
PTY and discarded the command. It could not count as acceptance. Headless
raw-shell now passes the command to the native noninteractive shell, inherits
the binding environment, exits naturally and excludes command text from shared
diagnostic logs. Interactive terminal behavior is preserved. A regression
executes a real tiny shell command and verifies the GPU environment and exit.
Native spawn failure now consumes its process error instead of emitting an
unhandled exception.

A second attempt passed reservation ordering and natural A completion, but the
harness checked B's running status before its PID had been persisted. It was
not counted as successful acceptance. The assertion now waits for persisted
PID ownership and B holds for five seconds so startup is observable. The third
freshly scanned run passed every final gate and is the evidence above. A waiter
ordering unit test now explicitly mocks and drains both launches, preventing a
real shell launch after its first mock is exhausted.

## Validation and reproduction

- `npm run typecheck`: passed.
- `npm test`: 1058 server tests passed, one existing skipped; 181 client passed.
- `npm run build`: passed; existing Browserslist and bundle-size warnings remain.
- `npm run docs:erd:check`: passed. Production schema unchanged; no ERD regeneration.
- `git diff --check`: passed.
- GitHub CI: the baseline run was green; the final commit's workflow must be
  independently checked, with its result/run link reported alongside that commit.

```powershell
npx tsx scripts/resource-fabric-acceptance-smoke.ts dualist /home/bojlahg/resource-acceptance-<new-unique-id> final
```

Successful ignored report: `logs/resource-fabric-acceptance.json`. Temporary
evidence root: `C:/Users/bojla/AppData/Local/Temp/aikombinat-resource-acceptance-ZweAq5`;
`smoke.db` retains the immutable history and `smoke_gpu_events` audit. Local Git
fixtures retain their result artifacts. The unused authorized remote root was
`/home/bojlahg/resource-acceptance-20260930-final-closure3`; the unsupported
remote launch was rejected before creating a remote workspace. No recursive
remote cleanup was performed.

## Final conclusion

**READY_FOR_ORCHESTRATOR**. The real reservation gate is closed; remote
OpenCode is explicitly excluded from V2 support. Remaining boundaries are
documented V2 constraints: scheduler-level leases rather than OS/cgroup
enforcement, no remote interactive/resume/review/image execution, and no
controller-restart output reattachment. Next separate task:
**Orchestrator Agent V1**.
