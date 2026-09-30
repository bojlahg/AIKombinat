# Resource Fabric V2 acceptance closure

Historical conclusion at this run: **READY_WITH_LIMITATIONS**. Superseded by the
[final closure report](Resource_Fabric_V2_Final_Closure_Report.md): real
reserve-after-current passed and the current V2 status is **READY_FOR_ORCHESTRATOR**.

Real GPU binding, contention and automatic wake passed. Real controller restart,
natural-exit reconciliation and Force Stop passed. Reserve-after-current could
not run safely: an external compute workload appeared on the selected GPU after
the contention test. This gate remains open; do not begin Orchestrator Agent V1.

## Environment and fresh topology

Run: 2026-09-30, 09:34–09:41 Asia/Yekaterinburg. Baseline main:
`9bedf674c457538cbf25789d5aa8815dd597823f`, with this closure's working-tree changes.
Controller: Windows 10.0.26200, Node.js v22.16.0. All application state used
temporary SQLite databases and tiny disposable committed Git fixtures.

| Node | OS / architecture | CPU | RAM | GPU inventory |
|---|---|---|---|---|
| Local | Windows / x86_64 | Ryzen 9 9950X3D, 16 cores / 32 threads | 61.58 GiB | RTX 3070, 8 GiB, UUID suffix 877f03cd, index 0; RTX 5060 Ti, 15.93 GiB, suffix 89aeee1e, index 1 |
| dualist | Ubuntu 24.04 / x86_64 | Xeon E5-2699 v3, 18 cores / 36 threads | 31.17 GiB | RTX 3070, 8 GiB, suffix 921011e4, index 0; RTX 3070, 8 GiB, suffix 2d376dfb, index 1 |

Both nodes were scanned using Resource Fabric, rather than copied from the old
report. Disposable policies began enabled/online, GPUs enabled, no pending
reservation, no application leases. The CPU restart fixture reserved 35 remote
threads, leaving one schedulable thread, and requested 64 MiB RAM. No production
policy was changed.

## Real GPU binding and contention

Selected: **dualist / RTX 3070 / index 0 / UUID suffix 921011e4 / 8 GiB**.
It had no observed compute PID and passed the ordinary matcher at admission.
The scheduler-level fixture checked `CUDA_VISIBLE_DEVICES=0`, queried that exact
index with `nvidia-smi`, asserted its UUID, slept 18 seconds, and wrote
`gpu-result.txt`. No ML framework was installed and no CUDA performance claim
is made.

| Evidence | Result |
|---|---|
| Exact instance | `7fc40fab-f5fd-4e92-b471-55e446838743` |
| A binding | `2d32f8b2-a89d-4d28-9832-b73129becfce` |
| A supervisor PID | 176920; immutable binding copied into execution snapshot |
| Ownership API | Exact GPU instance → Todo A → persisted remote PID verified |
| A active lease | One exclusive GPU lease throughout its running interval |
| B contention | `waiting_resource`, PID 0, no partial lease |
| A completion | Exit 0, Todo completed, lease released at 09:34:57 |
| B automatic wake | Started at 09:34:57 without Retry; supervisor PID 177883 |
| B binding | `c97a3c04-96c4-4fe8-9757-d275c1fe7577`, same exact GPU |
| B completion | Exit 0, Todo completed, released at 09:35:01 |
| Double allocation | Running-interval assertions observed exactly one exclusive lease |
| Historical activity | Both bindings remained historical, API `active=0` after release |

Before the reservation pair, the required fresh scan rejected this GPU. A
subsequent read-only observation showed external PID **177610** on index 0
(1151 MiB used) and on index 1 alongside PID **173941** (3501 MiB used).
No job was stopped or forced off either GPU. Later scans still rejected them.
**Real reserve-after-current, reservation-before-wake and unreserve-wake remain
pending.** Transactional automated ordering coverage passes but does not waive
this real acceptance gate.

## External workloads

Observed only; not modified. Local index 0 reported external compute PIDs and
about 1.85 GiB VRAM use. Local index 1 reported about 10.54 GiB VRAM use, which
the conservative external-busy policy also rejects even without a listed compute
PID. Remote index 1 was externally occupied initially; index 0 became occupied
between the two GPU checks. Application leases were zero for these external
owners. Matcher-based smoke selection excludes compute PIDs and busy VRAM even
if an operator's avoidance policy were disabled.

## Remote OpenCode

Fresh remote `opencode --version` probe: CLI **not installed**. Remote version,
standalone support and exact-model availability are unavailable. No inference,
paid model, fallback model or installation was attempted.

