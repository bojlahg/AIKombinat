import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { PassThrough } from 'stream';
import { initDatabase } from '../../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../../test-utils/workspace.js';

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));

const queries = await import('../../db/queries.js');
const { sessionManager, SessionManager } = await import('../session-manager.js');
const { resourceManager } = await import('../resource-manager.js');
const { executorPool } = await import('../executor-pool.js');
const { orchestrator } = await import('../orchestrator.js');
const { claudeManager } = await import('../claude-manager.js');
const { broadcaster } = await import('../../websocket/broadcaster.js');
const { providerQuotaService } = await import('../provider-quota.js');

function createMockCliResult(pid: number, command = 'claude') {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = (code: number) => {
      stdout.end();
      stderr.end();
      resolve(code);
    };
  });
  return { pid, stdout, stderr, stdin: null, exitPromise, resolveExit, command, args: [] };
}

function tick(ms = 40) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Session Manager Stale Liveness Recovery', () => {
  let workspace: TestWorkspace;
  let broadcastEvents: any[] = [];

  beforeEach(() => {
    workspace = createTestWorkspace('session-mgr');
    testDb = new Database(':memory:');
    initDatabase(testDb);
    broadcastEvents = [];
    vi.spyOn(broadcaster, 'broadcast').mockImplementation((event) => {
      broadcastEvents.push(event);
    });
    sessionManager.resetForTesting();
    resourceManager.resetForTesting();
    executorPool.resetReservations();
    executorPool.resetLimits();
    providerQuotaService.resetForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sessionManager.resetForTesting();
    resourceManager.resetForTesting();
    executorPool.resetReservations();
    executorPool.resetLimits();
    providerQuotaService.resetForTesting();
    testDb.close();
    workspace.cleanup();
  });

  it('1. Recovered Session dies after restart: recovers to failed, releases leases, and updates provider usage', async () => {
    const project = queries.createProject('Project', workspace.resolvePath('project-recovered-die'));
    const session = queries.createSession(
      project.id,
      'Recovered Session',
      undefined,
      'claude',
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '["gpu.0"]',
    );
    queries.updateSessionStatus(session.id, 'running');
    queries.updateSession(session.id, { process_pid: 4321 });

    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + 60_000).toISOString();
    testDb.prepare(
      `INSERT INTO resource_leases (id, resource_key, amount, owner_type, owner_id, run_token, acquired_at, heartbeat_at, expires_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`
    ).run('lease-rec-1', 'gpu.0', 'session', session.id, 'recovered-run-token', nowIso, nowIso, expiresIso);

    let pidAlive = true;
    sessionManager.setProcessAliveCheckerForTesting((pid) => pid === 4321 ? pidAlive : false);

    expect(executorPool.getActiveToolUsage('claude')).toBe(1);
    expect(resourceManager.getStatus().find((r) => r.key === 'gpu.0')?.used).toBe(1);

    const recoveredInitial = sessionManager.recoverStaleSessions();
    expect(recoveredInitial).toBe(0);
    expect(queries.getSessionById(session.id)?.status).toBe('running');
    expect(queries.getSessionById(session.id)?.process_pid).toBe(4321);
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);
    expect(resourceManager.getStatus().find((r) => r.key === 'gpu.0')?.used).toBe(1);

    pidAlive = false;

    const recoveredAfterDeath = sessionManager.recoverStaleSessions();
    expect(recoveredAfterDeath).toBe(1);

    const updatedSession = queries.getSessionById(session.id);
    expect(updatedSession?.status).toBe('failed');
    expect(updatedSession?.process_pid).toBe(0);

    expect(executorPool.getActiveToolUsage('claude')).toBe(0);
    expect(resourceManager.getStatus().find((r) => r.key === 'gpu.0')?.used).toBe(0);

    expect(broadcastEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'session:status-changed', sessionId: session.id, status: 'failed' }),
        expect.objectContaining({ type: 'session:log', sessionId: session.id, logType: 'error' }),
      ]),
    );

    const logs = queries.getSessionLogsBySessionId(session.id);
    expect(logs.some((l) => l.message.includes('Process exited unexpectedly'))).toBe(true);
  });

  it('2. Recovered Session stays alive: stale checker does not mutate it and protects resource lease', async () => {
    const project = queries.createProject('Project', workspace.resolvePath('project-recovered-alive'));
    const session = queries.createSession(
      project.id,
      'Live Recovered Session',
      undefined,
      'claude',
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '["gpu.0"]',
    );
    queries.updateSessionStatus(session.id, 'running');
    queries.updateSession(session.id, { process_pid: 4321 });

    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + 60_000).toISOString();
    testDb.prepare(
      `INSERT INTO resource_leases (id, resource_key, amount, owner_type, owner_id, run_token, acquired_at, heartbeat_at, expires_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`
    ).run('lease-rec-2', 'gpu.0', 'session', session.id, 'recovered-run-token-2', nowIso, nowIso, expiresIso);

    sessionManager.setProcessAliveCheckerForTesting((pid) => pid === 4321);

    const recovered = sessionManager.recoverStaleSessions();
    expect(recovered).toBe(0);

    const checkSession = queries.getSessionById(session.id);
    expect(checkSession?.status).toBe('running');
    expect(checkSession?.process_pid).toBe(4321);
    expect(resourceManager.getStatus().find((r) => r.key === 'gpu.0')?.used).toBe(1);
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);
  });

  it('3. Normal locally managed Session: stale checker does not interfere with its normal lifecycle', async () => {
    const project = queries.createProject('Project', workspace.resolvePath('project-local-session'));
    const session = queries.createSession(
      project.id,
      'Local Session',
      undefined,
      'raw-shell',
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '["gpu.0"]',
    );
    const mockCli = createMockCliResult(5001, 'raw-shell');
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValueOnce(mockCli);

    await sessionManager.startSession(session.id);

    expect(queries.getSessionById(session.id)?.status).toBe('running');
    expect(queries.getSessionById(session.id)?.process_pid).toBe(5001);

    sessionManager.setProcessAliveCheckerForTesting(() => false);

    const recovered = sessionManager.recoverStaleSessions();
    expect(recovered).toBe(0);

    expect(queries.getSessionById(session.id)?.status).toBe('running');
    expect(queries.getSessionById(session.id)?.process_pid).toBe(5001);

    mockCli.resolveExit(0);
    await tick();

    expect(queries.getSessionById(session.id)?.status).toBe('completed');
    expect(queries.getSessionById(session.id)?.process_pid).toBe(0);
    expect(resourceManager.getStatus().find((r) => r.key === 'gpu.0')?.used).toBe(0);
  });

  it('4. Stop race: stale checker during graceful kill does not emit failed; resources released after termination', async () => {
    const project = queries.createProject('Project', workspace.resolvePath('project-stop-race'));
    const session = queries.createSession(
      project.id,
      'Stop Race Session',
      undefined,
      'raw-shell',
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '["gpu.0"]',
    );
    const mockCli = createMockCliResult(5002, 'raw-shell');
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValueOnce(mockCli);

    let resolveStop!: (val: boolean) => void;
    const stopPromise = new Promise<boolean>((resolve) => {
      resolveStop = resolve;
    });
    vi.spyOn(claudeManager, 'stopClaude').mockImplementation(() => stopPromise);

    await sessionManager.startSession(session.id);
    expect(resourceManager.getStatus().find((r) => r.key === 'gpu.0')?.used).toBe(1);

    sessionManager.setProcessAliveCheckerForTesting(() => false);

    const stopOperation = sessionManager.stopSession(session.id);

    expect(resourceManager.getStatus().find((r) => r.key === 'gpu.0')?.used).toBe(1);

    const recoveredDuringKill = sessionManager.recoverStaleSessions();
    expect(recoveredDuringKill).toBe(0);

    expect(broadcastEvents.some((e) => e.type === 'session:status-changed' && e.status === 'failed')).toBe(false);
    expect(queries.getSessionById(session.id)?.status).toBe('running');

    resolveStop(true);
    await stopOperation;

    expect(queries.getSessionById(session.id)?.status).toBe('stopped');
    expect(queries.getSessionById(session.id)?.process_pid).toBe(0);
    expect(resourceManager.getStatus().find((r) => r.key === 'gpu.0')?.used).toBe(0);
    expect(broadcastEvents.some((e) => e.type === 'session:status-changed' && e.status === 'stopped')).toBe(true);
  });

  it('5. Executor capacity recovery: dead recovered session frees slot and wakes waiting_executor Todo', async () => {
    const project = queries.createProject('Project', workspace.resolvePath('project-executor-wake'));
    executorPool.setLimit('claude', 1);

    const session = queries.createSession(
      project.id,
      'Blocking Session',
      undefined,
      'claude',
      undefined,
      false,
    );
    queries.updateSessionStatus(session.id, 'running');
    queries.updateSession(session.id, { process_pid: 4321 });

    const waitingTodo = queries.createTodo(
      project.id,
      'Waiting Todo',
      undefined,
      0,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      0,
    );

    const mockTodoCli = createMockCliResult(5003, 'claude');
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValue(mockTodoCli);

    let pidAlive = true;
    sessionManager.setProcessAliveCheckerForTesting((pid) => pid === 4321 ? pidAlive : false);

    await orchestrator.startTodo(waitingTodo.id);
    expect(queries.getTodoById(waitingTodo.id)?.status).toBe('waiting_executor');
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);

    pidAlive = false;

    const recovered = sessionManager.recoverStaleSessions();
    expect(recovered).toBe(1);
    expect(queries.getSessionById(session.id)?.status).toBe('failed');

    await tick(80);

    const wokenTodo = queries.getTodoById(waitingTodo.id);
    expect(wokenTodo?.status).toBe('running');
    expect(wokenTodo?.process_pid).toBe(5003);

    mockTodoCli.resolveExit(0);
    await tick();
  });

  it('recovers persisted running sessions with missing or zero process_pid', async () => {
    const project = queries.createProject('Project', workspace.resolvePath('project-missing-pid'));
    const session = queries.createSession(project.id, 'No PID Session', undefined, 'claude');
    queries.updateSessionStatus(session.id, 'running');
    queries.updateSession(session.id, { process_pid: 0 });

    const recovered = sessionManager.recoverStaleSessions();
    expect(recovered).toBe(1);
    expect(queries.getSessionById(session.id)?.status).toBe('failed');
    expect(queries.getSessionById(session.id)?.process_pid).toBe(0);
  });

  it('starts and stops stale process checker timer without leaks', () => {
    vi.useFakeTimers();
    const recoverSpy = vi.spyOn(sessionManager, 'recoverStaleSessions').mockReturnValue(0);

    sessionManager.startStaleProcessChecker();
    vi.advanceTimersByTime(30_000);
    expect(recoverSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect(recoverSpy).toHaveBeenCalledTimes(2);

    sessionManager.stopStaleProcessChecker();
    vi.advanceTimersByTime(60_000);
    expect(recoverSpy).toHaveBeenCalledTimes(2);
  });
});
