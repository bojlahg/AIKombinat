import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { PassThrough } from 'stream';
import { initDatabase } from '../../db/schema.js';

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));

const queries = await import('../../db/queries.js');
const { ResourceManager, RESOURCE_HEARTBEAT_INTERVAL_MS, resourceManager } = await import('../resource-manager.js');
const { normalizeResourceKeys, parseStoredResourceRequirements, serializeResourceRequirements } = await import('../resource-catalog.js');
const { broadcaster } = await import('../../websocket/broadcaster.js');
const { executorPool } = await import('../executor-pool.js');
const { orchestrator } = await import('../orchestrator.js');
const { sessionManager } = await import('../session-manager.js');
const { claudeManager } = await import('../claude-manager.js');
const { logStreamer } = await import('../log-streamer.js');
const { providerQuotaService } = await import('../provider-quota.js');

function createMockCliResult(pid: number, command = 'raw-shell') {
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

describe('Resource Manager V1', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initDatabase(testDb);
    vi.spyOn(broadcaster, 'broadcast').mockImplementation(() => undefined);
    resourceManager.setAvailabilityCallback(null);
    executorPool.resetReservations();
    executorPool.resetLimits();
    providerQuotaService.resetForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resourceManager.shutdown();
    resourceManager.setAvailabilityCallback(null);
    executorPool.resetReservations();
    executorPool.resetLimits();
    providerQuotaService.resetForTesting();
    testDb.close();
  });

  function owner(title = 'Owner') {
    const project = queries.createProject('Project', `C:/project-${Math.random()}`);
    return queries.createTodo(project.id, title);
  }

  function resourceTodo(projectId: string, title: string, tool = 'raw-shell', useWorktree = 0) {
    return queries.createTodo(
      projectId, title, undefined, 0, tool, undefined, undefined, undefined,
      undefined, useWorktree, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      '["gpu.0"]',
    );
  }

  function tick(ms = 40) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function installResourceWake() {
    resourceManager.setAvailabilityCallback(() => {
      setImmediate(() => { void orchestrator.wakeWaitingResources(); });
    });
  }

  it('acquires exclusively and allows the next run after release', () => {
    const first = owner('A');
    const second = owner('B');
    const manager = new ResourceManager();

    expect(manager.acquireAtomic({ ownerType: 'todo', ownerId: first.id, runToken: 'run-a', resources: ['unity.editor'] }).status).toBe('acquired');
    expect(manager.acquireAtomic({ ownerType: 'todo', ownerId: second.id, runToken: 'run-b', resources: ['unity.editor'] }).status).toBe('busy');
    expect(manager.releaseRun('run-a')).toBe(1);
    expect(manager.acquireAtomic({ ownerType: 'todo', ownerId: second.id, runToken: 'run-b', resources: ['unity.editor'] }).status).toBe('acquired');
  });

  it('does not retain a partial lease when one requested resource is busy', () => {
    const first = owner('A');
    const second = owner('B');
    const third = owner('C');
    const manager = new ResourceManager();
    manager.acquireAtomic({ ownerType: 'todo', ownerId: first.id, runToken: 'run-a', resources: ['gpu.0'] });

    const blocked = manager.acquireAtomic({
      ownerType: 'todo', ownerId: second.id, runToken: 'run-b', resources: ['unity.editor', 'gpu.0'],
    });
    expect(blocked.status).toBe('busy');
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM resource_leases WHERE run_token = ?').get('run-b')).toEqual({ count: 0 });
    expect(manager.acquireAtomic({ ownerType: 'todo', ownerId: third.id, runToken: 'run-c', resources: ['unity.editor'] }).status).toBe('acquired');
  });

  it('scopes idempotent release to the old run token', () => {
    const todo = owner();
    const manager = new ResourceManager();
    manager.acquireAtomic({ ownerType: 'todo', ownerId: todo.id, runToken: 'run-a', resources: ['gpu.0'] });
    manager.releaseRun('run-a');
    manager.acquireAtomic({ ownerType: 'todo', ownerId: todo.id, runToken: 'run-b', resources: ['gpu.0'] });

    expect(manager.releaseRun('run-a')).toBe(0);
    expect(manager.getStatus().find((resource) => resource.key === 'gpu.0')?.leases[0].runToken).toBe('run-b');
  });

  it('normalizes duplicates in catalog order and rejects malformed requirements', () => {
    expect(normalizeResourceKeys(['gpu.0', 'unity.editor', 'gpu.0'])).toEqual(['unity.editor', 'gpu.0']);
    expect(serializeResourceRequirements(['gpu.0', 'gpu.0'])).toBe('["gpu.0"]');
    expect(() => normalizeResourceKeys(['gpu.0', 'definitely.not.real'])).toThrow('Unknown resource key');
    expect(() => normalizeResourceKeys('gpu.0')).toThrow('must be an array');
    expect(() => parseStoredResourceRequirements('{bad json')).toThrow('malformed JSON');
  });

  it('releases an expired dead owner and invokes the availability callback', () => {
    const todo = owner();
    const wake = vi.fn();
    new ResourceManager().acquireAtomic({ ownerType: 'todo', ownerId: todo.id, runToken: 'dead-run', resources: ['cpu.heavy'] });
    const manager = new ResourceManager(() => false);
    manager.setAvailabilityCallback(wake);
    testDb.prepare("UPDATE resource_leases SET expires_at = '2000-01-01T00:00:00.000Z'").run();

    expect(manager.recoverStaleLeases()).toEqual({ released: 1, recovered: 0 });
    expect(wake).toHaveBeenCalledOnce();
    expect(manager.getStatus().find((resource) => resource.key === 'cpu.heavy')?.used).toBe(0);
  });

  it('renews an expired live owner instead of allowing a second owner', () => {
    const first = owner('A');
    const second = owner('B');
    queries.updateTodoStatus(first.id, 'running');
    queries.updateTodo(first.id, { process_pid: 4321 });
    new ResourceManager().acquireAtomic({ ownerType: 'todo', ownerId: first.id, runToken: 'live-run', resources: ['local.llm'] });
    const manager = new ResourceManager((pid) => pid === 4321);
    testDb.prepare("UPDATE resource_leases SET expires_at = '2000-01-01T00:00:00.000Z'").run();

    expect(manager.recoverStaleLeases()).toEqual({ released: 0, recovered: 1 });
    expect(manager.acquireAtomic({ ownerType: 'todo', ownerId: second.id, runToken: 'other-run', resources: ['local.llm'] }).status).toBe('busy');
  });

  it('heartbeats active runs without broadcasting heartbeat updates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));
    const todo = owner();
    queries.updateTodoStatus(todo.id, 'running');
    queries.updateTodo(todo.id, { process_pid: 1234 });
    const manager = new ResourceManager(() => true);
    manager.acquireAtomic({ ownerType: 'todo', ownerId: todo.id, runToken: 'heartbeat-run', resources: ['android.emulator'] });
    const before = manager.getStatus().find((resource) => resource.key === 'android.emulator')!.leases[0].expiresAt;
    vi.mocked(broadcaster.broadcast).mockClear();
    manager.initialize();
    vi.advanceTimersByTime(RESOURCE_HEARTBEAT_INTERVAL_MS);
    const after = manager.getStatus().find((resource) => resource.key === 'android.emulator')!.leases[0].expiresAt;

    expect(after > before).toBe(true);
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
    manager.shutdown();
  });

  it('does not release a locally acquired run before its process PID is persisted', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));
    const todo = owner('Starting locally');
    const manager = new ResourceManager(() => false);
    manager.acquireAtomic({ ownerType: 'todo', ownerId: todo.id, runToken: 'local-startup-run', resources: ['gpu.0'] });
    manager.initialize();

    vi.advanceTimersByTime(RESOURCE_HEARTBEAT_INTERVAL_MS * 5);

    expect(manager.getStatus().find((resource) => resource.key === 'gpu.0')?.leases[0].runToken).toBe('local-startup-run');
    manager.shutdown();
  });

  it('releases a startup-recovered Session when its persisted process dies', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));
    const project = queries.createProject('Project', 'C:/recovered-session');
    const session = queries.createSession(
      project.id, 'Recovered', undefined, 'raw-shell', undefined, false,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      '["gpu.0"]',
    );
    queries.updateSessionStatus(session.id, 'running');
    queries.updateSession(session.id, { process_pid: 4321 });
    const persistingManager = new ResourceManager();
    persistingManager.acquireAtomic({ ownerType: 'session', ownerId: session.id, runToken: 'recovered-session-run', resources: ['gpu.0'] });

    let alive = true;
    const wake = vi.fn();
    const manager = new ResourceManager((pid) => alive && pid === 4321);
    manager.setAvailabilityCallback(wake);
    manager.initialize();

    expect(manager.getStatus().find((resource) => resource.key === 'gpu.0')?.used).toBe(1);
    vi.advanceTimersByTime(RESOURCE_HEARTBEAT_INTERVAL_MS);
    expect(manager.getStatus().find((resource) => resource.key === 'gpu.0')?.used).toBe(1);
    expect(wake).not.toHaveBeenCalled();

    alive = false;
    vi.advanceTimersByTime(RESOURCE_HEARTBEAT_INTERVAL_MS);

    expect(manager.getStatus().find((resource) => resource.key === 'gpu.0')?.used).toBe(0);
    expect(wake).toHaveBeenCalledOnce();
    const next = resourceTodo(project.id, 'Next owner');
    expect(manager.acquireAtomic({ ownerType: 'todo', ownerId: next.id, runToken: 'next-run', resources: ['gpu.0'] }).status).toBe('acquired');
    manager.shutdown();
  });

  it('continues protecting a startup-recovered Todo while its process is live', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));
    const project = queries.createProject('Project', 'C:/recovered-todo');
    const todo = resourceTodo(project.id, 'Recovered Todo');
    queries.updateTodoStatus(todo.id, 'running');
    queries.updateTodo(todo.id, { process_pid: 9876 });
    new ResourceManager().acquireAtomic({ ownerType: 'todo', ownerId: todo.id, runToken: 'recovered-todo-run', resources: ['gpu.0'] });
    const wake = vi.fn();
    const manager = new ResourceManager((pid) => pid === 9876);
    manager.setAvailabilityCallback(wake);
    manager.initialize();

    vi.advanceTimersByTime(RESOURCE_HEARTBEAT_INTERVAL_MS * 3);

    expect(manager.getStatus().find((resource) => resource.key === 'gpu.0')?.leases[0].runToken).toBe('recovered-todo-run');
    expect(wake).not.toHaveBeenCalled();
    manager.shutdown();
  });

  it('moves a blocked Todo to waiting_resource without leaking its provider reservation', async () => {
    const project = queries.createProject('Project', 'C:/resource-todo');
    const holder = queries.createTodo(project.id, 'Holder');
    const waiting = queries.createTodo(
      project.id, 'Waiting', undefined, 0, 'raw-shell', undefined, undefined, undefined,
      undefined, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      '["gpu.0"]',
    );
    resourceManager.acquireAtomic({ ownerType: 'todo', ownerId: holder.id, runToken: 'holder-run', resources: ['gpu.0'] });
    const spawn = vi.spyOn(claudeManager, 'startClaude');

    await orchestrator.startTodo(waiting.id);

    expect(queries.getTodoById(waiting.id)?.status).toBe('waiting_resource');
    expect(executorPool.getReservations()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a busy interactive Session without spawning a PTY or retaining a reservation', async () => {
    const project = queries.createProject('Project', 'C:/resource-session');
    const holder = queries.createTodo(project.id, 'Holder');
    resourceManager.acquireAtomic({ ownerType: 'todo', ownerId: holder.id, runToken: 'holder-run', resources: ['unity.editor'] });
    const session = queries.createSession(
      project.id, 'Interactive', undefined, 'raw-shell', undefined, false,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      '["unity.editor"]',
    );
    const spawn = vi.spyOn(claudeManager, 'startClaude');

    await expect(sessionManager.startSession(session.id)).rejects.toThrow('Required resources are busy: Unity Editor (unity.editor)');
    expect(queries.getSessionById(session.id)?.status).toBe('pending');
    expect(executorPool.getReservations()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('automatically wakes a waiting Todo through normal admission when a resource is released', async () => {
    const project = queries.createProject('Project', 'C:/automatic-resource-wake');
    const holder = resourceTodo(project.id, 'A');
    const waiting = resourceTodo(project.id, 'B');
    const run = createMockCliResult(5001);
    const spawn = vi.spyOn(claudeManager, 'startClaude').mockResolvedValueOnce(run);
    installResourceWake();
    resourceManager.acquireAtomic({ ownerType: 'todo', ownerId: holder.id, runToken: 'holder-run', resources: ['gpu.0'] });

    await orchestrator.startTodo(waiting.id);
    expect(queries.getTodoById(waiting.id)?.status).toBe('waiting_resource');

    resourceManager.releaseRun('holder-run');
    await tick();

    expect(queries.getTodoById(waiting.id)?.status).toBe('running');
    expect(spawn).toHaveBeenCalledOnce();
    expect(resourceManager.getStatus().find((resource) => resource.key === 'gpu.0')?.leases[0].ownerId).toBe(waiting.id);
    run.resolveExit(0);
    await tick();
  });

  it('admits waiting resource Todos deterministically by created_at', async () => {
    const project = queries.createProject('Project', 'C:/ordered-resource-wake');
    const holder = resourceTodo(project.id, 'A');
    const first = resourceTodo(project.id, 'B');
    const second = resourceTodo(project.id, 'C');
    testDb.prepare('UPDATE todos SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', first.id);
    testDb.prepare('UPDATE todos SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:01.000Z', second.id);
    const run = createMockCliResult(5002);
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValueOnce(run);
    installResourceWake();
    resourceManager.acquireAtomic({ ownerType: 'todo', ownerId: holder.id, runToken: 'holder-run', resources: ['gpu.0'] });
    await orchestrator.startTodo(first.id);
    await orchestrator.startTodo(second.id);

    resourceManager.releaseRun('holder-run');
    await tick();

    expect(queries.getTodoById(first.id)?.status).toBe('running');
    expect(queries.getTodoById(second.id)?.status).toBe('waiting_resource');
    expect(resourceManager.getStatus().find((resource) => resource.key === 'gpu.0')?.leases[0].ownerId).toBe(first.id);
    run.resolveExit(0);
    await tick();
  });

  it('does not resurrect a stopped resource waiter after capacity is released', async () => {
    const project = queries.createProject('Project', 'C:/stopped-resource-waiter');
    const holder = resourceTodo(project.id, 'A');
    const waiting = resourceTodo(project.id, 'B');
    const spawn = vi.spyOn(claudeManager, 'startClaude');
    installResourceWake();
    resourceManager.acquireAtomic({ ownerType: 'todo', ownerId: holder.id, runToken: 'holder-run', resources: ['gpu.0'] });
    await orchestrator.startTodo(waiting.id);
    await orchestrator.stopTodo(waiting.id);

    resourceManager.releaseRun('holder-run');
    await tick();

    expect(queries.getTodoById(waiting.id)?.status).toBe('stopped');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('releases a lease after spawn failure so the next waiter starts', async () => {
    const project = queries.createProject('Project', 'C:/resource-spawn-failure');
    const failing = resourceTodo(project.id, 'A');
    const waiting = resourceTodo(project.id, 'B');
    let rejectSpawn!: (error: Error) => void;
    let signalSpawnStarted!: () => void;
    const spawnStarted = new Promise<void>((resolve) => { signalSpawnStarted = resolve; });
    const blockedSpawn = new Promise<never>((_resolve, reject) => { rejectSpawn = reject; });
    const nextRun = createMockCliResult(5003);
    vi.spyOn(claudeManager, 'startClaude')
      .mockImplementationOnce(() => {
        signalSpawnStarted();
        return blockedSpawn;
      })
      .mockResolvedValueOnce(nextRun);
    installResourceWake();

    const failingStart = orchestrator.startTodo(failing.id);
    await spawnStarted;
    queries.updateTodoStatus(waiting.id, 'waiting_resource');
    expect(queries.getTodoById(waiting.id)?.status).toBe('waiting_resource');

    rejectSpawn(new Error('spawn failed'));
    await failingStart;
    await tick();

    expect(queries.getTodoById(failing.id)?.status).toBe('failed');
    expect(queries.getTodoById(waiting.id)?.status).toBe('running');
    expect(resourceManager.getStatus().find((resource) => resource.key === 'gpu.0')?.leases[0].ownerId).toBe(waiting.id);
    nextRun.resolveExit(0);
    await tick();
  });

  it('releases a lease after provider failure while preserving normal failure classification', async () => {
    const project = queries.createProject('Project', 'C:/resource-provider-failure');
    const failing = resourceTodo(project.id, 'A');
    const waiting = resourceTodo(project.id, 'B');
    const firstRun = createMockCliResult(5004);
    const nextRun = createMockCliResult(5005);
    vi.spyOn(claudeManager, 'startClaude')
      .mockResolvedValueOnce(firstRun)
      .mockResolvedValueOnce(nextRun);
    installResourceWake();

    await orchestrator.startTodo(failing.id);
    queries.updateTodoStatus(waiting.id, 'waiting_resource');
    firstRun.resolveExit(7);
    await tick(60);

    expect(queries.getTodoById(failing.id)?.status).toBe('failed');
    expect(providerQuotaService.getQuotaState('raw-shell').state).toBe('unknown');
    expect(queries.getTodoById(waiting.id)?.status).toBe('running');
    expect(resourceManager.getStatus().find((resource) => resource.key === 'gpu.0')?.leases[0].ownerId).toBe(waiting.id);
    nextRun.resolveExit(0);
    await tick();
  });

  it('uses a new run token for context fallback and isolates late cleanup from the restarted run', async () => {
    const claude = queries.addModel('claude', 'claude-3.7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    const project = queries.createProject('Project', 'C:/resource-context-fallback');
    queries.updateProject(project.id, { cli_fallback_chain: JSON.stringify(['claude', 'raw-shell']) });
    const todo = queries.createTodo(
      project.id, 'Context fallback', undefined, 0, 'claude', 'claude-3.7-sonnet', undefined, undefined,
      undefined, 0, undefined, undefined, undefined, undefined, undefined, 'high', claude.id,
      '["gpu.0"]',
    );
    const firstRun = createMockCliResult(5006, 'claude');
    const nextRun = createMockCliResult(5007);
    vi.spyOn(claudeManager, 'startClaude')
      .mockResolvedValueOnce(firstRun)
      .mockResolvedValueOnce(nextRun);
    vi.spyOn(logStreamer, 'isContextExhausted').mockReturnValueOnce(true);

    await orchestrator.startTodo(todo.id);
    const oldToken = resourceManager.getStatus().find((resource) => resource.key === 'gpu.0')!.leases[0].runToken;
    firstRun.resolveExit(1);
    await tick(80);

    const newLease = resourceManager.getStatus().find((resource) => resource.key === 'gpu.0')!.leases[0];
    expect(queries.getTodoById(todo.id)?.status).toBe('running');
    expect(newLease.runToken).not.toBe(oldToken);
    resourceManager.releaseRun(oldToken);
    expect(resourceManager.getStatus().find((resource) => resource.key === 'gpu.0')?.leases[0].runToken).toBe(newLease.runToken);
    nextRun.resolveExit(0);
    await tick();
  });

  it('keeps a newer Session lease when an older run exits late', async () => {
    const project = queries.createProject('Project', 'C:/session-resource-isolation');
    const session = queries.createSession(
      project.id, 'Session', undefined, 'raw-shell', undefined, false,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      '["gpu.0"]',
    );
    const firstRun = createMockCliResult(5008);
    const nextRun = createMockCliResult(5009);
    vi.spyOn(claudeManager, 'startClaude')
      .mockResolvedValueOnce(firstRun)
      .mockResolvedValueOnce(nextRun);
    vi.spyOn(claudeManager, 'stopClaude').mockResolvedValue(true);

    await sessionManager.startSession(session.id);
    const oldToken = resourceManager.getStatus().find((resource) => resource.key === 'gpu.0')!.leases[0].runToken;
    await sessionManager.stopSession(session.id);
    await sessionManager.startSession(session.id);
    const newLease = resourceManager.getStatus().find((resource) => resource.key === 'gpu.0')!.leases[0];
    expect(newLease.runToken).not.toBe(oldToken);

    firstRun.resolveExit(0);
    await tick();

    expect(queries.getSessionById(session.id)?.status).toBe('running');
    expect(resourceManager.getStatus().find((resource) => resource.key === 'gpu.0')?.leases[0].runToken).toBe(newLease.runToken);
    nextRun.resolveExit(0);
    await tick();
  });

  it('hands off waiting_resource to waiting_executor without holding either capacity', async () => {
    const project = queries.createProject('Project', 'C:/resource-to-executor');
    const holder = resourceTodo(project.id, 'A');
    const waiting = resourceTodo(project.id, 'B');
    installResourceWake();
    resourceManager.acquireAtomic({ ownerType: 'todo', ownerId: holder.id, runToken: 'holder-run', resources: ['gpu.0'] });
    await orchestrator.startTodo(waiting.id);
    expect(executorPool.getReservations()).toEqual([]);

    executorPool.setLimit('raw-shell', 0);
    resourceManager.releaseRun('holder-run');
    await tick();

    expect(queries.getTodoById(waiting.id)?.status).toBe('waiting_executor');
    expect(executorPool.getReservations()).toEqual([]);
    expect(resourceManager.getStatus().find((resource) => resource.key === 'gpu.0')?.used).toBe(0);
  });

  it('hands off waiting_executor to waiting_resource without holding either capacity', async () => {
    const project = queries.createProject('Project', 'C:/executor-to-resource');
    const holder = resourceTodo(project.id, 'A');
    const waiting = resourceTodo(project.id, 'B');
    executorPool.setLimit('raw-shell', 0);
    await orchestrator.startTodo(waiting.id);
    expect(queries.getTodoById(waiting.id)?.status).toBe('waiting_executor');
    expect(resourceManager.getStatus().find((resource) => resource.key === 'gpu.0')?.used).toBe(0);

    resourceManager.acquireAtomic({ ownerType: 'todo', ownerId: holder.id, runToken: 'holder-run', resources: ['gpu.0'] });
    executorPool.setLimit('raw-shell', 1);
    await orchestrator.wakeWaitingExecutors();

    expect(queries.getTodoById(waiting.id)?.status).toBe('waiting_resource');
    expect(executorPool.getReservations()).toEqual([]);
    expect(resourceManager.getStatus().find((resource) => resource.key === 'gpu.0')?.leases.some((lease) => lease.ownerId === waiting.id)).toBe(false);
  });
});
