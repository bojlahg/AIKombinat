# AIKombinat 테스트 가이드

## 개요

AIKombinat 프로젝트는 **Vitest**를 테스트 프레임워크로 사용합니다.
백엔드(Node.js/Express)와 프론트엔드(React)를 각각 독립적으로 테스트할 수 있도록 구성되어 있습니다.

- **백엔드 테스트**: 73개 중 52개 (DB 쿼리, 서비스 로직, 미들웨어, WebSocket)
- **프론트엔드 테스트**: 73개 중 21개 (API 클라이언트, 컴포넌트 렌더링, 사용자 인터랙션)

---

## 빠른 시작

Delegation Router V1의 실제 Claude CLI 검증 결과와 재현 가능한 fixture 생성 방법은 [real-world smoke report](Delegation_Router_V1_Real_World_Smoke_Report.md)에 기록되어 있습니다. 이 검증은 mock 테스트를 대체하지 않으며, `npm run typecheck`, `npm test`, `npm run build`를 함께 실행합니다.

### OpenCode Executor V1

The [OpenCode smoke report](OpenCode_Executor_V1_Smoke_Report.md) records real CLI discovery, implementation, review and Stop results. Automated tests block accidental real OpenCode launches and cover migration, catalog preservation, adapter transport, NDJSON decoding, profiles, pool admission and UI selection:

```bash
npx vitest run src/server/services/__tests__/opencode.test.ts src/server/services/__tests__/opencode-status.test.ts src/server/services/__tests__/claude-manager.test.ts src/server/services/__tests__/execution-profiles.test.ts
npm run typecheck
npm test
npm run build
npm run docs:erd:check
git diff --check
```

For an explicit real smoke, use a configured compatible OpenCode CLI and a **new disposable directory** outside any working repository:

```bash
npx tsx scripts/smoke-opencode.ts /path/to/new-opencode-smoke
```

On Windows, use an absolute path such as `D:/Temp/new-opencode-smoke`. The script refuses an existing directory, creates its own fixture Git repository and SQLite database, refreshes real models, selects discovered free Muse (or another discovered free model), runs implementation/review, an invalid-model failure and Stop, and writes `report.json` with exit code 1 on any failed assertion. No paid model is substituted. Provider availability can change; this is a separate real inference check, not part of ordinary unit tests. The fixture is committed locally, never pushed. Rerun using a new directory.

### 전체 테스트 실행
```bash
npm test
```

### 백엔드 테스트만
```bash
npm run test:server
```

### 프론트엔드 테스트만
```bash
npm run test:client
```

### Watch 모드 (백엔드, 파일 변경 시 자동 재실행)
```bash
npm run test:watch
```

### 커버리지 리포트
```bash
npm run test:coverage
```

---

## 테스트 구조

```
src/
├── server/
│   ├── db/__tests__/
│   │   └── queries.test.ts          # DB CRUD 테스트 (in-memory SQLite)
│   ├── services/__tests__/
│   │   ├── worktree-manager.test.ts  # 브랜치명 생성 로직
│   │   ├── claude-manager.test.ts    # 프로세스 관리 로직
│   │   └── log-streamer.test.ts      # 로그 스트리밍/파싱
│   ├── middleware/__tests__/
│   │   └── auth.test.ts              # 인증 미들웨어
│   └── websocket/__tests__/
│       └── broadcaster.test.ts       # WebSocket 브로드캐스트
│
└── client/src/__tests__/
    ├── setup.ts                      # 테스트 환경 설정
    ├── api/
    │   └── client.test.ts            # HTTP 클라이언트 (fetch mock)
    └── components/
        ├── StatusBadge.test.tsx       # 상태 뱃지 렌더링
        └── LoginPage.test.tsx         # 로그인 폼 인터랙션
```

---

## 설정 파일