The unconditional `opencodeStandalone: true` in SSH launch was confirmed and
removed. Installed remote CLIs are probed through bounded typed SSH calls:
`--version`, `run --help`, `models --help`, and `models`. Required run flags are
`--format`, `--model`, `--agent`; `--standalone` is included only when remote run
help advertises it. The compatible V1 contract uses the same private headless
stdin/config/shell-guard path documented for local OpenCode. Exact requested
`provider/model` must occur in the remote catalog. Failed discovery is distinct
from `model_unavailable_on_node`; neither changes global quota state.

Results persist in the existing node observation JSON, with observation time
and a fingerprint of node identity/connection, for at most 60 seconds. Rescans
replace observations and invalidate this cache. Connection/identity changes
invalidate it too. Unsupported/missing-model launches fail before bundle or
remote spawn; the normal clean launch-failure path releases acquired leases.
Automated tests exercise both standalone decisions, present/missing exact
models, freshness, cache persistence and connection invalidation.

SSH's accepted executor is raw-shell. The final production contract is
**UNSUPPORTED_IN_V2** for remote OpenCode; capability probing is retained for
future work. EN/KO/RU UI now states this explicitly. Normal admission rejects
before preparation/launch and releases resources and executor capacity. The
developer opt-in defaults OFF and does not count as supported V2 acceptance.

## Controller restart and observation loss

Controller A, a separate disposable process, persisted supervisor PID **186218**,
identity and CPU/RAM leases, then was killed without stopping its remote job.
Controller B opened the same temporary DB and ran startup recovery:

- One owner retained; PID unchanged; both leases retained; recovery required.
- No duplicate remote execution started. A competing Todo waited with PID 0 and
  no partial lease.
- A controlled injected observation failure against this real running job
  returned unverifiable and retained ownership. Restored real SSH observation
  matched the same identity.
- The 30-second remote fixture exited naturally. Passive reconciliation cleared
  the persisted PID, released both leases and automatically woke the waiter,
  which completed.

Controller restart is real. Connection loss is a transport-injection drill over
a real job, not a physical network disconnection. No firewall, SSH daemon,
production controller or system networking was changed. Detached output is not
reattached; existing recovery terminal semantics are preserved.

## Force Stop

Owned disposable remote supervisor PID **185558**:
pre-signal identity matched; an altered creation identity returned `not_owned`
without signalling and the genuine job remained live with both leases. The
ownership API's Force Stop then signalled only the verified owned process group.
Confirmed exit preceded release; `remote_executions=exited`, Todo `stopped`, PID
cleared and both leases released. No outside PID was signalled.

## Historical state, safety and fixes

`resource_requests.status=bound` and bindings are immutable execution history.
Requests/bindings API now explicitly derives numeric `active` (0/1) from active
leases or unresolved remote execution. A historical binding alone means no
ownership. UI occupancy already uses leases, and waiting requests remain
separate. Regression coverage checks live, released and unresolved history.

Detected GPU VRAM now displays two decimal places in GiB, including **15.93
GiB** for the 5060 Ti. Strict byte matching is unchanged; no marketing-size
tolerance was introduced. New strings have identical EN/KO/RU keys/placeholders.

The closure harness refuses broad/destructive remote roots and existing target
roots, uses temporary DBs and disposable Git repositories, never pushes, checks
fresh eligibility before each GPU pair, and only stops its own DB-owned fixtures
after identity verification. It retains fixtures for inspection and performs no
recursive remote deletion. Production projects, policies and workloads remain
untouched. Existing OpenCode shell guard residual risks remain documented; this
is not OS isolation.

The first reservation attempt stopped on external occupancy. An early restart
harness run used an incorrect reconciliation export name; that harness issue
was corrected and the complete lifecycle drill rerun successfully. Neither
failed attempt is counted as reservation or restart success.

## Validation and reproduction

- `npm run typecheck`: passed.
- `npm test`: 1051 server passed, one existing skipped; 181 client passed.
- `npm run build`: passed; existing bundle-size/Browserslist warnings remain.
- `npm run docs:erd:check`: passed; schema unchanged, no regeneration needed.
- `git diff --check`: passed.
- Final pushed CI is not assumed from the baseline's green CI.

```powershell
npx tsx scripts/resource-fabric-acceptance-smoke.ts dualist /home/bojlahg/resource-acceptance-<new-unique-id>
```

Ignored bounded report: `logs/resource-fabric-acceptance.json`; first GPU DB
evidence: `logs/resource-fabric-first-gpu-evidence.json`. Remote fixtures are
under dedicated `resource-acceptance-20260930-closure2` (GPU) and `closure4`
(successful lifecycle) roots. Temporary DBs and runtime logs remain for audit.

The final closure subsequently completed reserve-after-current on a safely free
local GPU and excluded remote OpenCode from V2 support. Next step:
**Orchestrator Agent V1**, in a separate task. The pending statements above
describe this earlier run only; see the final report for current evidence.
