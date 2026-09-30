# Consensus Review V1 acceptance evidence

Recorded on 2026-10-01 (local UTC+05), Windows 11 10.0.26200. Real fixture executions used a new temporary Git repository and SQLite database, the existing CLI login and a one-line `sum(a,b)` correction. Production databases/projects and login state were untouched. Native process launches ran outside the restricted tooling sandbox so the existing login could be read.

## Real majority acceptance — PASS

Run: `npx tsx scripts/consensus-review-smoke.ts`. Claude Code 2.1.246. Policy `Real majority smoke`: majority, require_all, diversity none, two members, weight 1 each, maximum parallel 2. Two distinct CLI executions produced valid ReviewResults and the aggregate completed automatically.

| Reviewer | Execution identity | Attempts | Observed PID | Verdict | Duration / usage |
| --- | --- | --- | --- | --- | --- |
| A | Real Claude reviewer; Claude / Existing CLI Login / haiku / provider-default effort | 1 | 53052 | approved | 9619 ms; input 2, output 385; reported USD 0.137041 |
| B | Real Claude reviewer; Claude / Existing CLI Login / haiku / provider-default effort | 1 | 46904 | approved | 10766 ms; input 2, output 343; reported USD 0.0343996 |

Reviewer C was not configured for this permitted two-reviewer acceptance. Both used inherited account `1e8bea8a-8b61-4bae-9e48-615f2c1fdc15`. Provider-reported token/cost fields are recorded as reported; they are not a complete accounting reconstruction (cached tokens can contribute additional cost).

Batch `f50f74c5-3782-40e9-8421-1eead8062cc1`; logical review round `8466a03e-8405-4c5d-9988-73111b112458`. Both reviewers approved the one-line change from subtraction to addition. Aggregate votes 2–0; weights 2–0; verdict approved; issues empty. Judge not invoked. Todo completed automatically, and both attempt PIDs were cleared after actual exit.

Artifact identity:

```text
baseline/head: 0bdb774a8b64b3c631019cd2a053dc8d2f6b85c4
worktreeStateHash: a838f4c16d61c83727ff082806c8d221ecb88596ec1538c44a87b586d1415ea1
diffHash: 5f050b545e7be0f2227a85d46f907da3c97f15bda2d75a2725a5ce2d37faa49a
changedFiles: sum.js
untrackedFiles: []
truncated: false
evidenceHash: ca79ac43a60a01132b3a7adb9787a2754441c6ce6a24df8620e222248f87ba6c
```

Post-review collection matched the original identity exactly. The immutable uncommitted fixture diff remained unchanged. Local audit JSON: `%TEMP%/aikombinat-consensus-real-sQGo7u/report.json`; prompts/raw output are not copied into this report.

## Heterogeneous real attempt — environment limitation

`--heterogeneous` launched Claude / Claude / Codex using existing logins and the existing configured Codex model. Observed PIDs 26476, 36872, 29036. Both Claude reviewers approved. Codex 0.156.1 reported unknown metadata for configured `gpt-6.1-sol` and exited with code 1; the report's bounded diagnostic does not establish a more precise cause. The require_all batch failed and produced no approval. Audit JSON: `%TEMP%/aikombinat-consensus-real-Mq6SiG/report.json`.

No model configuration, login state or credentials were changed to manufacture diversity. **Real AI consensus verified; heterogeneous diversity synthetic only.** This limitation concerns real heterogeneous acceptance evidence, not the availability of soft diversity selection.

## Automated scenarios — PASS

`src/server/services/__tests__/consensus-review.test.ts` contains 1287 passing cases. The exhaustive decision matrix covers every verdict mask for 2–7 reviewers across all five strategies. Lifecycle fixtures use separate temporary Git/SQLite state and synthetic CLI streams; selected tests use the actual ExecutorPool, quota service and Resource Fabric.

| Scenario | Verified evidence |
| --- | --- |
| A/B/C: majority, unanimous, weighted | Full 2–7 reviewer matrix, conservative ties, failed-vote exclusion. |
| D/E: judge conditional/always | Agreement skip, disagreement invoke, exactly one judge, read-only launch, judge failure and explicit judge retry. |
| F/G: require_all/quorum | Failure/reopen retries only failed job; successful siblings unchanged; quorum waits for all terminals and exact minimum. |
| H/I: quota | Synthetic real-pool account A rejection → B attempt in same job/chain; one vote; fixed-account PID-zero wait and automatic same-account wake. |
| J: concurrency | Actual pool provider/account cap, reservation/PID deduplication; per-batch parallelism; pending work does not consume PID capacity. |
| K: resources | Actual one-thread CPU fixture serializes reviewers; PID-zero waiters resume on release; leases cleared after completion. |
| L: mutation | Changed identity rejects aggregation/approval and safely stops siblings. |
| M/N: Stop | Pending admission canceled; launch/Stop race persists identity before signal; unresolved Stop retains ownership and rejects retry. |
| O/P/Q: restart | Completed votes finalize once; live matching PID retained without duplicate launch; dead attempt failure and same-job retry paths. |
| R: full pipeline | Implementation → consensus needs_changes → ordinary Rework → fresh consensus approved, plus maximum logical review budget. |
| Diversity | Equal-priority alternative provider/account preferred; higher priority and fixed identity preserved. |
| Storage | Idempotent migration, FK integrity, old Single history preserved, policy edits/disable leave live batch snapshots unchanged. |
| Output | Claude stream-json extraction, split UTF-8, output/result bounds, nullable reported telemetry. |
| UI | Policy edit/payload, Single/Consensus Todo choice/common Rework, attempts/identities/dissent/judge/retry and WebSocket-driven DB refresh. |

Single Review, existing retry/parser/read-only provider contracts, account/quota, resource ownership and orchestration regressions run in the complete server suite. Core EN/KO/RU locale parity runs in the complete client suite. Real quota exhaustion, real judge execution, real resource contention and real controller termination were not induced.

## Validation and acceptance status

Required closure commands: `npm run typecheck`, `npm test`, `npm run build`, `npm run docs:erd:check`, `git diff --check`. Final commit CI must pass Type Check, Server Tests, Client Tests, Build and CI Gate. The final response records the pushed commit and its CI run; this report does not claim success from an earlier unrelated commit.

Local closure passed: server 79 files / 2409 tests passed with two pre-existing skipped tests, client 35 files / 192 tests passed, typecheck, production build, ERD freshness and whitespace checks. Final CI acceptance is pending the implementation push. Homogeneous real acceptance is proven; heterogeneous real provider compatibility remains a limitation. The supported V1 boundary is local Claude/Codex/OpenCode read-only review, with remote/Antigravity/raw-shell review excluded.