### 백엔드: `vitest.config.ts` (프로젝트 루트)
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/server/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/server/**/*.ts'],
      exclude: ['src/server/**/*.test.ts', 'src/server/types/**'],
    },
  },
});
```

### 프론트엔드: `src/client/vitest.config.ts`
```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/__tests__/**', 'src/main.tsx'],
    },
  },
});
```

---

## 상세 구현 설명

### 1. 백엔드 DB 테스트 (`queries.test.ts`)

**핵심 전략: In-Memory SQLite**

실제 파일 기반 DB 대신 `better-sqlite3`의 `:memory:` 모드를 사용하여 테스트합니다.
`vi.mock`으로 `connection.js` 모듈을 가로채서, `getDatabase()`가 메모리 DB를 반환하도록 합니다.

```typescript
let testDb: Database.Database;

vi.mock('../connection.js', () => ({
  getDatabase: () => testDb,
}));

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  initDatabase(testDb);  // 스키마 생성
});

afterEach(() => {
  testDb.close();
});
```

각 테스트마다 새 DB를 생성하므로 테스트 간 격리가 완벽합니다.

**테스트 범위:**
- Projects: 생성, 전체조회, ID조회, 업데이트, 삭제, 유니크 제약조건
- Todos: 생성, 조회, 상태변경, 우선순위, 캐스케이드 삭제
- Task Logs: 생성, 조회, 오래된 로그 정리

### 2. WorktreeManager 테스트 (`worktree-manager.test.ts`)

`sanitizeBranchName()` 메서드의 순수 로직을 테스트합니다.
외부 의존성(git) 없이 브랜치명 변환 규칙을 검증합니다.

**테스트 케이스:**
- 영문 제목 -> `feature/fix-login-bug`
- 특수문자 제거
- 한글 -> 해시 기반 변환
- 50자 제한
- 빈 결과 시 `task-{timestamp}` 폴백

### 3. ClaudeManager 테스트 (`claude-manager.test.ts`)

실제 Claude CLI를 실행하지 않고, 프로세스가 없는 상태에서의 경계 조건을 테스트합니다.
- 알 수 없는 PID에 대한 `isRunning` -> false
- 존재하지 않는 프로세스 `stopClaude` -> 정상 resolve
- 프로세스 없을 때 `killAll` -> 정상 resolve

### 4. LogStreamer 테스트 (`log-streamer.test.ts`)

**핵심 전략: EventEmitter Mock**

Node.js의 `EventEmitter`를 사용하여 stdout/stderr 스트림을 모킹합니다.
`queries`와 `broadcaster` 모듈을 `vi.mock`으로 가로챕니다.

```typescript
const mockStdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
```

**테스트 범위:**
- stdout 데이터 -> `output` 타입 로그 저장
- git commit 패턴 감지 -> `commit` 타입 로그 + WebSocket 브로드캐스트
- stderr 데이터 -> `error` 타입 로그
- 불완전한 줄 버퍼링 -> 다음 데이터에서 합쳐서 처리
- 스트림 종료 시 버퍼 플러시
- 빈 줄 무시

### 5. Auth 미들웨어 테스트 (`auth.test.ts`)

Express 미들웨어의 핵심 로직을 순수 함수로 추출하여 테스트합니다.
mock Request/Response 객체를 사용합니다.

**테스트 범위:**
- `/api/auth/*` 경로 인증 스킵
- `/health` 헬스체크 스킵
- 인증된 세션 -> `next()` 호출
- 미인증 -> 401 응답

### 6. Broadcaster 테스트 (`broadcaster.test.ts`)

WebSocket 클라이언트 관리 및 브로드캐스트 로직을 테스트합니다.

**테스트 범위:**
- 클라이언트 추가/제거/카운트
- 열린 연결에만 브로드캐스트
- 닫힌 연결은 건너뛰기

### 7. API Client 테스트 (`client.test.ts`)

**핵심 전략: Global Fetch Mock**

```typescript
const mockFetch = vi.fn();
global.fetch = mockFetch;
```

**테스트 범위:**
- GET/POST/PUT/DELETE 요청 메서드
- credentials: 'include' 설정
- 204 No Content 처리
- 에러 응답 시 `ApiError` throw
- 401 시 `auth:unauthorized` 커스텀 이벤트 발생

### 8. StatusBadge 컴포넌트 테스트 (`StatusBadge.test.tsx`)

`@testing-library/react`를 사용한 렌더링 테스트입니다.

**테스트 범위:**
- 각 상태별 올바른 레이블 렌더링 (IDLE, LIVE, DONE, FAIL, STOP, MRGD)
- `running` 상태에서만 ping 애니메이션 표시

### 9. LoginPage 컴포넌트 테스트 (`LoginPage.test.tsx`)

`@testing-library/user-event`를 사용한 사용자 인터랙션 테스트입니다.

**테스트 범위:**
- 로그인 폼 렌더링
- 빈 비밀번호 -> 버튼 비활성화
- 비밀번호 입력 -> 버튼 활성화
- 제출 시 `onLogin` 콜백 호출
- 로그인 실패 시 에러 메시지 표시
- 로딩 중 "AUTHENTICATING..." 표시

---

## 새 테스트 작성 가이드

### 백엔드 테스트 추가

1. 테스트할 모듈의 `__tests__/` 디렉토리에 `*.test.ts` 파일 생성
2. `vi.mock()`으로 외부 의존성 모킹
3. `describe/it` 블록으로 구조화

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('MyModule', () => {
  it('should do something', () => {
    expect(1 + 1).toBe(2);
  });
});
```

### 프론트엔드 컴포넌트 테스트 추가

1. `src/client/src/__tests__/components/` 에 `*.test.tsx` 파일 생성
2. `render()`, `screen`, `userEvent` 사용

```tsx
import { render, screen } from '@testing-library/react';
import MyComponent from '../../components/MyComponent';

it('should render', () => {
  render(<MyComponent />);
  expect(screen.getByText('Hello')).toBeInTheDocument();
});
```

---

## 사용된 테스트 라이브러리

| 패키지 | 용도 | 위치 |
|--------|------|------|
| `vitest` | 테스트 러너 + assertion | 백엔드 + 프론트엔드 |
| `@vitest/coverage-v8` | 코드 커버리지 | 백엔드 + 프론트엔드 |
| `@testing-library/react` | React 컴포넌트 렌더링/쿼리 | 프론트엔드 |
| `@testing-library/jest-dom` | DOM assertion 확장 (toBeInTheDocument 등) | 프론트엔드 |
| `@testing-library/user-event` | 사용자 이벤트 시뮬레이션 | 프론트엔드 |
| `jsdom` | 브라우저 환경 에뮬레이션 | 프론트엔드 |
| `better-sqlite3` | In-Memory DB (테스트용) | 백엔드 |

---

## npm 스크립트 요약

| 스크립트 | 설명 |
|----------|------|
| `npm test` | 백엔드 + 프론트엔드 전체 테스트 |
| `npm run test:server` | 백엔드만 테스트 |
| `npm run test:client` | 프론트엔드만 테스트 |
| `npm run test:watch` | 백엔드 Watch 모드 |
| `npm run test:coverage` | 전체 커버리지 리포트 생성 |

## Orchestrator Agent V1 validation

Run `npm run typecheck`, `npm test`, `npm run build`, `npm run docs:erd:check` and `git diff --check`. Focused suites: `npx vitest run src/server/orchestration/orchestration.test.ts`; from `src/client`, `npx vitest run src/__tests__/components/OrchestratorPanel.test.tsx`. These use fake primary launches/MCP calls, never real provider executions. They cover durable inbox/retry/batching, terminal-action crash recovery, idempotency, parent/turn capability scope, UTF-8 limits, ANY/parallel children, budgets, Claude-only pool admission, ownership/cancel, V2 migration and same-binding reservation transfer/expiry. The existing core locale parity test covers all added EN/KO/RU keys.

Real acceptance uses **new disposable directories**, a temporary DB, a fixture Git repository, discovered `claude-opus-4-7` (or explicit `ORCHESTRATOR_SMOKE_CLAUDE_MODEL`) and exact free Muse. There is no automatic paid substitute. Place compatible Claude/OpenCode CLIs on PATH first:

```sh
npx tsx scripts/orchestrator-smoke.ts <new-output-dir>
npx tsx scripts/orchestrator-smoke.ts <another-new-output-dir> parallel
npx tsx scripts/orchestrator-restart-smoke.ts <new-restart-dir> before
npx tsx scripts/orchestrator-restart-smoke.ts <same-restart-dir> after
```

The first run verifies real implementation/review/automatic fresh wake, CPU contention, reservation-before-wake, same-binding handoff and human message wake. The parallel run verifies two siblings and a separate integration child. The restart run uses an explicitly synthetic primary and child admission; two independent controller processes use the same SQLite file, preserving one child, one reservation and idempotent operations. The `before` controller exits without normal cleanup at waiting PID zero. Each run retains local JSON audit evidence; reports are not committed wholesale because they contain local paths/provider messages.

Security closure coverage: `src/server/utils/child-environment.test.ts`, `src/server/orchestration/primary.test.ts`, the orchestration suite and `src/server/services/__tests__/claude-manager.test.ts`. Tests use synthetic Node children to check actual environment boundaries, Linux `/proc/self/environ` (Linux-only), override/case protection, runtime/provider inheritance, primary capability propagation/rotation/revocation, persisted state and failure diagnostics. The worst-case context fixture uses 100 children, 64 large events, 12 maximum-size assistant messages, Unicode objective/checkpoint/plan and resource history; it verifies the byte cap, deterministic hash, omission counts and preservation of active work. Overflow events are delivered across successive finish turns. Corrupted oversized mandatory inputs fail explicitly.

The raw-shell regression forces PID identity inspection to wait for native process close, then attaches output listeners. This reproduces the late-subscription race without sleeps or retries. `exitPromise` waits for native close, decoder finalization and the exposed stdout/stderr readable end events. Callers must consume or resume both streams. CI runs 25 Linux iterations; Windows defaults to 3 to keep normal tests short. Run at least 100 locally using `AIKOMBINAT_RAW_SHELL_STRESS_ITERATIONS=100` with the focused test name `preserves headless raw-shell stdout/stderr`. Existing OpenCode split UTF-8/finish and transport failure tests remain required.

For a short real post-fix smoke, run `npx tsx scripts/orchestrator-security-smoke.ts <new-output-dir>`. It uses a temporary SQLite DB, the existing stored Claude login, exact discovered `claude-opus-4-7` (or the explicit model override), one primary turn, checkpoint/finish and PID cleanup. A harmless session canary is set only in that disposable controller; a synthetic child verifies the environment boundary without asking Claude to expose secrets. No child task or hardware reservation is needed.

See [acceptance report](Orchestrator_Agent_V1_Smoke_Report.md). Do not mark acceptance READY solely from unit tests or simulated provider work.

## Resource Fabric V2 validation

Run npm run typecheck, npm test, npm run build and npm run docs:erd:check. Focused server coverage is in resource-fabric.test.ts and startup-process-recovery.test.ts; ResourcesSettingsPanel.test.tsx covers settings, policies, reserves, ownership and requirement editing. Locale parity is included in client tests. Generated OpenCode shell-hook tests use no real AI CLI.

For an authorized isolated Linux SSH CPU fixture, run npx tsx scripts/resource-fabric-smoke.ts <alias> <disposable-root>. The manual smoke uses its own temporary database and committed Git fixture projects, verifies scan/matcher/API ownership/capacity/wake/drain/maintenance/owned Stop, and saves an ignored JSON report. It must not stop outside jobs or consume GPUs with external workloads. See [smoke report and remaining GPU/restart drills](Resource_Fabric_V2_Smoke_Report.md).

### Resource Fabric acceptance closure

Run `npx tsx scripts/resource-fabric-acceptance-smoke.ts <ssh-alias> /home/<user>/resource-acceptance-<new-unique-id>` for authorized disposable GPU/contention/reservation and remote Force Stop/controller-restart drills. Add `final` as the third argument to repeat only the final reservation gate and default remote OpenCode rejection/cleanup. The script refuses broad/existing remote roots, uses a temporary DB and committed Git fixtures, freshly checks ordinary matcher eligibility before admission, never pushes or stops external jobs, and records blockers in ignored `logs/resource-fabric-acceptance.json`. Disposable SQLite triggers record every GPU lease insert/release and policy change; assertions reject transient/double admission and verify zero B acquisitions before unreserve. A checks exact GPU UUID and CUDA_VISIBLE_DEVICES, holds the lease for 18 seconds and writes a small artifact; B automatically wakes after unreserve and completes without Retry. Historical bindings must be inactive.

Remote OpenCode is unsupported in V2; capability probing is retained for future work. The default smoke verifies predictable `remote_opencode_unsupported_v2`, zero processes/leases, inactive history and released executor capacity. A remote AI edit smoke runs only in developer opt-in mode (`AIKOMBINAT_EXPERIMENTAL_REMOTE_OPENCODE=1`) and only for a discovered compatible preferred free Muse model; it is outside V2 supported acceptance. No packages or paid fallback are installed. Tests cover default-OFF rejection before probes/preparation, ON capability/exact-model requirements, optional standalone, fresh cache and identity/connection invalidation, actual launch-failure cleanup, reservation ordering, pending waiter exclusion and unreserve callback admission. A native headless raw-shell regression verifies execution, GPU environment and natural exit without PTY or command text in diagnostic logs. Connection-loss coverage injects observation failure against a real owned job; it changes no system networking. See the [final closure report](Resource_Fabric_V2_Final_Closure_Report.md).


## Provider Accounts V1 validation

Run `npm run typecheck`, `npm test`, `npm run build`, `npm run docs:erd:check` and `git diff --check`. Account service tests cover migration, deterministic policies, simultaneous admission, provider/account caps, retained process ownership, synthetic A/B subprocess isolation and streaming credential redaction. Session and Orchestrator integration tests verify account pinning and fresh-turn selection; client tests cover account settings and lineage.

Real smoke is opt-in and consumes provider quota: after explicit authorization, run `npx tsx scripts/provider-accounts-smoke.ts <disposable-directory>` and `npx tsx scripts/provider-accounts-opencode-smoke.ts <same-directory>`. Use a fresh directory inside the workspace. These scripts use separate databases and Git fixtures; they must not run against a production project or database. The OpenCode child requires a discovered free compatible model. See [recorded versions, results and limitations](Provider_Accounts_V1_Smoke_Report.md).

## Account-aware Quota V2

Run `npx tsx scripts/account-quota-v2-smoke.ts` for disposable account state, migration, real synthetic child processes, workspace preservation, fixed waiting/wake, phase-only retry, exclusions/cap, Stop, restart, Session pinning and Orchestrator mutation idempotency. Run `npm run typecheck`, `npm test`, `npm run build`, `npm run docs:erd:check`, and `git diff --check`. The [smoke report](Account_Aware_Quota_V2_Smoke_Report.md) records tiny authorized real Claude Todo/primary observations; never intentionally consume real quota to prove failure.

## Consensus Review V1 validation

Evaluation Campaigns V1 coverage: `npx vitest run src/server/services/__tests__/evaluation-campaigns.test.ts`; from `src/client`, run `npx vitest run src/__tests__/components/EvaluationCampaigns.test.tsx src/__tests__/i18n/parity.test.ts`. The tests use isolated SQLite fixtures and HTTP routes for weighted golden vectors/distribution, atomic rollback, unchanged implementation settings, enrollment boundaries, lifecycle/caps, definition drift, override/withdrawal, feedback and ITT/PP/coverage/CSV. Browser assignment details also refresh on review-start events.

Run `npx tsx scripts/evaluation-campaign-smoke.ts --migration-source=<existing-smoke.db> --serve` to create a new disposable DB/project and production loopback controller. Omit either optional flag as needed. The script verifies real API enrollment, unchanged implementation and persisted assignment after restart, then installs an explicitly synthetic reached-review fixture for symmetric feedback/UI checks. Migration uses a read-only backup of the supplied source and initializes the copy twice. It does not execute providers. A real AI campaign review requires an independently established safe provider path; simulated outcomes must never be reported as real. See [campaign definitions](Evaluation_Campaigns_V1.md) and [smoke evidence/limits](Evaluation_Campaigns_V1_Smoke_Report.md). Required closure remains `npm run typecheck`, `npm test`, `npm run build`, `npm run docs:erd:check`, `git diff --check` and delivered-commit green CI.

Evaluation coverage: `npx vitest run src/server/services/__tests__/consensus-analytics.test.ts`; from `src/client`, run `npx vitest run src/__tests__/components/ConsensusAnalytics.test.tsx src/__tests__/i18n/parity.test.ts`. These exercise durable derivation, job/attempt/failover separation, counterfactuals, labels, HTTP ownership/privacy, bounds and a 10k-batch temporary fixture. To inspect accepted real history without provider calls or source mutation, run `npx tsx scripts/consensus-evaluation-smoke.ts <existing-smoke.db>`; it uses a read-only backup into a disposable DB. Full closure and final-commit CI remain required. See [evaluation definitions](Consensus_Review_Evaluation_V1.md) and [smoke evidence](Consensus_Review_Evaluation_V1_Smoke_Report.md).

Run `npx vitest run src/server/services/__tests__/consensus-review.test.ts`; from `src/client`, run `npx vitest run src/__tests__/components/ConsensusReview.test.tsx`. These use isolated SQLite/Git fixtures and synthetic provider streams, with real admission services in capacity, quota and resource cases. They cover all 2–7 reviewer verdict masks, deterministic issues, judge/retry, immutable artifacts, read-only launch, Stop/start races, retained ownership, restart, fresh Rework batches and ordinary logical budgets. Complete acceptance also requires `npm run typecheck`, `npm test`, `npm run build`, `npm run docs:erd:check`, `git diff --check` and the pushed commit's green GitHub CI.

For an authorized real AI smoke, run `npx tsx scripts/consensus-review-smoke.ts`. It creates a new disposable directory under the OS temp root, a temporary DB and tiny Git artifact, then launches two Claude haiku reviewers using existing authentication. It consumes provider quota. `--heterogeneous` adds a Codex reviewer using the currently configured Codex model, without changing login/model state. The script reports actual PIDs, persisted results, aggregate completion and artifact mutation checks to local audit JSON, and safely shuts down its owned attempts. Do not use production state or intentionally exhaust quota. See [recorded results and evidence limitations](Consensus_Review_V1_Smoke_Report.md).

## Remote Access Auth V1 regression checks

Run `npm run typecheck`, `npm test`, `npm run build`, `npm run docs:erd:check`, and `git diff --check`.

`src/server/security/request-access.test.ts` covers raw IPv4/IPv6/mapped loopback, LAN/public peers, forwarding/Cloudflare headers, public and malformed Host/Origin, Vite loopback origins and rebinding shapes. `middleware/__tests__/auth.test.ts` exercises the real middleware, local bypass, remote deny, session invalidation and MCP bearer handling. `routes/__tests__/remote-access.test.ts` runs real Express HTTP, SQLite sessions and WS upgrades, including IPv6 sockets, remote setup denial, old-password requirements, rotation/reset invalidation, open-WS revocation, cookie attributes, rate limits and tunnel-manager guards.

Persisted validator tests in `middleware/__tests__/session-store.test.ts` cover valid, missing, expired, corrupt, unauthenticated, stale and missing-password rows, finite numeric timestamps and SQLite read failures. The HTTP/WS integration matrix also covers immediate logout of multiple sockets with the same SID, other-session isolation, failed logout without an event, deleted/expired/corrupt rows, password-hash removal without an event, post-expiry input blocked before dispatch, requester preservation during remote rotation, local rotation of multiple remote sessions, no session touch from WS activity, no local auth lookup and timer/listener cleanup on repeated server shutdown.

Client RemoteAccess tests render RU/KO login/recovery/errors, language switching, the blocked page, local and remote password settings, tunnel CTA and local unauthorized-event behavior. They verify localized tunnel validation and generic operational failures in all three locales. `useWebSocket.test.tsx` covers scheduled reconnect cancellation, late callbacks after logout/unmount/new login and immediate remote auth shutdown while the post-logout status refresh is still pending. Core locale parity, exact-English audit and additional RU/KO mixed-prose audits guard translations with explicit token exemptions and detector fixtures.

For browser smoke, use a disposable empty database and a separate origin fixture: direct localhost must open the app without a session; a proxy that adds forwarding headers must show the blocked page. Configure a fixture password locally, then verify RU remote login, live WS indicator and local recovery instructions. Log out remotely: LoginPage must appear, the connected indicator must disappear and the proxy must observe no further WS upgrades through the reconnect interval. With no password, tunnel startup must remain disabled and its CTA must open local settings. Never use a production DB for this test. See [the recorded matrix](Remote_Access_Auth_V1_Smoke_Report.md).
