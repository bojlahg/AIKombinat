# Resource Fabric V2 smoke report

Run date: **2026-09-30 05:09 Asia/Yekaterinburg** (2026-09-30 00:09 UTC).
Status: **implemented; acceptance has GPU execution limitations**.
Baseline commit: f048b5e56b40c9b7ddd0b5cb35ac5971e0826c1d plus the Resource Fabric changes in the commit containing this report.
Node.js 22.16.0; Windows 10.0.26200. Tests do not invoke billable AI CLIs.

The later [acceptance closure report](Resource_Fabric_V2_Acceptance_Closure_Report.md) supersedes the GPU contention/restart/Force Stop gaps below. Real GPU reserve-after-current is still pending.

## Hardware actually observed

| Node | Platform | CPU | RAM | GPU inventory |
|---|---|---|---|---|
| Local workstation | Windows, x86_64 | Ryzen 9 9950X3D, 16 physical / 32 logical | 61.58 GiB | RTX 3070 8 GiB; RTX 5060 Ti 15.93 GiB reported by NVIDIA |
| dualist (192.168.1.103) | Ubuntu 24.04, x86_64 | Xeon E5-2699 v3, 18 physical / 36 logical | 31.17 GiB | Two RTX 3070, 8 GiB each |

Local driver: 616.92. Remote driver: 580.178.04, CUDA compatibility 13.0, NVIDIA container runtime 1.20.1. Remote Git 2.43.0, Python 3.12.3 and Docker 29.8.1 were detected. Local Git, Docker, Python, Node, FFmpeg, Unity and nvcc 12.4 were detected. Absence of optional tooling is represented as unknown/absent rather than scan failure.

## Real checks

| Check | Evidence / result |
|---|---|
| A: local discovery/reserves | Local node, CPU topology, RAM, both GPUs and telemetry detected. Disposable DB policy reserves 8 logical threads and 16 GiB RAM, leaving 24 threads and 45.58 GiB before leases/headroom limits. |
| B: GPU policy | Automated transactional tests verify reserve, unreserve, disable and reserve-after-current activation before waiter wake. Own real GPU lease/reservation-under-running-job smoke deferred. |
| C: SSH discovery | System alias dualist resolved to the user-provided address. Strict existing host-key trust, BatchMode, no sudo. Ubuntu and two 8 GiB GPUs detected. |
| D1: RTX 5060 Ti | Local model is present; real matcher rejects admission because external workload occupies it. Model/soft-preference binding and fallback tested with fixtures. |
| D2: Ubuntu + two GPUs >=8 GiB | Remote topology satisfies the requirement; existing workloads on both GPUs block real admission. Windows rejects OS/distro. No external workload was displaced. |
| D3: two GPUs >=16 GiB on one node | No binding; explainable resource-count rejection. The local 5060 Ti reports slightly less than 16 GiB usable VRAM, which strict byte requirements respect. |
| E: capacity/wait/wake | Two disposable projects share a remote one-thread allocatable policy. First acquires CPU + 64 MiB leases; second enters waiting_resource without a PID; releasing first automatically starts and completes second. |
| F: external telemetry/ownership | Existing GPU compute PIDs and VRAM observed separately from application leases. Real /api/resources/leases returns fixture Todo owner, remote PID and node/binding. |
| G: remote execution | Headless raw-shell clones committed fixture bundle to a unique jobs/binding-UUID/repo. Python creates result.txt with RESOURCE_FABRIC_V2_OK; confirmed exit code 0, Todo completed, leases released. Live creation identity verdict match. |
| H: drain/maintenance/Stop | Both states retain the running fixture's two capacity leases. Graceful Stop targets only its verified supervisor process group; own Todo stopped and all leases released. |
| Recovery/PID reuse | Automated startup and transport tests cover remote match/exited/mismatch/unverifiable; no local numeric PID probing/signalling for remote ownership, no mismatch signal, connection loss retains ownership. Actual controller-restart/disconnect and forced-stop drills were not run on the shared server. |

Only a separate temporary local DB and tiny CPU-only fixtures were used. No production projects, app configuration, running external jobs, GPU process, host trust or daemon were changed. The remote root is /home/bojlahg/.aikombinat-resource-smoke-v2. Fixture directories were retained for inspection; no recursive remote cleanup was issued.

## Reproduction and artifacts

```powershell
npx tsx scripts/resource-fabric-smoke.ts dualist /home/bojlahg/.aikombinat-resource-smoke-v2
```

Use a server you are authorized to access and a dedicated disposable root. This command scans both nodes, starts three isolated remote CPU fixtures, stops only its own long-running fixture, and writes logs/resource-fabric-v2-smoke.json. The report contains bounded inventory/observations, decision reasons and boolean checks; connection data is omitted. Logs and the full JSON are ignored local artifacts, not committed secrets. Temporary fixture DB/logs are under the OS temp directory.

The last successful report has waiting_status=waiting_resource, wake_status=completed, owner_api_verified=true, drain_retains_ownership=true, maintenance_retains_ownership=true, own_stop_status=stopped, identity_verdict=match, result=RESOURCE_FABRIC_V2_OK and zero remaining leases.

An earlier fixture variant attempted two main-branch Todos in one project and hit the existing single-project concurrency gate before resource admission; another duplicate-project-path variant was rejected. Those harness issues were corrected with distinct temporary Git projects. One bounded Python fixture from the rejected run completed independently. These were harness setup failures, not claimed successful capacity runs.

## Validation and limitations

Full local tests passed: 1036 server tests plus 179 client tests, with one existing skipped server test. Coverage includes remote startup, numeric PID collisions, priority/FIFO contention and manual capability editing. Typecheck and production client/server build passed; a sandbox-only EPERM writing existing dist files was resolved by running the same build as the ordinary user. ERD generation/check and locale parity are part of validation.

OpenCode 1.18.33 and exact tagged source were audited; generated raw-command plugin regressions reject shell bypass constructs. See [design/security notes](Resource_Fabric_V2.md#opencode-shell-prerequisite) for explicit residual risks. No new paid OpenCode model invocation was used.

This report does **not** claim real GPU contention execution, GPU workload checkpoint/resume, cgroup enforcement, controller-restart recovery on this shared server, remote interactive Sessions, or full OpenCode OS isolation. Real GPU acceptance must be repeated when the owner makes a suitable GPU available; current workloads must remain untouched. Orchestrator Agent V1 should follow acceptance, in a separate task.

GitHub CI is triggered by the final pushed commit; its result is reported in the final chat response rather than fabricated here.
